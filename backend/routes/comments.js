// backend/routes/comments.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

// ================================================================
// GET /api/comments/:type/:id
// type: 'notice' | 'assignment'
// ================================================================
router.get('/:type/:id', requireLogin, (req, res) => {
  const { type, id } = req.params;
  const table  = type === 'notice' ? 'notice_comments'     : 'assignment_comments';
  const refCol = type === 'notice' ? 'notice_id'           : 'assignment_id';

  db.query(
    `SELECT c.*, u.name AS user_name
     FROM ${table} c
     LEFT JOIN users u ON c.writer = u.id
     WHERE c.${refCol} = ?
     ORDER BY c.created_at ASC`,
    [id],
    (err, rows) => {
      if (err) {
        console.error('[comments] GET 오류:', err.message);
        return res.status(500).json({ message: '서버 오류' });
      }
      res.json({ comments: rows });
    }
  );
});

// ================================================================
// POST /api/comments
// body: { type, ref_id, content }
// ================================================================
router.post('/', requireLogin, (req, res) => {
  const user = req.session.user;
  const { type, ref_id, content } = req.body;

  if (!type || !ref_id || !content) {
    return res.status(400).json({ message: 'type, ref_id, content가 필요합니다.' });
  }

  const table  = type === 'notice' ? 'notice_comments'     : 'assignment_comments';
  const refCol = type === 'notice' ? 'notice_id'           : 'assignment_id';

  db.query(
    `INSERT INTO ${table} (${refCol}, writer, content) VALUES (?, ?, ?)`,
    [ref_id, user.id, content],
    (err, result) => {
      if (err) {
        console.error('[comments] POST 오류:', err.message);
        return res.status(500).json({ message: '서버 오류' });
      }
      res.json({ message: '댓글이 등록되었습니다.', id: result.insertId });
    }
  );
});

// ================================================================
// DELETE /api/comments/:type/:id
// ================================================================
router.delete('/:type/:id', requireLogin, (req, res) => {
  const user   = req.session.user;
  const { type, id } = req.params;
  const table  = type === 'notice' ? 'notice_comments' : 'assignment_comments';

  // 작성자 또는 관리자만 삭제 가능
  db.query(`SELECT writer FROM ${table} WHERE id = ?`, [id], (err, rows) => {
    if (err) return res.status(500).json({ message: '서버 오류' });
    if (!rows.length) return res.status(404).json({ message: '댓글을 찾을 수 없습니다.' });
    if (user.role !== 'admin' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '삭제 권한이 없습니다.' });
    }

    db.query(`DELETE FROM ${table} WHERE id = ?`, [id], (err2) => {
      if (err2) return res.status(500).json({ message: '서버 오류' });
      res.json({ message: '삭제되었습니다.' });
    });
  });
});

module.exports = router;