const express = require('express');
const router = express.Router();
const pool = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: '로그인 필요' });
  next();
}

// GET /api/subjects - 전체 과목 + 분반 목록
router.get('/', requireLogin, async (req, res) => {
  try {
    const [subjects] = await pool.query(`
      SELECT s.id, s.name, s.category,
             JSON_ARRAYAGG(
               JSON_OBJECT(
                 'classId',   c.id,
                 'classCode', c.class_code,
                 'teacher',   c.teacher
               )
             ) AS classes
      FROM subjects s
      LEFT JOIN classes c ON c.subject_id = s.id
      GROUP BY s.id
      ORDER BY s.category DESC, s.name ASC
    `);
    res.json(subjects.map(s => ({
      ...s,
      classes: s.classes ? JSON.parse(s.classes) : [],
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/subjects/my - 내 수강 과목만
router.get('/my', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  try {
    const [rows] = await pool.query(`
      SELECT s.id AS subject_id, s.name AS subject_name, s.category,
             c.id AS class_id, c.class_code, c.teacher
      FROM enrollments e
      JOIN classes  c ON e.class_id   = c.id
      JOIN subjects s ON c.subject_id = s.id
      WHERE e.user_id = ?
      ORDER BY s.category DESC, s.name ASC
    `, [userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;