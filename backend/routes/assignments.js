// backend/routes/assignments.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

// updated_at 컬럼 자동 추가
(async () => {
  try {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assignments' AND COLUMN_NAME = 'updated_at'`
    );
    if (!cols.length) {
      await db.query('ALTER TABLE assignments ADD COLUMN updated_at DATETIME DEFAULT NULL');
    }
  } catch {}
})();

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

// deadline→due_date, content→description, category→type 으로 alias
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
    a.updated_at,
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
router.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    let rows;

    if (user.role === 'admin' || user.role === 'teacher') {
      [rows] = await db.query(BASE_SELECT + ' ORDER BY a.deadline ASC');

    } else if (user.role === 'leader' && req.query.mine === 'true') {
      [rows] = await db.query(
        BASE_SELECT + `
          WHERE a.class_id IN (SELECT class_id FROM enrollments WHERE user_id = ?)
          ORDER BY a.deadline ASC`,
        [user.id]
      );

    } else {
      // 학생/리더 — 수강 분반 과제 + 완료 여부
      [rows] = await db.query(`
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
          a.updated_at,
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
          ON cp.user_id      = ?
          AND cp.target_type = 'assignment'
          AND cp.target_id   = CAST(a.id AS CHAR)
        ORDER BY a.deadline ASC`,
        [user.id, user.id]
      );
    }

    res.json({ assignments: parseImages(rows) });
  } catch (err) {
    console.error('[assignments] GET 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/assignments/completion-stats — 담임반 학생 수행 성실도
router.get('/completion-stats', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (user.role !== 'teacher' && user.role !== 'admin') {
    return res.status(403).json({ message: '권한 없음' });
  }

  try {
    // 담임반 번호 조회 (users.class_num)
    const [teacherRows] = await db.query(
      'SELECT class_num FROM users WHERE id = ?', [user.id]
    );
    const homeroom = teacherRows[0]?.class_num;
    if (!homeroom) return res.json({ stats: [], message: '담임반 정보가 없습니다.' });

    // 담임반 학생 목록 (class_num이 같은 학생들)
    const [students] = await db.query(
      "SELECT id, name FROM users WHERE role = 'student' AND class_num = ?",
      [homeroom]
    );
    if (!students.length) return res.json({ stats: [] });

    const studentIds = students.map(s => s.id);
    const studentNames = {};
    students.forEach(s => { studentNames[s.id] = s.name; });

    // 담임반 학생들의 전체 과제 완료 현황 (과목별 그룹핑)
    const [rows] = await db.query(
      `SELECT
         e.user_id,
         u.name AS user_name,
         a.class_id,
         s.name AS subject_name,
         c.class_code,
         CONCAT(s.name, ' ', c.class_code, '반') AS class_label,
         COUNT(DISTINCT a.id) AS total_assignments,
         COUNT(DISTINCT co.target_id) AS completed_count
       FROM enrollments e
       JOIN users u ON u.id = e.user_id
       JOIN assignments a ON a.class_id = e.class_id
       JOIN classes c ON c.id = a.class_id
       JOIN subjects s ON s.id = c.subject_id
       LEFT JOIN completions co ON co.user_id = e.user_id
         AND co.target_type = 'assignment' AND co.target_id = CAST(a.id AS CHAR)
       WHERE e.user_id IN (?)
       GROUP BY e.user_id, a.class_id`,
      [studentIds]
    );

    // 학생별 전체 과목 합산 통계
    const studentStats = {};
    rows.forEach(r => {
      if (!studentStats[r.user_id]) {
        studentStats[r.user_id] = { user_id: r.user_id, user_name: r.user_name, total: 0, completed: 0 };
      }
      studentStats[r.user_id].total += r.total_assignments;
      studentStats[r.user_id].completed += r.completed_count;
    });

    const stats = Object.values(studentStats).map(s => ({
      ...s,
      class_label: `${homeroom}반`,
      percent: s.total > 0 ? Math.round((s.completed / s.total) * 100) : 0,
    }));

    res.json({ stats, homeroom });
  } catch (err) {
    console.error('[assignments] GET /completion-stats 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/assignments/:id
router.get('/:id', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(BASE_SELECT + ' WHERE a.id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: '과제를 찾을 수 없습니다.' });
    res.json({ assignment: parseImages(rows)[0] });
  } catch (err) {
    console.error('[assignments] GET /:id 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/assignments
router.post('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'student') return res.status(403).json({ message: '권한 없음' });
  const { title, description, class_id, due_date, images, type } = req.body;
  if (!title || !class_id) return res.status(400).json({ message: '제목과 분반은 필수입니다.' });
  if (!due_date) return res.status(400).json({ message: '마감일은 필수입니다.' });

  const imagesJson = images?.length ? JSON.stringify(images) : null;

  try {
    const [result] = await db.query(
      'INSERT INTO assignments (title, content, writer, class_id, deadline, image_urls) VALUES (?, ?, ?, ?, ?, ?)',
      [title, description || '', user.id, class_id, due_date, imagesJson]
    );
    res.json({ message: '과제가 등록되었습니다.', id: result.insertId });
  } catch (err) {
    console.error('[assignments] POST 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// PUT /api/assignments/:id
router.put('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;
  const { title, description, due_date, images } = req.body;
  if (!due_date) return res.status(400).json({ message: '마감일은 필수입니다.' });

  const imagesJson = images?.length ? JSON.stringify(images) : null;

  try {
    const [rows] = await db.query('SELECT writer FROM assignments WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: '과제를 찾을 수 없습니다.' });
    if (rows[0].writer === 'classroom_bot') {
      return res.status(403).json({ message: '크롤러 자동 등록 항목은 수정할 수 없습니다.' });
    }
    if (user.role !== 'admin' && user.role !== 'teacher' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '수정 권한이 없습니다.' });
    }

    await db.query(
      'UPDATE assignments SET title=?, content=?, deadline=?, image_urls=?, updated_at=NOW() WHERE id=?',
      [title, description || '', due_date, imagesJson, req.params.id]
    );
    res.json({ message: '수정되었습니다.' });
  } catch (err) {
    console.error('[assignments] PUT 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// DELETE /api/assignments/:id
router.delete('/:id', requireLogin, async (req, res) => {
  const user = req.session.user;

  try {
    const [rows] = await db.query('SELECT writer FROM assignments WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: '과제를 찾을 수 없습니다.' });
    if (user.role !== 'admin' && user.role !== 'teacher' && rows[0].writer !== user.id) {
      return res.status(403).json({ message: '삭제 권한이 없습니다.' });
    }

    await db.query('DELETE FROM assignments WHERE id = ?', [req.params.id]);
    res.json({ message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[assignments] DELETE 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

module.exports = router;