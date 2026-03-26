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

// ── API 라우트 (/api/* 접두사) ──────────────────────────
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

// ── sync cron ─────────────────────────────────────────
let syncCoursework;
try {
  syncCoursework = require('./sync').syncCourseworkToAssignments;
} catch {
  syncCoursework = null;
}

async function runSync() {
  if (!syncCoursework) return;
  console.log(`[sync] 시작: ${new Date().toLocaleString('ko-KR')}`);
  try {
    const r = await syncCoursework();
    console.log(`[sync] 완료: 추가 ${r.inserted}개, 스킵 ${r.skipped}개, 실패 ${r.failed}개`);
  } catch (e) {
    console.error(`[sync] 오류: ${e.message}`);
  }
}

cron.schedule('0 */3 * * *', runSync, { timezone: 'Asia/Seoul' });
console.log('[scheduler] 3시간 주기 sync 등록 완료');

// ── SPA 폴백 (Express 5) ──────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// ── 서버 시작 ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: PORT=${PORT}`);
  runSync();
});