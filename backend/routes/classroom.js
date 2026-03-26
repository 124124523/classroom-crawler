const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const pool = require('../db');
require('dotenv').config();

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL
  );
}

// GET /api/classroom/auth?userId=형민호 - 구글 인증 시작
router.get('/auth', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).send('userId 파라미터 필요');

  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: userId,
  });
  res.redirect(url);
});

// GET /api/classroom/callback - 구글 인증 콜백
router.get('/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('잘못된 요청');

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    // tokens 테이블에 저장 (크롤러용 DB - 같은 Railway DB 사용)
    await pool.query(
      `INSERT INTO tokens (user_id, access_token, refresh_token, token_expiry)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = VALUES(refresh_token),
         token_expiry  = VALUES(token_expiry)`,
      [
        userId,
        tokens.access_token,
        tokens.refresh_token || null,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      ]
    );

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ ${userId} 구글 클래스룸 연동 완료!</h2>
        <p>이 창을 닫아도 됩니다.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[classroom] 콜백 오류:', err.message);
    res.status(500).send(`❌ 오류: ${err.message}`);
  }
});

module.exports = router;