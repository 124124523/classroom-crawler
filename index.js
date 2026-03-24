const express = require('express');
const session = require('express-session');
const { getAuthUrl, handleCallback } = require('./auth');
const { crawlAll, crawlUser } = require('./classroom');
require('dotenv').config();

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
  const url = await getAuthUrl(userId);
  res.redirect(url);
});

// Google 콜백
app.get('/auth/google/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  try {
    await handleCallback(code, userId);
    res.send(`✅ ${userId} 인증 완료! 창 닫아도 됩니다.`);
  } catch (err) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));