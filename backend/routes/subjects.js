// backend/routes/subjects.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

const CLASS_SELECT = `
  SELECT cl.id, cl.class_code, cl.teacher,
         s.id AS subject_id, s.name AS subject_name,
         IFNULL(s.category,'일반') AS category,
         CONCAT(s.name,' ',cl.class_code) AS class_label
  FROM classes cl
  JOIN subjects s ON cl.subject_id = s.id
`;

// GET /api/subjects
router.get('/', requireLogin, (req, res) => {
  const user = req.session.user;

  if (user.role === 'student') {
    db.query(
      CLASS_SELECT + ' JOIN enrollments e ON e.class_id = cl.id WHERE e.user_id = ? ORDER BY s.id, cl.class_code',
      [user.id],
      (err, rows) => {
        if (err) return res.status(500).json({ message: '서버 오류' });
        res.json({ subjects: rows });
      }
    );
  } else {
    db.query(CLASS_SELECT + ' ORDER BY s.id, cl.class_code', (err, rows) => {
      if (err) return res.status(500).json({ message: '서버 오류' });
      res.json({ subjects: rows });
    });
  }
});

// GET /api/subjects/my-classes — 반장 담당 분반
router.get('/my-classes', requireLogin, (req, res) => {
  db.query(
    CLASS_SELECT + ' JOIN enrollments e ON e.class_id = cl.id WHERE e.user_id = ? ORDER BY s.id, cl.class_code',
    [req.session.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ message: '서버 오류' });
      res.json({ classes: rows });
    }
  );
});

// GET /api/subjects/all — 관리자용 전체
router.get('/all', requireLogin, (req, res) => {
  db.query('SELECT * FROM subjects ORDER BY id ASC', (err, rows) => {
    if (err) return res.status(500).json({ message: '서버 오류' });
    res.json(rows);
  });
});

// GET /api/subjects/classes/all — 관리자용 전체 분반
router.get('/classes/all', requireLogin, (req, res) => {
  db.query(CLASS_SELECT + ' ORDER BY s.id, cl.class_code', (err, rows) => {
    if (err) return res.status(500).json({ message: '서버 오류' });
    res.json(rows);
  });
});

// POST /api/subjects — 과목/분반 추가 (관리자)
router.post('/', requireLogin, (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  }

  const { name, teacher_name, class_name, leader_username } = req.body;
  if (!name) return res.status(400).json({ message: '과목명은 필수입니다.' });

  // subjects 테이블에 과목 추가 (중복이면 기존 id 사용)
  db.query(
    'SELECT id FROM subjects WHERE name = ?',
    [name],
    (err, existing) => {
      if (err) return res.status(500).json({ message: '서버 오류' });

      const insertClass = (subjId) => {
        if (!class_name) return res.json({ message: '과목이 추가되었습니다.' });

        db.query(
          'INSERT INTO classes (subject_id, class_code, teacher) VALUES (?, ?, ?)',
          [subjId, class_name, teacher_name || null],
          (err2, result) => {
            if (err2) return res.status(500).json({ message: '서버 오류' });

            // 반장 계정이 있으면 enrollments에도 추가
            if (leader_username) {
              db.query(
                'INSERT IGNORE INTO enrollments (user_id, class_id) VALUES (?, ?)',
                [leader_username, result.insertId],
                () => {} // 실패해도 무시
              );
            }
            res.json({ message: '과목/분반이 추가되었습니다.' });
          }
        );
      };

      if (existing.length > 0) {
        insertClass(existing[0].id);
      } else {
        db.query(
          'INSERT INTO subjects (name) VALUES (?)',
          [name],
          (err2, result) => {
            if (err2) return res.status(500).json({ message: '서버 오류' });
            insertClass(result.insertId);
          }
        );
      }
    }
  );
});

// DELETE /api/subjects/:id — 분반 삭제 (관리자)
router.delete('/:id', requireLogin, (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  }

  db.query('DELETE FROM classes WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ message: '서버 오류' });
    res.json({ message: '삭제되었습니다.' });
  });
});

module.exports = router;