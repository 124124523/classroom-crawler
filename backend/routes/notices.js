const express = require('express');
const router = express.Router();
const pool = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: '로그인 필요' });
  next();
}
function requireLeaderOrAdmin(req, res, next) {
  if (!['admin', 'leader'].includes(req.session?.userRole))
    return res.status(403).json({ error: '권한 없음' });
  next();
}

// GET /api/notices - 공지 목록 (전체 + 내 분반 공지)
router.get('/', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  try {
    // 내가 속한 분반 id 목록
    const [enrollments] = await pool.query(
      'SELECT class_id FROM enrollments WHERE user_id = ?', [userId]
    );
    const classIds = enrollments.map(e => e.class_id);

    const [notices] = await pool.query(`
      SELECT n.id, n.title, n.content, n.writer, n.class_id,
             n.image_urls, n.created_at,
             u.name AS writer_name,
             s.name AS subject_name, c.class_code
      FROM notices n
      JOIN users u ON n.writer = u.id
      LEFT JOIN classes  c ON n.class_id  = c.id
      LEFT JOIN subjects s ON c.subject_id = s.id
      WHERE n.class_id IS NULL
         OR n.class_id IN (${classIds.length ? classIds.map(() => '?').join(',') : 'NULL'})
      ORDER BY n.created_at DESC
    `, classIds);

    res.json(notices.map(n => ({
      ...n,
      imageUrls: n.image_urls ? JSON.parse(n.image_urls) : [],
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notices/:id - 공지 상세
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT n.*, u.name AS writer_name,
             s.name AS subject_name, c.class_code
      FROM notices n
      JOIN users u ON n.writer = u.id
      LEFT JOIN classes  c ON n.class_id  = c.id
      LEFT JOIN subjects s ON c.subject_id = s.id
      WHERE n.id = ?
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '없음' });
    const n = rows[0];
    res.json({ ...n, imageUrls: n.image_urls ? JSON.parse(n.image_urls) : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notices - 공지 작성 (리더/어드민)
router.post('/', requireLogin, requireLeaderOrAdmin, async (req, res) => {
  const writer = req.session.userId;
  const { title, content, classId, imageUrls } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title, content 필요' });

  try {
    const [result] = await pool.query(
      `INSERT INTO notices (title, content, writer, class_id, image_urls)
       VALUES (?,?,?,?,?)`,
      [title, content, writer, classId || null,
       imageUrls ? JSON.stringify(imageUrls) : null]
    );
    res.json({ id: result.insertId, message: '공지 등록 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notices/:id - 공지 삭제 (본인 or 어드민)
router.delete('/:id', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const role   = req.session.userRole;
  try {
    const [rows] = await pool.query('SELECT writer FROM notices WHERE id=?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '없음' });
    if (rows[0].writer !== userId && role !== 'admin')
      return res.status(403).json({ error: '권한 없음' });

    await pool.query('DELETE FROM notices WHERE id=?', [req.params.id]);
    res.json({ message: '삭제 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;