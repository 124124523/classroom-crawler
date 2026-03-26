// backend/routes/admin.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireAdmin(req, res, next) {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  }
  next();
}

// GET /api/admin/users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, role FROM users ORDER BY role, name ASC'
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('[admin] GET /users 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/admin/users
router.post('/users', requireAdmin, async (req, res) => {
  // 프론트에서 username 필드로 보내지만 DB 컬럼은 id
  const { username, name, role, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: '아이디와 비밀번호는 필수입니다.' });
  }

  try {
    await db.query(
      'INSERT INTO users (id, name, role, password) VALUES (?, ?, ?, ?)',
      [username, name || null, role || 'student', password]
    );
    res.json({ message: '계정이 생성되었습니다.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: '이미 존재하는 아이디입니다.' });
    }
    console.error('[admin] POST /users 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[admin] DELETE /users 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// PUT /api/admin/users/:id/password
router.put('/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ message: '비밀번호를 입력하세요.' });

  try {
    await db.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [password, req.params.id]
    );
    res.json({ message: '비밀번호가 변경되었습니다.' });
  } catch (err) {
    console.error('[admin] PUT /users/password 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

module.exports = router;