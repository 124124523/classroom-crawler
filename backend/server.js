require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cron    = require('node-cron');
const path    = require('path');

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

// ── 크롤러 + sync 파이프라인 ───────────────────────────
// 흐름: Google Classroom API → coursework 테이블 → assignments 테이블
let crawlAll       = null;
let syncCoursework = null;

try {
  crawlAll       = require('../crawler/auth').crawlAll;
  syncCoursework = require('./sync').syncCourseworkToAssignments;
} catch (e) {
  console.warn('[pipeline] 크롤러/sync 로드 실패:', e.message);
}

async function runPipeline() {
  const ts = new Date().toLocaleString('ko-KR');
  console.log(`\n[pipeline] ===== 시작: ${ts} =====`);

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

  console.log(`[pipeline] ===== 완료 =====\n`);
}

// 3시간마다 실행 (한국 시간)
cron.schedule('0 */3 * * *', runPipeline, { timezone: 'Asia/Seoul' });
console.log('[scheduler] 3시간 주기 파이프라인 등록 완료');

// ── SPA 폴백 ──────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// ── 서버 시작 ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: PORT=${PORT}`);
  // 서버 시작 시 1회 파이프라인 실행
  runPipeline();
});