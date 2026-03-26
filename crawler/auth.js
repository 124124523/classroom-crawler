// crawler/auth.js
// Railway에서는 .env 파일 없이 Variables로 주입되므로 path 제거
const { google } = require('googleapis');
const pool = require('./db');

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL
  );
}

async function getClientForUser(userId) {
  const [rows] = await pool.query('SELECT * FROM tokens WHERE user_id = ?', [userId]);
  if (rows.length === 0) throw new Error(`토큰 없음: ${userId}`);

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token:  rows[0].access_token,
    refresh_token: rows[0].refresh_token,
    expiry_date:   rows[0].token_expiry ? new Date(rows[0].token_expiry).getTime() : null,
  });

  // 토큰 만료 시 자동 갱신 후 DB 업데이트
  oauth2Client.on('tokens', async (newTokens) => {
    await pool.query(
      'UPDATE tokens SET access_token=?, token_expiry=? WHERE user_id=?',
      [newTokens.access_token, new Date(newTokens.expiry_date), userId]
    );
  });

  return oauth2Client;
}

module.exports = { getOAuthClient, getClientForUser };