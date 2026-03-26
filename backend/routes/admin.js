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
router.get('/users', requireAdmin, (req, res) => {
  db.query(
    // ★ DB의 users 테이블: id=아이디(VARCHAR), name, role, password
    'SELECT id, name, role FROM users ORDER BY role, name ASC',
    (err, rows) => {
      if (err) return res.status(500).json({ message: '서버 오류' });
      res.json({ users: rows });
    }
  );
});

// POST /api/admin/users
router.post('/users', requireAdmin, (req, res) => {
  // 프론트에서 username 필드로 보내지만 DB 컬럼은 id
  const { username, name, role, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: '아이디와 비밀번호는 필수입니다.' });
  }

  db.query(
    // ★ DB 컬럼명 id에 username 값을 저장
    'INSERT INTO users (id, name, role, password) VALUES (?, ?, ?, ?)',
    [username, name || null, role || 'student', password],
    (err) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ message: '이미 존재하는 아이디입니다.' });
        }
        return res.status(500).json({ message: '서버 오류' });
      }
      res.json({ message: '계정이 생성되었습니다.' });
    }
  );
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', requireAdmin, (req, res) => {
  db.query('DELETE FROM users WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ message: '서버 오류' });
    res.json({ message: '삭제되었습니다.' });
  });
});

// PUT /api/admin/users/:id/password
router.put('/users/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ message: '비밀번호를 입력하세요.' });

  db.query(
    'UPDATE users SET password = ? WHERE id = ?',
    [password, req.params.id],
    (err) => {
      if (err) return res.status(500).json({ message: '서버 오류' });
      res.json({ message: '비밀번호가 변경되었습니다.' });
    }
  );
});

module.exports = router;