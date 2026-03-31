// backend/routes/notices.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

// notice_reads 테이블 자동 생성 (최초 1회)
async function ensureNoticeReadsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS notice_reads (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        user_id   VARCHAR(100) NOT NULL,
        notice_id INT NOT NULL,
        read_at   DATETIME DEFAULT NOW(),
        UNIQUE KEY uq_notice_read (user_id, notice_id)
      )
    `);
  } catch {}
}
ensureNoticeReadsTable();

// target_class_num 컬럼 자동 추가 (반 공지용)
(async () => {
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notices' AND COLUMN_NAME = 'target_class_num'`
    );
    if (!cols.length) {
      await db.query('ALTER TABLE notices ADD COLUMN target_class_num VARCHAR(10) DEFAULT NULL');
    }
  } catch {}
})();

function parseImages(rows) {
  return rows.map(row => {
    let images = [];
    if (row.image_urls || row.images) {
      const raw = row.image_urls || row.images;
      try {
        const p = JSON.parse(raw);
        images = Array.isArray(p) ? p : [raw];
      } catch { images = [raw]; }
    }
    return { ...row, images };
  });
}

const BASE_SELECT = `
  SELECT n.*,
    s.name AS subject_name,
    c.class_code, c.teacher,
    IFNULL(CONCAT(s.name,' ',c.class_code),'전체공지') AS class_label
  FROM notices n
  LEFT JOIN classes  c ON n.class_id  = c.id
  LEFT JOIN subjects s ON c.subject_id = s.id
`;

// is_read 포함 SELECT 생성 (user_id 파라미터 필요)
const BASE_SELECT_WITH_READ = `
  SELECT n.*,
    s.name AS subject_name,
    c.class_code, c.teacher,
    IFNULL(CONCAT(s.name,' ',c.class_code),'전체공지') AS class_label,
    CASE WHEN nr.notice_id IS NOT NULL THEN 1 ELSE 0 END AS is_read
  FROM notices n
  LEFT JOIN classes  c  ON n.class_id   = c.id
  LEFT JOIN subjects s  ON c.subject_id = s.id
  LEFT JOIN notice_reads nr ON nr.notice_id = n.id AND nr.user_id = ?
`;

// GET /api/notices/unread-count
router.get('/unread-count', requireLogin, async (req, res) => {
  const user = req.session.user;
  try {
    let rows;
    if (user.role === 'student') {
      [rows] = await db.query(`
        SELECT COUNT(*) AS cnt FROM notices n
        WHERE (n.class_id IS NULL OR n.class_id IN (SELECT class_id FROM enrollments WHERE user_id = ?))
          AND n.id NOT IN (SELECT notice_id FROM notice_reads WHERE user_id = ?)
      `, [user.id, user.id]);
    } else {
      [rows] = await db.query(`
        SELECT COUNT(*) AS cnt FROM notices n
        WHERE n.id NOT IN (SELECT notice_id FROM notice_reads WHERE user_id = ?)
      `, [user.id]);
    }
    res.json({ unread: rows[0].cnt });
  } catch (err) {
    console.error('[notices] GET /unread-count 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/notices/read — 공지 읽음 처리 (DB 영속)
router.post('/read', requireLogin, async (req, res) => {
  const user = req.session.user;
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ message: 'ids 필드가 필요합니다.' });
  }
  try {
    const values = ids.map(id => [user.id, id]);
    await db.query('INSERT IGNORE INTO notice_reads (user_id, notice_id) VALUES ?', [values]);
    res.json({ message: '읽음 처리 완료', count: ids.length });
  } catch (err) {
    console.error('[notices] POST /read 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/notices
router.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    let rows;

    if (user.role === 'admin' || user.role === 'teacher') {
      [rows] = await db.query(
        BASE_SELECT_WITH_READ + ' ORDER BY n.created_at DESC',
        [user.id]
      );

    } else if (user.role === 'leader' && req.query.mine === 'true') {
      [rows] = await db.query(
        BASE_SELECT_WITH_READ + ' WHERE n.writer = ? ORDER BY n.created_at DESC',
        [user.id, user.id]
      );

    } else {
      // 학생/리더 — 전체공지 + 내 분반 공지 + 내 반 공지(target_class_num)
      [rows] = await db.query(
        BASE_SELECT_WITH_READ + `
          WHERE n.class_id IS NULL AND n.target_class_num IS NULL
             OR n.class_id IN (
               SELECT class_id FROM enrollments WHERE user_id = ?
             )
             OR n.target_class_num = (
               SELECT class_num FROM users WHERE id = ?
             )
          ORDER BY n.created_at DESC`,
        [user.id, user.id, user.id]
      );
    }

    res.json({ notices: parseImages(rows) });
  } catch (err) {
    console.error('[notices] GET 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/notices/:id
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(BASE_SELECT + ' WHERE n.id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: '공지를 찾을 수 없습니다.' });
    res.json({ notice: parseImages(rows)[0] });
  } catch (err) {
    console.error('[notices] GET /:id 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/notices
router.post('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'student') return res.status(403).json({ message: '권한 없음' });

  const { title, content, class_id, images, target_class_num } = req.body;
  if (!title || !content) return res.status(400).json({ message: '제목과 내용은 필수입니다.' });

  const imagesJson = images?.length ? JSON.stringify(images) : null;

  try {
    await db.query(
      'INSERT INTO notices (title, content, writer, class_id, image_urls, target_class_num) VALUES (?, ?, ?, ?, ?, ?)',
      [title, content, user.id, class_id || null, imagesJson, target_class_num || null]
    );
    res.json({ message: '공지가 등록되었습니다.' });
  } catch (err) {
    console.error('[notices] POST 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// PUT /api/notices/:id
router.put('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const { title, content, class_id, images, target_class_num } = req.body;
  const imagesJson = images?.length ? JSON.stringify(images) : null;

  try {
    const [rows] = await db.query('SELECT writer FROM notices WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: '공지를 찾을 수 없습니다.' });
    if (user.role !== 'admin' && user.role !== 'teacher' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '수정 권한이 없습니다.' });
    }

    await db.query(
      'UPDATE notices SET title=?, content=?, class_id=?, image_urls=?, target_class_num=? WHERE id=?',
      [title, content, class_id || null, imagesJson, target_class_num || null, req.params.id]
    );
    res.json({ message: '수정되었습니다.' });
  } catch (err) {
    console.error('[notices] PUT 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// DELETE /api/notices/:id
router.delete('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    const [rows] = await db.query('SELECT writer FROM notices WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: '공지를 찾을 수 없습니다.' });
    if (user.role !== 'admin' && user.role !== 'teacher' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '삭제 권한이 없습니다.' });
    }

    await db.query('DELETE FROM notices WHERE id = ?', [req.params.id]);
    res.json({ message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[notices] DELETE 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

module.exports = router;