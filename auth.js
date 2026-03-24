const { google } = require('googleapis');
const pool = require('./db');
require('dotenv').config();

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL
  );
}

async function getAuthUrl(userId) {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: userId,
  });
}

async function handleCallback(code, userId) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  await pool.query(
    `INSERT INTO tokens (user_id, access_token, refresh_token, token_expiry)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       access_token = VALUES(access_token),
       refresh_token = VALUES(refresh_token),
       token_expiry = VALUES(token_expiry)`,
    [
      userId,
      tokens.access_token,
      tokens.refresh_token || null,
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    ]
  );

  return tokens;
}

async function getClientForUser(userId) {
  const [rows] = await pool.query('SELECT * FROM tokens WHERE user_id = ?', [userId]);
  if (rows.length === 0) throw new Error(`토큰 없음: ${userId}`);

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: rows[0].access_token,
    refresh_token: rows[0].refresh_token,
    expiry_date: rows[0].token_expiry ? new Date(rows[0].token_expiry).getTime() : null,
  });

  // 토큰 만료 시 자동 갱신 후 DB 업데이트
  oauth2Client.on('tokens', async (newTokens) => {
    await pool.query(
      `UPDATE tokens SET access_token = ?, token_expiry = ? WHERE user_id = ?`,
      [newTokens.access_token, new Date(newTokens.expiry_date), userId]
    );
  });

  return oauth2Client;
}

module.exports = { getAuthUrl, handleCallback, getClientForUser };