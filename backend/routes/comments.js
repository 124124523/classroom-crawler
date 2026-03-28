// backend/routes/comments.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

// ── 테이블 / 컬럼 매핑 ──────────────────────────────
const META = {
  notice: {
    table:   'notice_comments',
    fkCol:   'notice_id',
    refCheck: 'SELECT id FROM notices WHERE id = ?',
  },
  assignment: {
    table:   'assignment_comments',
    fkCol:   'assignment_id',
    refCheck: 'SELECT id FROM assignments WHERE id = ?',
  },
};

// GET /api/comments/:type/:refId
// type = 'notice' | 'assignment'
router.get('/:type/:refId', requireLogin, async (req, res) => {
  const { type, refId } = req.params;
  const meta = META[type];
  if (!meta) return res.status(400).json({ message: '잘못된 타입입니다.' });

  try {
    const [rows] = await db.query(
      `SELECT c.id, c.${meta.fkCol} AS ref_id, c.writer, c.content, c.created_at,
              u.name AS user_name
       FROM ${meta.table} c
       LEFT JOIN users u ON u.id = c.writer
       WHERE c.${meta.fkCol} = ?
       ORDER BY c.created_at ASC`,
      [refId]
    );
    res.json({ comments: rows });
  } catch (err) {
    console.error(`[comments] GET /${type}/${refId} 오류:`, err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/comments
// body: { type, ref_id, content }
router.post('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  const { type, ref_id, content } = req.body;

  if (!type || !ref_id || !content?.trim()) {
    return res.status(400).json({ message: 'type, ref_id, content 필드가 필요합니다.' });
  }

  const meta = META[type];
  if (!meta) return res.status(400).json({ message: '잘못된 타입입니다.' });

  try {
    // 참조 대상 존재 확인
    const [refRows] = await db.query(meta.refCheck, [ref_id]);
    if (!refRows.length) {
      return res.status(404).json({ message: '대상을 찾을 수 없습니다.' });
    }

    const [result] = await db.query(
      `INSERT INTO ${meta.table} (${meta.fkCol}, writer, content) VALUES (?, ?, ?)`,
      [ref_id, user.id, content.trim()]
    );

    res.json({ message: '댓글이 등록되었습니다.', id: result.insertId });
  } catch (err) {
    console.error('[comments] POST 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// DELETE /api/comments/:type/:id
router.delete('/:type/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const { type, id } = req.params;
  const meta = META[type];
  if (!meta) return res.status(400).json({ message: '잘못된 타입입니다.' });

  try {
    const [rows] = await db.query(
      `SELECT writer FROM ${meta.table} WHERE id = ?`, [id]
    );
    if (!rows.length) return res.status(404).json({ message: '댓글을 찾을 수 없습니다.' });
    if (user.role !== 'admin' && user.role !== 'teacher' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '삭제 권한이 없습니다.' });
    }

    await db.query(`DELETE FROM ${meta.table} WHERE id = ?`, [id]);
    res.json({ message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[comments] DELETE 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

module.exports = router;