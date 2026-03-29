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
    const [rows] = await db.query(
      'SELECT id, name, role FROM users WHERE id = ? AND password = ?',
      [id, password]
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
    }

    const user = rows[0];

    // 세션에 저장 — /api/me 에서 사용
    req.session.user = {
      id:   user.id,
      name: user.name,
      role: user.role,
    };

    res.json({ success: true, id: user.id, name: user.name, role: user.role });
  } catch (err) {
    console.error('[login] DB 오류:', err.message);
    res.status(500).json({ success: false, message: 'DB 오류' });
  }
});

module.exports = router;