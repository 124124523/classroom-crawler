const express = require('express');
const router = express.Router();
const pool = require('../db');

// POST /api/login
router.post('/', async (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.status(400).json({ error: 'id, password 필요' });

  try {
    const [rows] = await pool.query(
      'SELECT id, name, role FROM users WHERE id = ? AND password = ?',
      [id, password]
    );
    if (rows.length === 0) return res.status(401).json({ error: '아이디 또는 비밀번호 오류' });

    req.session.userId   = rows[0].id;
    req.session.userName = rows[0].name;
    req.session.userRole = rows[0].role;

    res.json({ id: rows[0].id, name: rows[0].name, role: rows[0].role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: '로그아웃 완료' });
});

// GET /api/me
router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: '로그인 필요' });
  res.json({
    id:   req.session.userId,
    name: req.session.userName,
    role: req.session.userRole,
  });
});

module.exports = router;