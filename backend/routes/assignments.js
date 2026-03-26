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

// GET /api/assignments - 내 분반 과제 목록
router.get('/', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  try {
    const [enrollments] = await pool.query(
      'SELECT class_id FROM enrollments WHERE user_id = ?', [userId]
    );
    const classIds = enrollments.map(e => e.class_id);
    if (classIds.length === 0) return res.json([]);

    const [assignments] = await pool.query(`
      SELECT a.id, a.title, a.content, a.deadline, a.class_id,
             a.image_urls, a.gclassroom_id, a.created_at,
             u.name AS writer_name,
             s.name AS subject_name, c.class_code, c.teacher,
             DATEDIFF(a.deadline, CURDATE()) AS days_left
      FROM assignments a
      JOIN users    u ON a.writer   = u.id
      JOIN classes  c ON a.class_id = c.id
      JOIN subjects s ON c.subject_id = s.id
      WHERE a.class_id IN (?)
        AND a.deadline >= DATE_SUB(CURDATE(), INTERVAL 2 MONTH)
      ORDER BY a.deadline ASC
    `, [classIds]);

    res.json(assignments.map(a => ({
      ...a,
      imageUrls: a.image_urls ? JSON.parse(a.image_urls) : [],
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assignments/:id - 과제 상세
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.*, u.name AS writer_name,
             s.name AS subject_name, c.class_code, c.teacher,
             DATEDIFF(a.deadline, CURDATE()) AS days_left
      FROM assignments a
      JOIN users    u ON a.writer   = u.id
      JOIN classes  c ON a.class_id = c.id
      JOIN subjects s ON c.subject_id = s.id
      WHERE a.id = ?
    `, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '없음' });
    const a = rows[0];
    res.json({ ...a, imageUrls: a.image_urls ? JSON.parse(a.image_urls) : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assignments - 과제 등록 (리더/어드민)
router.post('/', requireLogin, requireLeaderOrAdmin, async (req, res) => {
  const writer = req.session.userId;
  const { title, content, classId, deadline, imageUrls } = req.body;
  if (!title || !classId || !deadline)
    return res.status(400).json({ error: 'title, classId, deadline 필요' });

  try {
    const [result] = await pool.query(
      `INSERT INTO assignments (title, content, writer, class_id, deadline, image_urls)
       VALUES (?,?,?,?,?,?)`,
      [title, content || '', writer, classId, deadline,
       imageUrls ? JSON.stringify(imageUrls) : null]
    );
    res.json({ id: result.insertId, message: '과제 등록 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/assignments/:id - 과제 수정 (본인 or 어드민)
router.put('/:id', requireLogin, requireLeaderOrAdmin, async (req, res) => {
  const userId = req.session.userId;
  const role   = req.session.userRole;
  const { title, content, deadline, imageUrls } = req.body;

  try {
    const [rows] = await pool.query('SELECT writer FROM assignments WHERE id=?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '없음' });
    if (rows[0].writer !== userId && role !== 'admin')
      return res.status(403).json({ error: '권한 없음' });

    await pool.query(
      `UPDATE assignments SET title=?, content=?, deadline=?, image_urls=? WHERE id=?`,
      [title, content, deadline,
       imageUrls ? JSON.stringify(imageUrls) : null, req.params.id]
    );
    res.json({ message: '수정 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/assignments/:id - 과제 삭제 (본인 or 어드민)
router.delete('/:id', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const role   = req.session.userRole;
  try {
    const [rows] = await pool.query('SELECT writer FROM assignments WHERE id=?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '없음' });
    if (rows[0].writer !== userId && role !== 'admin')
      return res.status(403).json({ error: '권한 없음' });

    await pool.query('DELETE FROM assignments WHERE id=?', [req.params.id]);
    res.json({ message: '삭제 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;