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
// tokens 테이블에 데이터가 있으면 인증된 것으로 판단
router.get('/auth-status', requireAdmin, (req, res) => {
  db.query('SELECT COUNT(*) AS cnt FROM tokens', (err, rows) => {
    if (err) return res.json({ authenticated: false });
    res.json({ authenticated: rows[0].cnt > 0 });
  });
});

// POST /api/classroom/sync
// 크롤러 sync 즉시 실행
router.post('/sync', requireAdmin, async (req, res) => {
  try {
    let syncFn;
    try {
      syncFn = require('../sync').syncCourseworkToAssignments;
    } catch {
      return res.status(500).json({ message: 'sync.js를 찾을 수 없습니다.' });
    }

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

// GET /api/classroom/callback — OAuth 콜백 (기존 auth.js 플로우 연동)
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('코드가 없습니다.');

  try {
    const { getOAuthClient } = require('../../crawler/auth');
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);

    // classroom_bot 계정에 토큰 저장
    const userId = 'classroom_bot';
    db.query(
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
      ],
      (err) => {
        if (err) {
          console.error('[callback] DB 저장 오류:', err.message);
          return res.status(500).send('토큰 저장 실패');
        }
        res.send('<script>window.close();</script><p>인증 완료! 창을 닫으세요.</p>');
      }
    );
  } catch (e) {
    console.error('[callback] 오류:', e.message);
    res.status(500).send('인증 실패: ' + e.message);
  }
});

// GET /api/classroom/auth-url — 구글 인증 URL 생성
router.get('/auth-url', requireAdmin, (req, res) => {
  try {
    const { getOAuthClient } = require('../../crawler/auth');
    const client = getOAuthClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/classroom.courses.readonly',
              'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
              'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'],
      prompt: 'consent',
    });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;