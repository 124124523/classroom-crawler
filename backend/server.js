require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cron    = require('node-cron');
const path    = require('path');

const { syncCourseworkToAssignments } = require('./sync');

// 라우트
const loginRouter       = require('./routes/login');
const timetableRouter   = require('./routes/Timetable');
const noticesRouter     = require('./routes/notices');
const assignmentsRouter = require('./routes/assignments');
const commentsRouter    = require('./routes/comments');
const subjectsRouter    = require('./routes/subjects');
const mealsRouter       = require('./routes/meals');
const uploadRouter      = require('./routes/upload');
const classroomRouter   = require('./routes/classroom');
const adminRouter       = require('./routes/admin');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 프론트엔드 정적 파일 서빙
app.use(express.static(path.join(__dirname, '../frontend')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'schoolboard-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 },
}));

// =====================================================
// API 라우트 등록
// =====================================================
app.use('/api/login',       loginRouter);
app.use('/api/timetable',   timetableRouter);
app.use('/api/notices',     noticesRouter);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/comments',    commentsRouter);
app.use('/api/subjects',    subjectsRouter);
app.use('/api/meals',       mealsRouter);
app.use('/api/upload',      uploadRouter);
app.use('/api/classroom',   classroomRouter);
app.use('/api/admin',       adminRouter);

// =====================================================
// 로그인 세션 확인 / 로그아웃
// =====================================================

// GET /api/me — 현재 로그인 유저 정보
app.get('/api/me', (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }
  res.json(req.session.user);
});

// POST /api/logout — 세션 삭제
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// =====================================================
// sync를 cron으로 3시간마다 실행
// =====================================================
async function runSync() {
  console.log(`\n[scheduler] sync 시작: ${new Date().toLocaleString('ko-KR')}`);
  try {
    const result = await syncCourseworkToAssignments();
    console.log(`[scheduler] sync 완료: 추가 ${result.inserted}개, 스킵 ${result.skipped}개, 실패 ${result.failed}개`);
  } catch (err) {
    console.error(`[scheduler] sync 오류: ${err.message}`);
  }
}

cron.schedule('0 */3 * * *', runSync, { timezone: 'Asia/Seoul' });
console.log('[scheduler] 3시간 주기 sync 스케줄러 등록 완료');

// =====================================================
// SPA 폴백 — Express 5는 /{*path} 사용
// =====================================================
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// =====================================================
// 서버 시작
// =====================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: PORT=${PORT}`);
  runSync();
});