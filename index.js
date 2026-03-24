require('dotenv').config(); // ← 반드시 최상단 (모든 require보다 위)

const express = require('express');
const session = require('express-session');
const { getAuthUrl, handleCallback } = require('./auth');
const { crawlAll, crawlUser } = require('./classroom');

const app = express();

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

app.get('/auth/google/start', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).send('userId 파라미터 필요');
  const url = await getAuthUrl(userId);
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  try {
    await handleCallback(code, userId);
    res.send(`✅ ${userId} 인증 완료! 창 닫아도 됩니다.`);
  } catch (err) {
    res.status(500).send(`❌ 오류: ${err.message}`);
  }
});

app.get('/classroom/crawl', async (req, res) => {
  try {
    const results = await crawlAll();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/classroom/crawl/:userId', async (req, res) => {
  try {
    const result = await crawlUser(req.params.userId);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 환경변수 로드 확인용 (디버깅 후 삭제)
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