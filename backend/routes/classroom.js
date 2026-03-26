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

// GET /api/classroom/auth?userId=형민호
// 링크로 직접 접근 → 구글 OAuth 시작
router.get('/auth', (req, res) => {
  const userId = req.query.userId;
  if (!userId) {
    return res.status(400).send('userId 파라미터가 필요합니다. 예: /api/classroom/auth?userId=형민호');
  }

  try {
    const { getOAuthClient } = require('../../crawler/auth');
    const client = getOAuthClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt:      'consent',  // 매번 refresh_token 재발급 보장
      scope: [
        'https://www.googleapis.com/auth/classroom.courses.readonly',
        'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
        'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
      ],
      state: userId,  // 콜백에서 어떤 유저인지 구분
    });
    res.redirect(url);
  } catch (e) {
    res.status(500).send('인증 URL 생성 실패: ' + e.message);
  }
});

// GET /api/classroom/auth-status
router.get('/auth-status', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT COUNT(*) AS cnt FROM tokens');
    res.json({ authenticated: rows[0].cnt > 0 });
  } catch {
    res.json({ authenticated: false });
  }
});

// POST /api/classroom/sync — 즉시 크롤링 + sync 실행
router.post('/sync', requireAdmin, async (req, res) => {
  try {
    // Step1: 크롤링
    let crawlResult = { upserted: 0, skipped: 0, failed: 0 };
    try {
      const { crawlAll } = require('../../crawler/auth');
      crawlResult = await crawlAll();
    } catch (e) {
      console.warn('[classroom/sync] 크롤링 스킵:', e.message);
    }

    // Step2: coursework → assignments 동기화
    const syncFn = require('../sync').syncCourseworkToAssignments;
    const syncResult = await syncFn();

    res.json({
      message: `크롤링 upsert ${crawlResult.upserted}개 → sync 추가 ${syncResult.inserted}개, 스킵 ${syncResult.skipped}개, 실패 ${syncResult.failed}개`,
      crawlResult,
      syncResult,
    });
  } catch (e) {
    console.error('[classroom/sync]', e.message);
    res.status(500).json({ message: '동기화 실패: ' + e.message });
  }
});

// GET /api/classroom/auth-url — 관리자용 인증 URL (JSON 반환)
router.get('/auth-url', requireAdmin, (req, res) => {
  try {
    const { getOAuthClient } = require('../../crawler/auth');
    const client = getOAuthClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt:      'consent',
      scope: [
        'https://www.googleapis.com/auth/classroom.courses.readonly',
        'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
        'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly',
      ],
      state: 'classroom_bot',
    });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET /api/classroom/callback — OAuth 콜백 (state = userId)
router.get('/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code)   return res.status(400).send('코드가 없습니다.');
  if (!userId) return res.status(400).send('userId(state)가 없습니다.');

  try {
    const { getOAuthClient } = require('../../crawler/auth');
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      return res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0D1810;color:#DFF0E6">
          <h2>⚠️ refresh_token을 받지 못했습니다.</h2>
          <p>구글 계정에서 앱 연결을 해제한 후 다시 시도하세요.</p>
          <a href="https://myaccount.google.com/permissions" target="_blank" style="color:#72C99A;display:block;margin:12px 0">
            구글 앱 권한 관리 →
          </a>
          <a href="/api/classroom/auth?userId=${encodeURIComponent(userId)}" style="color:#72C99A">
            해제 후 다시 인증하기 →
          </a>
        </body></html>
      `);
    }

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
        tokens.refresh_token,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      ]
    );

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0D1810;color:#DFF0E6">
        <h2>✅ ${userId} 구글 클래스룸 연동 완료!</h2>
        <p>이 창을 닫아도 됩니다.<br>다음 크롤링 주기에 과제가 자동으로 반영됩니다.</p>
        <script>setTimeout(() => window.close(), 2000);</script>
      </body></html>
    `);
  } catch (e) {
    console.error('[callback] 오류:', e.message);
    res.status(500).send('인증 실패: ' + e.message);
  }
});

module.exports = router;