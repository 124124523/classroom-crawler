// backend/routes/Timetable.js
const express    = require('express');
const router     = express.Router();
const db         = require('../db');
const cloudinary = require('cloudinary').v2;
const multer     = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function runMulter(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, err => err ? reject(err) : resolve());
  });
}

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}

// GET /api/timetable — 학생 수강 과목 목록
router.get('/', requireLogin, async (req, res) => {
  const userId = req.session.user.id;

  try {
    const [rows] = await db.query(`
      SELECT
        c.id         AS class_id,
        c.class_code,
        c.teacher,
        s.id         AS subject_id,
        s.name       AS subject_name,
        s.category
      FROM enrollments e
      JOIN classes  c ON e.class_id   = c.id
      JOIN subjects s ON c.subject_id = s.id
      WHERE e.user_id = ?
      ORDER BY FIELD(s.category,'일반','진로'), s.name ASC
    `, [userId]);

    res.json({ timetable: rows });
  } catch (err) {
    console.error('[timetable] GET 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/timetable/personal — 개인 일정 목록
router.get('/personal', requireLogin, async (req, res) => {
  const userId = req.session.user.id;

  try {
    const [rows] = await db.query(`
      SELECT
        p.id, p.title, p.description,
        p.due_date, p.image_url, p.created_at,
        c.class_code,
        s.name AS subject_name
      FROM personal_events p
      LEFT JOIN classes  c ON p.class_id  = c.id
      LEFT JOIN subjects s ON c.subject_id = s.id
      WHERE p.user_id = ?
      ORDER BY p.due_date ASC, p.created_at DESC
    `, [userId]);

    res.json({ events: rows });
  } catch (err) {
    console.error('[personal] GET 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/timetable/personal — 개인 일정 추가
router.post('/personal', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const { title, description, due_date, class_id, image_url } = req.body;

  if (!title) return res.status(400).json({ message: '제목은 필수입니다.' });

  try {
    const [result] = await db.query(
      'INSERT INTO personal_events (user_id, title, description, due_date, class_id, image_url) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, title, description || null, due_date || null, class_id || null, image_url || null]
    );
    res.json({ message: '일정이 추가되었습니다.', id: result.insertId });
  } catch (err) {
    console.error('[personal] POST 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// DELETE /api/timetable/personal/:id — 개인 일정 삭제 (본인만)
router.delete('/personal/:id', requireLogin, async (req, res) => {
  const userId = req.session.user.id;

  try {
    await db.query(
      'DELETE FROM personal_events WHERE id = ? AND user_id = ?',
      [req.params.id, userId]
    );
    res.json({ message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[personal] DELETE 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/timetable/complete — 과제 완료/미완료 토글
router.post('/complete', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const { assignment_id, target_id, target_type, completed } = req.body;

  const type = target_type || 'assignment';
  const id   = String(assignment_id || target_id || '');

  if (!id) return res.status(400).json({ message: 'target_id가 필요합니다.' });

  try {
    if (Number(completed) === 1) {
      await db.query(
        'INSERT IGNORE INTO completions (user_id, target_type, target_id) VALUES (?, ?, ?)',
        [userId, type, id]
      );
      res.json({ message: '완료 처리되었습니다.' });
    } else {
      await db.query(
        'DELETE FROM completions WHERE user_id = ? AND target_type = ? AND target_id = ?',
        [userId, type, id]
      );
      res.json({ message: '미완료로 변경되었습니다.' });
    }
  } catch (err) {
    console.error('[complete] POST 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/timetable/image/:userId — 시간표 이미지 조회
router.get('/image/:userId', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT image_url, file_type, file_name FROM timetables WHERE user_id = ?',
      [req.params.userId]
    );
    res.json(rows[0] || { image_url: null, file_type: null, file_name: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/timetable/image/:userId — 시간표 이미지 업로드
router.post('/image/:userId', requireLogin, async (req, res) => {
  try { await runMulter(req, res); }
  catch (e) {
    if (e.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '파일이 20MB를 초과합니다.' });
    return res.status(400).json({ error: e.message });
  }

  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

  const mime     = req.file.mimetype;
  const origName = req.file.originalname;
  const ext      = origName.split('.').pop().toLowerCase();
  const isImg    = mime.startsWith('image/');

  try {
    const b64    = req.file.buffer.toString('base64');
    const uri    = `data:${mime};base64,${b64}`;
    const result = await cloudinary.uploader.upload(uri, {
      folder:        'schoolboard/timetables',
      public_id:     `timetable_${req.params.userId}`,
      overwrite:     true,
      resource_type: isImg ? 'image' : 'raw',
    });

    await db.query(
      `INSERT INTO timetables (user_id, image_url, file_type, file_name)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE image_url=?, file_type=?, file_name=?`,
      [req.params.userId, result.secure_url, ext, origName,
                          result.secure_url, ext, origName]
    );

    res.json({ success: true, image_url: result.secure_url });
  } catch (e) {
    res.status(500).json({ error: 'Cloudinary 오류: ' + e.message });
  }
});

module.exports = router;