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

// GET /api/admin/coverage — 분반 커버리지 분석
router.get('/coverage', requireAdmin, async (req, res) => {
  try {
    // 전체 분반 목록
    const [classes] = await db.query(`
      SELECT c.id, c.class_code, s.name AS subject_name,
             CONCAT(s.name, ' ', c.class_code) AS label
      FROM classes c JOIN subjects s ON c.subject_id = s.id
    `);

    // 토큰 보유 계정 → 학생 정보 → 수강 분반
    const [tokenUsers] = await db.query(`
      SELECT t.user_id, u.name, u.id AS student_id,
             GROUP_CONCAT(e.class_id ORDER BY e.class_id) AS class_ids
      FROM tokens t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN enrollments e ON e.user_id = u.id
      WHERE u.role = 'student'
      GROUP BY t.user_id, u.name, u.id
    `);

    const classMap = {};
    classes.forEach(c => { classMap[c.id] = c.label; });

    const covered = new Set();
    const tokenUserData = tokenUsers.map(u => {
      const classIds = u.class_ids ? u.class_ids.split(',').map(Number) : [];
      classIds.forEach(c => covered.add(c));
      return {
        userId: u.user_id,
        name: u.name || u.user_id,
        classIds,
        classNames: classIds.map(c => classMap[c] || c),
      };
    });

    const allClassIds = classes.map(c => c.id);
    const uncoveredIds = allClassIds.filter(c => !covered.has(c));
    const uncoveredLabels = uncoveredIds.map(c => classMap[c]);

    // 미커버 분반을 커버할 수 있는 학생 추천
    const [allStudents] = await db.query(`
      SELECT u.id, u.name,
             GROUP_CONCAT(e.class_id ORDER BY e.class_id) AS class_ids
      FROM users u
      LEFT JOIN enrollments e ON e.user_id = u.id
      WHERE u.role = 'student'
      GROUP BY u.id, u.name
    `);

    const tokenUserIds = new Set(tokenUsers.map(u => u.user_id));
    const recommendations = allStudents
      .filter(s => !tokenUserIds.has(s.id))
      .map(s => {
        const classIds = s.class_ids ? s.class_ids.split(',').map(Number) : [];
        const newCovers = classIds.filter(c => uncoveredIds.includes(c));
        return {
          name: s.name,
          count: newCovers.length,
          classNames: newCovers.map(c => classMap[c]),
          authLink: `/api/classroom/auth?userId=${encodeURIComponent(s.id)}`,
        };
      })
      .filter(s => s.count > 0)
      .sort((a, b) => b.count - a.count);

    res.json({
      total: allClassIds.length,
      covered: covered.size,
      tokenUsers: tokenUserData,
      uncovered: uncoveredLabels,
      recommendations,
    });
  } catch (err) {
    console.error('[admin/coverage] 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/admin/sync-meals — Instagram 급식 사진 수동 동기화
router.post('/sync-meals', requireAdmin, async (req, res) => {
  try {
    const { syncInstagramMealImages } = require('../syncMeals');
    const result = await syncInstagramMealImages();

    res.json({
      message: `급식 동기화 완료: ${result.upserted}건 반영, 실패 ${result.failed}건`,
      result,
    });
  } catch (err) {
    console.error('[admin/sync-meals]', err.message);
    res.status(500).json({ message: '급식 동기화 실패: ' + err.message });
  }
});

module.exports = router;
