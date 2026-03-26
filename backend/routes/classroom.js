// backend/routes/classroom.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function requireAdmin(req, res, next) {
  if (!req.session?.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  }
  next();
}

// GET /api/classroom/auth-status
router.get('/auth-status', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT COUNT(*) AS cnt FROM tokens');
    res.json({ authenticated: rows[0].cnt > 0 });
  } catch {
    res.json({ authenticated: false });
  }
});

// POST /api/classroom/sync — 즉시 sync 실행
router.post('/sync', requireAdmin, async (req, res) => {
  try {
    const syncFn = require('../sync').syncCourseworkToAssignments;
    const result = await syncFn();
    res.json({
      message: `동기화 완료 — 추가 ${result.inserted}개, 스킵 ${result.skipped}개, 실패 ${result.failed}개`,
      result,
    });
  } catch (e) {
    console.error('[classroom/sync]', e.message);
    res.status(500).json({ message: '동기화 실패: ' + e.message });
  }
});

// GET /api/classroom/auth-url — 구글 인증 URL 생성
router.get('/auth-url', requireAdmin, (req, res) => {
  try {
    // 경로: backend/routes/ → ../../ → 프로젝트 루트 → crawler/auth
    const { getOAuthClient } = require('../../crawler/auth');
    const client = getOAuthClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/classroom.courses.readonly',
        'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
        'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
      ],
      prompt: 'consent',
    });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /api/classroom/callback — OAuth 콜백
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('코드가 없습니다.');

  try {
    const { getOAuthClient } = require('../../crawler/auth');
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);

    const userId = 'classroom_bot';
    await db.query(
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

    res.send('<script>window.close();</script><p>✅ 인증 완료! 창을 닫으세요.</p>');
  } catch (e) {
    console.error('[callback] 오류:', e.message);
    res.status(500).send('인증 실패: ' + e.message);
  }
});

module.exports = router;