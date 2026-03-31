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
// 김규래 
// GET /api/subjects
router.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    let rows;
    if (user.role === 'student') {
      [rows] = await db.query(
        CLASS_SELECT + ' JOIN enrollments e ON e.class_id = cl.id WHERE e.user_id = ? ORDER BY s.id, cl.class_code',
        [user.id]
      );
    } else {
      [rows] = await db.query(CLASS_SELECT + ' ORDER BY s.id, cl.class_code');
    }
    res.json({ subjects: rows });
  } catch (err) {
    console.error('[subjects] GET 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/subjects/my-classes — 반장 담당 분반
router.get('/my-classes', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(
      CLASS_SELECT + ' JOIN enrollments e ON e.class_id = cl.id WHERE e.user_id = ? ORDER BY s.id, cl.class_code',
      [req.session.user.id]
    );
    res.json({ classes: rows });
  } catch (err) {
    console.error('[subjects] GET /my-classes 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/subjects/all — 관리자용 전체 과목
router.get('/all', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM subjects ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    console.error('[subjects] GET /all 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/subjects/classes/all — 관리자용 전체 분반
router.get('/classes/all', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(CLASS_SELECT + ' ORDER BY s.id, cl.class_code');
    res.json(rows);
  } catch (err) {
    console.error('[subjects] GET /classes/all 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/subjects — 과목/분반 추가 (관리자)
router.post('/', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  }

  const { name, teacher_name, class_name, leader_username } = req.body;
  if (!name) return res.status(400).json({ message: '과목명은 필수입니다.' });

  try {
    // 과목 중복 확인
    const [existing] = await db.query('SELECT id FROM subjects WHERE name = ?', [name]);

    let subjId;
    if (existing.length > 0) {
      subjId = existing[0].id;
    } else {
      const [result] = await db.query('INSERT INTO subjects (name) VALUES (?)', [name]);
      subjId = result.insertId;
    }

    if (!class_name) {
      return res.json({ message: '과목이 추가되었습니다.' });
    }

    const [clsResult] = await db.query(
      'INSERT INTO classes (subject_id, class_code, teacher) VALUES (?, ?, ?)',
      [subjId, class_name, teacher_name || null]
    );

    // 반장 계정이 있으면 enrollments에도 추가
    if (leader_username) {
      await db.query(
        'INSERT IGNORE INTO enrollments (user_id, class_id) VALUES (?, ?)',
        [leader_username, clsResult.insertId]
      ).catch(() => {}); // 실패해도 무시
    }

    res.json({ message: '과목/분반이 추가되었습니다.' });
  } catch (err) {
    console.error('[subjects] POST 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// DELETE /api/subjects/:id — 분반 삭제 (관리자)
router.delete('/:id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  }

  try {
    await db.query('DELETE FROM classes WHERE id = ?', [req.params.id]);
    res.json({ message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[subjects] DELETE 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

module.exports = router;