// backend/routes/assignments.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

function parseImages(rows) {
  return rows.map(row => {
    let images = [];
    const raw = row.image_urls || row.images;
    if (raw) {
      try { const p = JSON.parse(raw); images = Array.isArray(p) ? p : [raw]; }
      catch { images = [raw]; }
    }
    return { ...row, images };
  });
}

// ★ deadline→due_date, content→description, category→type 으로 alias
// 프론트엔드(student.html, leader.html)가 이 필드명으로 읽음
const BASE_SELECT = `
  SELECT
    a.id,
    a.title,
    a.content       AS description,
    a.writer,
    a.class_id,
    a.deadline      AS due_date,
    a.image_urls,
    a.gclassroom_id,
    a.created_at,
    s.name          AS subject_name,
    s.category      AS type,
    c.class_code,
    c.teacher,
    CONCAT(s.name,' ',c.class_code) AS class_label,
    IF(a.writer='classroom_bot',1,0) AS is_crawled
  FROM assignments a
  JOIN classes  c ON a.class_id  = c.id
  JOIN subjects s ON c.subject_id = s.id
`;

// GET /api/assignments
router.get('/', requireLogin, (req, res) => {
  const user = req.session.user;
  let sql, params;

  if (user.role === 'admin') {
    sql    = BASE_SELECT + ' ORDER BY a.deadline ASC';
    params = [];

  } else if (user.role === 'leader' && req.query.mine === 'true') {
    sql = BASE_SELECT + `
      WHERE a.class_id IN (SELECT class_id FROM enrollments WHERE user_id = ?)
      ORDER BY a.deadline ASC`;
    params = [user.id];

  } else {
    // 학생 — 수강 분반 과제 + 완료 여부
    sql = `
      SELECT
        a.id,
        a.title,
        a.content       AS description,
        a.writer,
        a.class_id,
        a.deadline      AS due_date,
        a.image_urls,
        a.gclassroom_id,
        a.created_at,
        s.name          AS subject_name,
        s.category      AS type,
        c.class_code,
        c.teacher,
        CONCAT(s.name,' ',c.class_code) AS class_label,
        IF(a.writer='classroom_bot',1,0) AS is_crawled,
        CASE WHEN cp.id IS NOT NULL THEN 1 ELSE 0 END AS completed
      FROM assignments a
      JOIN classes     c  ON a.class_id  = c.id
      JOIN subjects    s  ON c.subject_id = s.id
      JOIN enrollments e  ON e.class_id  = a.class_id AND e.user_id = ?
      LEFT JOIN completions cp
        ON cp.user_id    = ?
        AND cp.target_type = 'assignment'
        AND cp.target_id   = CAST(a.id AS CHAR)
      ORDER BY a.deadline ASC`;
    params = [user.id, user.id];
  }

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error('[assignments] GET 오류:', err.message);
      return res.status(500).json({ message: '서버 오류' });
    }
    res.json({ assignments: parseImages(rows) });
  });
});

// GET /api/assignments/:id
router.get('/:id', requireLogin, (req, res) => {
  db.query(
    BASE_SELECT + ' WHERE a.id = ?',
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: '서버 오류' });
      if (!rows.length) return res.status(404).json({ message: '과제를 찾을 수 없습니다.' });
      res.json({ assignment: parseImages(rows)[0] });
    }
  );
});

// POST /api/assignments
router.post('/', requireLogin, (req, res) => {
  const user = req.session.user;
  if (user.role === 'student') return res.status(403).json({ message: '권한 없음' });

  // ★ 프론트에서 due_date, description으로 보냄 → DB 컬럼 deadline, content로 저장
  const { title, description, class_id, type, due_date, images } = req.body;
  if (!title || !class_id) return res.status(400).json({ message: '제목과 분반은 필수입니다.' });

  const imagesJson = images?.length ? JSON.stringify(images) : null;

  db.query(
    'INSERT INTO assignments (title, content, writer, class_id, deadline, image_urls) VALUES (?, ?, ?, ?, ?, ?)',
    [title, description || '', user.id, class_id, due_date || null, imagesJson],
    (err, result) => {
      if (err) {
        console.error('[assignments] POST 오류:', err.message);
        return res.status(500).json({ message: '서버 오류' });
      }
      res.json({ message: '과제가 등록되었습니다.', id: result.insertId });
    }
  );
});

// PUT /api/assignments/:id
router.put('/:id', requireLogin, (req, res) => {
  const user = req.session.user;
  const { title, description, due_date, images } = req.body;
  const imagesJson = images?.length ? JSON.stringify(images) : null;

  db.query('SELECT writer FROM assignments WHERE id = ?', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ message: '서버 오류' });
    if (!rows.length) return res.status(404).json({ message: '과제를 찾을 수 없습니다.' });
    if (rows[0].writer === 'classroom_bot') {
      return res.status(403).json({ message: '크롤러 자동 등록 항목은 수정할 수 없습니다.' });
    }
    if (user.role !== 'admin' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '수정 권한이 없습니다.' });
    }

    db.query(
      'UPDATE assignments SET title=?, content=?, deadline=?, image_urls=? WHERE id=?',
      [title, description || '', due_date || null, imagesJson, req.params.id],
      (err2) => {
        if (err2) return res.status(500).json({ message: '서버 오류' });
        res.json({ message: '수정되었습니다.' });
      }
    );
  });
});

// DELETE /api/assignments/:id
router.delete('/:id', requireLogin, (req, res) => {
  const user = req.session.user;

  db.query('SELECT writer FROM assignments WHERE id = ?', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ message: '서버 오류' });
    if (!rows.length) return res.status(404).json({ message: '과제를 찾을 수 없습니다.' });
    if (user.role !== 'admin' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '삭제 권한이 없습니다.' });
    }

    db.query('DELETE FROM assignments WHERE id = ?', [req.params.id], (err2) => {
      if (err2) return res.status(500).json({ message: '서버 오류' });
      res.json({ message: '삭제되었습니다.' });
    });
  });
});

module.exports = router;