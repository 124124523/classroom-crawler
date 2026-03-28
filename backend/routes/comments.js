// backend/routes/comments.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

const META = {
  notice: {
    table:    'notice_comments',
    fkCol:    'notice_id',
    refCheck: 'SELECT id FROM notices WHERE id = ?',
  },
  assignment: {
    table:    'assignment_comments',
    fkCol:    'assignment_id',
    refCheck: 'SELECT id FROM assignments WHERE id = ?',
  },
};

// comment_reads 테이블 자동 생성 (최초 1회)
async function ensureReadsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS comment_reads (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    VARCHAR(100) NOT NULL,
        comment_id INT NOT NULL,
        ctype      VARCHAR(20) NOT NULL,
        read_at    DATETIME DEFAULT NOW(),
        UNIQUE KEY uq_read (user_id, comment_id, ctype)
      )
    `);
  } catch {}
}
ensureReadsTable();

// parent_id 컬럼 존재 확인 + 추가
async function ensureParentId(table) {
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'parent_id'`,
      [table]
    );
    if (!cols.length) {
      await db.query(`ALTER TABLE ${table} ADD COLUMN parent_id INT NULL DEFAULT NULL`);
    }
    return true;
  } catch { return false; }
}

// ================================================================
// GET /api/comments/:type/:refId
// ================================================================
router.get('/:type/:refId', requireLogin, async (req, res) => {
  const { type, refId } = req.params;
  const user = req.session.user;
  const meta = META[type];
  if (!meta) return res.status(400).json({ message: '잘못된 타입입니다.' });

  const page  = parseInt(req.query.page  || '1');
  const limit = parseInt(req.query.limit || '0'); // 0 = 전체

  try {
    await ensureParentId(meta.table);

    // 전체 댓글 (트리 구조용)
    const [rows] = await db.query(
      `SELECT c.id, c.${meta.fkCol} AS ref_id, c.writer, c.content, c.created_at,
              IFNULL(c.parent_id, NULL) AS parent_id,
              u.name AS user_name
       FROM ${meta.table} c
       LEFT JOIN users u ON u.id = c.writer
       WHERE c.${meta.fkCol} = ?
       ORDER BY COALESCE(c.parent_id, c.id), c.id ASC`,
      [refId]
    );

    // 내가 읽지 않은 댓글 ID 목록
    let unreadIds = new Set();
    try {
      const readIds = await db.query(
        `SELECT comment_id FROM comment_reads WHERE user_id = ? AND ctype = ?`,
        [user.id, type]
      );
      const readSet = new Set(readIds[0].map(r => r.comment_id));
      rows.forEach(r => { if (!readSet.has(r.id)) unreadIds.add(r.id); });
    } catch {}

    // 미읽음 개수 (내가 쓴 것 제외)
    const unreadCount = rows.filter(r => unreadIds.has(r.id) && r.writer !== user.id).length;

    // 루트 댓글 기준 페이지네이션
    const roots   = rows.filter(r => !r.parent_id);
    const replies = rows.filter(r =>  r.parent_id);

    const totalRoots = roots.length;
    let pagedRoots = roots;
    let hasMore    = false;

    if (limit > 0) {
      const start  = (page - 1) * limit;
      pagedRoots   = roots.slice(start, start + limit);
      hasMore      = start + limit < totalRoots;
    }

    // 페이지된 루트 + 그에 딸린 replies 합치기
    const pagedIds  = new Set(pagedRoots.map(r => r.id));
    const comments  = [
      ...pagedRoots,
      ...replies.filter(r => pagedIds.has(r.parent_id)),
    ].map(r => ({
      ...r,
      is_unread: unreadIds.has(r.id) && r.writer !== user.id,
    }));

    res.json({ comments, unread_count: unreadCount, has_more: hasMore, total: totalRoots });
  } catch (err) {
    console.error(`[comments] GET /${type}/${refId} 오류:`, err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// ================================================================
// GET /api/comments/unread-summary — 미읽음 건수 요약 (뱃지용)
// ================================================================
router.get('/unread-summary', requireLogin, async (req, res) => {
  const user = req.session.user;
  try {
    const result = {};
    for (const [type, meta] of Object.entries(META)) {
      try {
        await ensureParentId(meta.table);
        // 내 분반 과제/공지에 달린 새 댓글 (내가 쓴 것 & 이미 읽은 것 제외)
        const [rows] = await db.query(
          `SELECT COUNT(*) AS cnt
           FROM ${meta.table} c
           WHERE c.writer != ?
             AND c.id NOT IN (
               SELECT comment_id FROM comment_reads WHERE user_id = ? AND ctype = ?
             )`,
          [user.id, user.id, type]
        );
        result[type] = rows[0].cnt;
      } catch { result[type] = 0; }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: '서버 오류' });
  }
});

// ================================================================
// POST /api/comments — 댓글/답글 등록
// ================================================================
router.post('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  const { type, ref_id, content, parent_id } = req.body;

  if (!type || !ref_id || !content?.trim()) {
    return res.status(400).json({ message: 'type, ref_id, content 필드가 필요합니다.' });
  }

  const meta = META[type];
  if (!meta) return res.status(400).json({ message: '잘못된 타입입니다.' });

  try {
    const [refRows] = await db.query(meta.refCheck, [ref_id]);
    if (!refRows.length) return res.status(404).json({ message: '대상을 찾을 수 없습니다.' });

    if (parent_id) {
      const [parentRows] = await db.query(
        `SELECT id FROM ${meta.table} WHERE id = ? AND ${meta.fkCol} = ?`,
        [parent_id, ref_id]
      );
      if (!parentRows.length) return res.status(404).json({ message: '답글 대상 댓글을 찾을 수 없습니다.' });
    }

    const hasParent = await ensureParentId(meta.table);
    let result;
    if (hasParent) {
      [result] = await db.query(
        `INSERT INTO ${meta.table} (${meta.fkCol}, writer, content, parent_id) VALUES (?, ?, ?, ?)`,
        [ref_id, user.id, content.trim(), parent_id || null]
      );
    } else {
      [result] = await db.query(
        `INSERT INTO ${meta.table} (${meta.fkCol}, writer, content) VALUES (?, ?, ?)`,
        [ref_id, user.id, content.trim()]
      );
    }

    // ── 슬라이딩 윈도우: 답글은 부모 댓글당 3개, 루트 댓글은 유저당 5개 ──
    if (parent_id) {
      // 이 부모 댓글에 달린 내 답글이 3개 초과하면 가장 오래된 것 삭제
      const [myReplies] = await db.query(
        `SELECT id FROM ${meta.table}
         WHERE parent_id = ? AND writer = ?
         ORDER BY id ASC`,
        [parent_id, user.id]
      );
      if (myReplies.length > 2) {
        const toDelete = myReplies.slice(0, myReplies.length - 2);
        for (const row of toDelete) {
          await db.query(`DELETE FROM ${meta.table} WHERE id = ?`, [row.id]);
          try { await db.query(`DELETE FROM comment_reads WHERE comment_id = ? AND ctype = ?`, [row.id, type]); } catch {}
        }
      }
    } else {
      // 이 과제에 달린 내 루트 댓글이 5개 초과하면 가장 오래된 것 + 그 답글 삭제
      const [myRoots] = await db.query(
        `SELECT id FROM ${meta.table}
         WHERE ${meta.fkCol} = ? AND writer = ? AND parent_id IS NULL
         ORDER BY id ASC`,
        [ref_id, user.id]
      );
      if (myRoots.length > 5) {
        const toDelete = myRoots.slice(0, myRoots.length - 5);
        for (const row of toDelete) {
          // 답글 먼저 삭제
          try {
            const [orphans] = await db.query(`SELECT id FROM ${meta.table} WHERE parent_id = ?`, [row.id]);
            for (const r of orphans) {
              await db.query(`DELETE FROM ${meta.table} WHERE id = ?`, [r.id]);
              try { await db.query(`DELETE FROM comment_reads WHERE comment_id = ? AND ctype = ?`, [r.id, type]); } catch {}
            }
          } catch {}
          await db.query(`DELETE FROM ${meta.table} WHERE id = ?`, [row.id]);
          try { await db.query(`DELETE FROM comment_reads WHERE comment_id = ? AND ctype = ?`, [row.id, type]); } catch {}
        }
      }
    }

    // 내가 쓴 댓글은 자동 읽음 처리
    try {
      await db.query(
        `INSERT IGNORE INTO comment_reads (user_id, comment_id, ctype) VALUES (?, ?, ?)`,
        [user.id, result.insertId, type]
      );
    } catch {}

    res.json({
      message: parent_id ? '답글이 등록되었습니다.' : '댓글이 등록되었습니다.',
      id: result.insertId,
    });
  } catch (err) {
    console.error('[comments] POST 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// ================================================================
// POST /api/comments/read — 읽음 처리
// body: { type, ids: [댓글id, ...] }
// ================================================================
router.post('/read', requireLogin, async (req, res) => {
  const user = req.session.user;
  const { type, ids } = req.body;
  if (!type || !Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: 'type, ids 필드가 필요합니다.' });
  }
  try {
    const values = ids.map(id => [user.id, id, type]);
    await db.query(
      `INSERT IGNORE INTO comment_reads (user_id, comment_id, ctype) VALUES ?`,
      [values]
    );
    res.json({ message: '읽음 처리 완료', count: ids.length });
  } catch (err) {
    console.error('[comments] POST /read 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// ================================================================
// DELETE /api/comments/:type/:id
// ================================================================
router.delete('/:type/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const { type, id } = req.params;
  const meta = META[type];
  if (!meta) return res.status(400).json({ message: '잘못된 타입입니다.' });

  try {
    const [rows] = await db.query(`SELECT writer FROM ${meta.table} WHERE id = ?`, [id]);
    if (!rows.length) return res.status(404).json({ message: '댓글을 찾을 수 없습니다.' });
    if (user.role !== 'admin' && user.role !== 'teacher' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '삭제 권한이 없습니다.' });
    }

    try {
      await db.query(`DELETE FROM ${meta.table} WHERE id = ? OR parent_id = ?`, [id, id]);
    } catch {
      await db.query(`DELETE FROM ${meta.table} WHERE id = ?`, [id]);
    }
    // 읽음 기록도 정리
    try {
      await db.query(`DELETE FROM comment_reads WHERE comment_id = ? AND ctype = ?`, [id, type]);
    } catch {}

    res.json({ message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[comments] DELETE 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

module.exports = router;