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
const adminRouter       = require('./routes/admin');   // ← 추가

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 프론트엔드 정적 파일 서빙
app.use(express.static(path.join(__dirname, '../frontend')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'schoolboard-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 24시간
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
app.use('/api/admin',       adminRouter);             // ← 추가

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
// SPA 폴백: 정의되지 않은 경로는 login.html로
// =====================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// =====================================================
// 서버 시작
// =====================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: PORT=${PORT}`);
  runSync(); // 서버 시작 시 즉시 1회 sync
});