const express = require('express');
const router = express.Router();
const pool = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: '로그인 필요' });
  next();
}

// GET /api/comments/notice/:noticeId
router.get('/notice/:noticeId', requireLogin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.content, c.created_at, c.writer,
             u.name AS writer_name
      FROM notice_comments c
      JOIN users u ON c.writer = u.id
      WHERE c.notice_id = ?
      ORDER BY c.created_at ASC
    `, [req.params.noticeId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/comments/assignment/:assignmentId
router.get('/assignment/:assignmentId', requireLogin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.content, c.created_at, c.writer,
             u.name AS writer_name
      FROM assignment_comments c
      JOIN users u ON c.writer = u.id
      WHERE c.assignment_id = ?
      ORDER BY c.created_at ASC
    `, [req.params.assignmentId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/comments/notice/:noticeId
router.post('/notice/:noticeId', requireLogin, async (req, res) => {
  const writer = req.session.userId;
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content 필요' });

  try {
    const [result] = await pool.query(
      'INSERT INTO notice_comments (notice_id, writer, content) VALUES (?,?,?)',
      [req.params.noticeId, writer, content]
    );
    res.json({ id: result.insertId, message: '댓글 등록 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/comments/assignment/:assignmentId
router.post('/assignment/:assignmentId', requireLogin, async (req, res) => {
  const writer = req.session.userId;
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content 필요' });

  try {
    const [result] = await pool.query(
      'INSERT INTO assignment_comments (assignment_id, writer, content) VALUES (?,?,?)',
      [req.params.assignmentId, writer, content]
    );
    res.json({ id: result.insertId, message: '댓글 등록 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/comments/notice/:id
router.delete('/notice/:id', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const role   = req.session.userRole;
  try {
    const [rows] = await pool.query('SELECT writer FROM notice_comments WHERE id=?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '없음' });
    if (rows[0].writer !== userId && role !== 'admin')
      return res.status(403).json({ error: '권한 없음' });
    await pool.query('DELETE FROM notice_comments WHERE id=?', [req.params.id]);
    res.json({ message: '삭제 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/comments/assignment/:id
router.delete('/assignment/:id', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const role   = req.session.userRole;
  try {
    const [rows] = await pool.query('SELECT writer FROM assignment_comments WHERE id=?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: '없음' });
    if (rows[0].writer !== userId && role !== 'admin')
      return res.status(403).json({ error: '권한 없음' });
    await pool.query('DELETE FROM assignment_comments WHERE id=?', [req.params.id]);
    res.json({ message: '삭제 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;