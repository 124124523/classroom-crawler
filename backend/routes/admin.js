// backend/routes/admin.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const bcrypt  = require('bcrypt');

// 관리자만 접근 가능하게 막는 함수
function requireAdmin(req, res, next) {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  }
  next();
}

// ── 전체 계정 목록 조회 ──────────────────────────────
// GET /api/admin/users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, username, name, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ users: rows });
  } catch (e) {
    console.error('[admin] 계정 조회 오류:', e.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// ── 새 계정 추가 ─────────────────────────────────────
// POST /api/admin/users
router.post('/users', requireAdmin, async (req, res) => {
  const { username, name, role, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: '아이디와 비밀번호는 필수입니다.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      'INSERT INTO users (username, name, role, password) VALUES (?, ?, ?, ?)',
      [username, name || null, role || 'student', hash]
    );
    res.json({ message: '계정이 생성되었습니다.' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: '이미 존재하는 아이디입니다.' });
    }
    console.error('[admin] 계정 추가 오류:', e.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// ── 계정 삭제 ────────────────────────────────────────
// DELETE /api/admin/users/:id
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ message: '삭제되었습니다.' });
  } catch (e) {
    console.error('[admin] 계정 삭제 오류:', e.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// ── 비밀번호 초기화 ──────────────────────────────────
// PUT /api/admin/users/:id/password
router.put('/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: '새 비밀번호를 입력하세요.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password = ? WHERE id = ?', [hash, req.params.id]);
    res.json({ message: '비밀번호가 변경되었습니다.' });
  } catch (e) {
    console.error('[admin] 비밀번호 변경 오류:', e.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

module.exports = router;