// backend/routes/login.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// POST /api/login
router.post('/', async (req, res) => {
  const { id, password } = req.body;

  if (!id || !password) {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력하세요.' });
  }

  try {
    // DB의 users.id = 아이디, password = 평문 1234
    const [rows] = await db.query(
      'SELECT id, name, role FROM users WHERE id = ? AND password = ?',
      [id, password]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
    }

    const user = rows[0];

    // 세션에 저장 (student.html의 /api/me 에서 사용)
    req.session.user = {
      id:   user.id,
      name: user.name,
      role: user.role,
    };

    return res.json({
      success: true,
      id:   user.id,
      name: user.name,
      role: user.role,
    });

  } catch (err) {
    console.error('[login] DB 오류:', err.message);
    return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// POST /api/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// GET /api/me — 현재 로그인 유저 확인
router.get('/me', (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }
  res.json(req.session.user);
});

module.exports = router;