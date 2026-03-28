// backend/routes/notices.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

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

// GET /api/notices
router.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    let rows;

    if (user.role === 'admin' || user.role === 'teacher') {
      [rows] = await db.query(BASE_SELECT + ' ORDER BY n.created_at DESC');

    } else if (user.role === 'leader' && req.query.mine === 'true') {
      [rows] = await db.query(
        BASE_SELECT + ' WHERE n.writer = ? ORDER BY n.created_at DESC',
        [user.id]
      );

    } else {
      // 학생 — 전체공지(class_id IS NULL) + 내 분반 공지
      [rows] = await db.query(
        BASE_SELECT + `
          WHERE n.class_id IS NULL
             OR n.class_id IN (
               SELECT class_id FROM enrollments WHERE user_id = ?
             )
          ORDER BY n.created_at DESC`,
        [user.id]
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

  const { title, content, class_id, images } = req.body;
  if (!title || !content) return res.status(400).json({ message: '제목과 내용은 필수입니다.' });

  const imagesJson = images?.length ? JSON.stringify(images) : null;

  try {
    await db.query(
      'INSERT INTO notices (title, content, writer, class_id, image_urls) VALUES (?, ?, ?, ?, ?)',
      [title, content, user.id, class_id || null, imagesJson]
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
  const { title, content, class_id, images } = req.body;
  const imagesJson = images?.length ? JSON.stringify(images) : null;

  try {
    const [rows] = await db.query('SELECT writer FROM notices WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: '공지를 찾을 수 없습니다.' });
    if (user.role !== 'admin' && user.role !== 'teacher' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '수정 권한이 없습니다.' });
    }

    await db.query(
      'UPDATE notices SET title=?, content=?, class_id=?, image_urls=? WHERE id=?',
      [title, content, class_id || null, imagesJson, req.params.id]
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