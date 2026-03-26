const express = require('express');
const router = express.Router();
const pool = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: '로그인 필요' });
  next();
}

// GET /api/timetable - 내 수강 분반 + 과제 목록
router.get('/', requireLogin, async (req, res) => {
  const userId = req.session.userId;

  try {
    // 내 수강 분반 + 과목 정보
    const [myClasses] = await pool.query(`
      SELECT c.id AS class_id, c.class_code, c.teacher,
             s.id AS subject_id, s.name AS subject_name, s.category
      FROM enrollments e
      JOIN classes  c ON e.class_id   = c.id
      JOIN subjects s ON c.subject_id = s.id
      WHERE e.user_id = ?
      ORDER BY s.category DESC, s.name ASC
    `, [userId]);

    if (myClasses.length === 0) return res.json({ subjects: [], personal: [] });

    const classIds = myClasses.map(c => c.class_id);

    // 과제 목록 (2개월 전 이후)
    const [assignments] = await pool.query(`
      SELECT a.id, a.title, a.deadline, a.class_id,
             a.content, a.image_urls, a.gclassroom_id,
             DATEDIFF(a.deadline, CURDATE()) AS days_left
      FROM assignments a
      WHERE a.class_id IN (?)
        AND a.deadline >= DATE_SUB(CURDATE(), INTERVAL 2 MONTH)
      ORDER BY a.deadline ASC
    `, [classIds]);

    // 완료 체크 목록
    const [completions] = await pool.query(`
      SELECT target_id FROM completions
      WHERE user_id = ? AND target_type = 'assignment'
    `, [userId]);
    const completedSet = new Set(completions.map(c => String(c.target_id)));

    // 개인 일정
    const [personalEvents] = await pool.query(`
      SELECT p.id, p.title, p.due_date, p.description, p.image_url, p.class_id,
             DATEDIFF(p.due_date, CURDATE()) AS days_left
      FROM personal_events p
      WHERE p.user_id = ?
        AND (p.due_date IS NULL OR p.due_date >= DATE_SUB(CURDATE(), INTERVAL 2 MONTH))
      ORDER BY p.due_date ASC
    `, [userId]);

    // 개인 일정 완료 체크
    const [personalCompletions] = await pool.query(`
      SELECT target_id FROM completions
      WHERE user_id = ? AND target_type = 'personal'
    `, [userId]);
    const personalCompletedSet = new Set(personalCompletions.map(c => String(c.target_id)));

    // 분반별 과제 그룹핑
    const assignmentsByClass = {};
    for (const a of assignments) {
      if (!assignmentsByClass[a.class_id]) assignmentsByClass[a.class_id] = [];
      assignmentsByClass[a.class_id].push({
        id:        a.id,
        title:     a.title,
        deadline:  a.deadline,
        daysLeft:  a.days_left,
        content:   a.content,
        imageUrls: a.image_urls ? JSON.parse(a.image_urls) : [],
        isGoogleCR: !!a.gclassroom_id,
        completed: completedSet.has(String(a.id)),
      });
    }

    const subjects = myClasses.map(cls => ({
      subjectId:   cls.subject_id,
      subjectName: cls.subject_name,
      category:    cls.category,
      classCode:   cls.class_code,
      teacher:     cls.teacher,
      classId:     cls.class_id,
      assignments: assignmentsByClass[cls.class_id] || [],
    }));

    const personal = personalEvents.map(p => ({
      id:          p.id,
      title:       p.title,
      dueDate:     p.due_date,
      daysLeft:    p.days_left,
      description: p.description,
      imageUrl:    p.image_url,
      classId:     p.class_id,
      completed:   personalCompletedSet.has(String(p.id)),
    }));

    res.json({ subjects, personal });
  } catch (err) {
    console.error('[timetable] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/timetable/complete - 완료 토글
router.post('/complete', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const { targetType, targetId } = req.body;

  if (!['assignment', 'personal'].includes(targetType) || !targetId)
    return res.status(400).json({ error: '잘못된 파라미터' });

  try {
    const [existing] = await pool.query(
      'SELECT id FROM completions WHERE user_id=? AND target_type=? AND target_id=?',
      [userId, targetType, String(targetId)]
    );
    if (existing.length > 0) {
      await pool.query(
        'DELETE FROM completions WHERE user_id=? AND target_type=? AND target_id=?',
        [userId, targetType, String(targetId)]
      );
      res.json({ completed: false });
    } else {
      await pool.query(
        'INSERT INTO completions (user_id, target_type, target_id) VALUES (?,?,?)',
        [userId, targetType, String(targetId)]
      );
      res.json({ completed: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/timetable/personal - 개인 일정 추가
router.post('/personal', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const { title, description, dueDate, classId, imageUrl } = req.body;
  if (!title) return res.status(400).json({ error: 'title 필요' });

  try {
    const [result] = await pool.query(
      `INSERT INTO personal_events (user_id, class_id, title, description, due_date, image_url)
       VALUES (?,?,?,?,?,?)`,
      [userId, classId || null, title, description || null, dueDate || null, imageUrl || null]
    );
    res.json({ id: result.insertId, message: '개인 일정 추가 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/timetable/personal/:id - 개인 일정 삭제
router.delete('/personal/:id', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  try {
    await pool.query(
      'DELETE FROM personal_events WHERE id=? AND user_id=?',
      [req.params.id, userId]
    );
    res.json({ message: '삭제 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;