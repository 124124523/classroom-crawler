require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cron    = require('node-cron');
const path    = require('path');
const pool    = require('./db');

const app = express();

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ── 세션 설정 ──────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'schoolboard-secret',
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 1000 * 60 * 60 * 24 }, // 24시간
}));

// ── API 라우트 ──────────────────────────────────────────
app.use('/api/login',       require('./routes/login'));
app.use('/api/notices',     require('./routes/notices'));
app.use('/api/comments',    require('./routes/comments'));
app.use('/api/assignments', require('./routes/assignments'));
app.use('/api/subjects',    require('./routes/subjects'));
app.use('/api/meals',       require('./routes/meals'));
app.use('/api/timetable',   require('./routes/Timetable'));
app.use('/api/upload',      require('./routes/upload'));
app.use('/api/classroom',   require('./routes/classroom'));
app.use('/api/admin',       require('./routes/admin'));

// ── 세션 확인 / 로그아웃 ───────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }
  res.json(req.session.user);
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ── 프로필: 비밀번호 변경 ─────────────────────────────
app.put('/api/me/password', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ message: '모든 필드를 입력하세요.' });
  try {
    const [rows] = await pool.query('SELECT id FROM users WHERE id = ? AND password = ?', [req.session.user.id, current_password]);
    if (!rows.length) return res.status(401).json({ message: '현재 비밀번호가 틀렸습니다.' });
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [new_password, req.session.user.id]);
    res.json({ message: '비밀번호가 변경되었습니다.' });
  } catch (err) {
    console.error('[profile/password]', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// ── 프로필: 아이디 변경 ───────────────────────────────
app.put('/api/me/id', async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  const { new_id, password } = req.body;
  if (!new_id || !password) return res.status(400).json({ message: '모든 필드를 입력하세요.' });
  const userId = req.session.user.id;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [pwRows] = await conn.query('SELECT id FROM users WHERE id = ? AND password = ?', [userId, password]);
    if (!pwRows.length) {
      await conn.rollback(); conn.release();
      return res.status(401).json({ message: '비밀번호가 틀렸습니다.' });
    }
    const [existRows] = await conn.query('SELECT id FROM users WHERE id = ?', [new_id]);
    if (existRows.length) {
      await conn.rollback(); conn.release();
      return res.status(409).json({ message: '이미 사용 중인 아이디입니다.' });
    }
    const updates = [
      ['UPDATE enrollments SET user_id=? WHERE user_id=?'],
      ['UPDATE completions SET user_id=? WHERE user_id=?'],
      ['UPDATE personal_events SET user_id=? WHERE user_id=?'],
      ['UPDATE timetables SET user_id=? WHERE user_id=?'],
      ['UPDATE tokens SET user_id=? WHERE user_id=?'],
      ['UPDATE notices SET writer=? WHERE writer=?'],
      ['UPDATE assignments SET writer=? WHERE writer=?'],
      ['UPDATE notice_comments SET writer=? WHERE writer=?'],
      ['UPDATE assignment_comments SET writer=? WHERE writer=?'],
      ['UPDATE users SET id=? WHERE id=?'],
    ];
    for (const [sql] of updates) await conn.query(sql, [new_id, userId]);
    await conn.commit(); conn.release();
    req.session.user.id = new_id;
    res.json({ message: '아이디가 변경되었습니다.', new_id });
  } catch (err) {
    await conn.rollback(); conn.release();
    console.error('[profile/id]', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// ── Google OAuth 콜백 alias ────────────────────────────
// CALLBACK_URL 환경변수가 /auth/google/callback 으로 설정돼 있어서
// /api/classroom/callback 으로 내부 포워딩
app.get('/auth/google/callback', (req, res) => {
  // query string 그대로 유지해서 /api/classroom/callback 으로 리다이렉트
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(`/api/classroom/callback?${qs}`);
});

// ── 크롤러 + sync 파이프라인 ───────────────────────────
let crawlAll       = null;
let syncCoursework = null;

try {
  crawlAll       = require('../crawler/auth').crawlAll;
  syncCoursework = require('./sync').syncCourseworkToAssignments;
} catch (e) {
  console.warn('[pipeline] 크롤러/sync 로드 실패:', e.message);
}

// ── 급식 sync ─────────────────────────────────────────
let syncMeals = null;
try {
  syncMeals = require('./syncMeals').syncInstagramMealImages;
} catch (e) {
  console.warn('[pipeline] mealSync 로드 실패:', e.message);
}

// 동시 실행 방지 락
let pipelineRunning = false;

async function runPipeline() {
  if (pipelineRunning) {
    console.warn('[pipeline] 이미 실행 중 — 스킵');
    return;
  }
  pipelineRunning = true;

  const ts = new Date().toLocaleString('ko-KR');
  console.log(`\n[pipeline] ===== 시작: ${ts} =====`);

  try {
    // Step 1: Google Classroom → coursework 테이블
    if (crawlAll) {
      try {
        const cr = await crawlAll();
        console.log(`[pipeline] 크롤링 완료: upsert ${cr.upserted}개`);
      } catch (e) {
        console.error('[pipeline] 크롤링 오류:', e.message);
      }
    }

    // Step 2: coursework → assignments 테이블
    if (syncCoursework) {
      try {
        const sr = await syncCoursework();
        console.log(`[pipeline] sync 완료: 추가 ${sr.inserted}개, 스킵 ${sr.skipped}개, 실패 ${sr.failed}개`);
      } catch (e) {
        console.error('[pipeline] sync 오류:', e.message);
      }
    }

    // Step 3: NEIS → school_meals 테이블
    if (syncMeals) {
      try {
        const mr = await syncMeals();
        console.log(`[pipeline] 급식 sync 완료: ${mr.total}건 처리, 실패 ${mr.failed}건`);
      } catch (e) {
        console.error('[pipeline] 급식 sync 오류:', e.message);
      }
    }
  } finally {
    pipelineRunning = false;
    console.log(`[pipeline] ===== 완료 =====\n`);
  }
}

// 3시간마다 실행 (한국 시간)
cron.schedule('0 */3 * * *', runPipeline, { timezone: 'Asia/Seoul' });
console.log('[scheduler] 3시간 주기 파이프라인 등록 완료');

// 매일 오전 7시 급식 사진 단독 sync (Instagram → Cloudinary → DB)
cron.schedule('0 7 * * *', async () => {
  if (syncMeals) {
    try {
      const mr = await syncMeals();
      console.log(`[meal-cron] 완료: upsert ${mr.upserted}건, 업로드 ${mr.uploaded}건, 실패 ${mr.failed}건`);
    } catch (e) {
      console.error('[meal-cron] 오류:', e.message);
    }
  }
}, { timezone: 'Asia/Seoul' });
console.log('[scheduler] 매일 07:00 급식 사진 sync 등록 완료');

// ── SPA 폴백 ──────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// ── 서버 시작 ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: PORT=${PORT}`);
  runPipeline();
});
