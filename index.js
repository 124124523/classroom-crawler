require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { getAuthUrl, handleCallback } = require('./auth');
const { crawlAll, crawlUser } = require('./classroom');
const pool = require('./db');

const app = express();

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

// 학생 인증 시작
app.get('/auth/google/start', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).send('userId 파라미터 필요');
  try {
    const url = await getAuthUrl(userId);
    res.redirect(url);
  } catch (err) {
    console.error('getAuthUrl 에러:', err);
    res.status(500).send(`❌ 에러: ${err.message}`);
  }
});

// Google 콜백
app.get('/auth/google/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  try {
    await handleCallback(code, userId);
    res.send(`✅ ${userId} 인증 완료! 창 닫아도 됩니다.`);
  } catch (err) {
    console.error('handleCallback 에러:', err);
    res.status(500).send(`❌ 오류: ${err.message}`);
  }
});

// 전체 크롤링
app.get('/classroom/crawl', async (req, res) => {
  try {
    const results = await crawlAll();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 특정 학생만 크롤링
app.get('/classroom/crawl/:userId', async (req, res) => {
  try {
    const result = await crawlUser(req.params.userId);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── materials 조회 라우트 (신규) ────────────────────────

// 특정 학생의 모든 파일 목록 (내용 미리보기 500자)
app.get('/materials/:userId', async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.userId);
    const [rows] = await pool.query(
      `SELECT id, coursework_id, course_id, title, type, mime_type,
              LEFT(content, 500) AS content_preview, extracted_at
       FROM materials
       WHERE user_id = ?
       ORDER BY extracted_at DESC`,
      [userId]
    );
    res.json({ userId, count: rows.length, materials: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 특정 파일 전체 내용 조회
app.get('/materials/:userId/:materialId', async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.userId);
    const [rows] = await pool.query(
      'SELECT * FROM materials WHERE id = ? AND user_id = ?',
      [req.params.materialId, userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 환경변수 확인용 디버그
app.get('/debug/env', (req, res) => {
  res.json({
    CLIENT_ID_SET: !!process.env.GOOGLE_CLIENT_ID,
    CALLBACK_URL: process.env.CALLBACK_URL,
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: PORT=${PORT}`));