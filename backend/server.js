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

// ── 실시간 접속자 추적 ────────────────────────────────
// userId → 마지막 요청 시각 (Unix ms)
const activeUsers = new Map();
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 5분

// 시간별 접속 기록용 Set (이번 시간에 이미 기록된 유저 ID)
const hourLoggedUsers = new Set();
let currentHourKey = '';

// 로그인된 API 요청마다 마지막 활동 시각 갱신 + 시간별 접속 기록
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && req.session?.user?.id) {
    const userId = req.session.user.id;
    activeUsers.set(userId, Date.now());

    // 시간별 고유 접속자 기록 (DB에 INSERT)
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const hourKey = kst.toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
    if (hourKey !== currentHourKey) {
      hourLoggedUsers.clear();
      currentHourKey = hourKey;
    }
    const userHourKey = `${hourKey}|${userId}`;
    if (!hourLoggedUsers.has(userHourKey)) {
      hourLoggedUsers.add(userHourKey);
      const accessHour = kst.toISOString().slice(0, 10) + ' ' + kst.toISOString().slice(11, 13) + ':00:00';
      pool.query(
        'INSERT INTO hourly_access_logs (access_hour, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = user_id',
        [accessHour, userId]
      ).catch(() => {});
    }
  }
  next();
});

// GET /api/admin/active-users — 5분 이내 활동한 유저 수 (관리자 전용)
app.get('/api/admin/active-users', (req, res) => {
  if (req.session?.user?.role !== 'admin') {
    return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  }
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  const users = [];
  for (const [id, ts] of activeUsers) {
    if (ts >= cutoff) users.push({ id, last_active: ts });
    else activeUsers.delete(id); // 만료된 항목 정리
  }
  res.json({ count: users.length, users });
});

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
app.use('/api/schedule',    require('./routes/schedule'));
app.use('/api/admin',       require('./routes/admin'));

// ── 세션 확인 / 로그아웃 ───────────────────────────────
app.get('/api/me', async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }
  // class_num(담임반/반번호) 포함하여 반환
  try {
    const [rows] = await pool.query('SELECT class_num FROM users WHERE id = ?', [req.session.user.id]);
    res.json({ ...req.session.user, class_num: rows[0]?.class_num || null });
  } catch {
    res.json(req.session.user);
  }
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

// ── 학사일정 sync ─────────────────────────────────────
const { syncScheduleRange } = require('./schoolSchedule');

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

    // Step 3: Instagram → meal_day_images 테이블
    if (syncMeals) {
      try {
        const mr = await syncMeals();
        console.log(`[pipeline] 급식 sync 완료: upsert ${mr.upserted}건, 업로드 ${mr.uploaded}건, 재사용 ${mr.reused}건, 실패 ${mr.failed}건`);
      } catch (e) {
        console.error('[pipeline] 급식 sync 오류:', e.message);
        console.error('[pipeline] 급식 sync 스택:', e.stack);
      }
    } else {
      console.warn('[pipeline] syncMeals 모듈이 로드되지 않음 — 급식 sync 건너뜀');
    }

    // Step 4: NEIS → school_schedule 테이블 (학사일정)
    try {
      const sr = await syncScheduleRange();
      console.log(`[pipeline] 학사일정 sync 완료: ${sr.total}건`);
    } catch (e) {
      console.error('[pipeline] 학사일정 sync 오류:', e.message);
    }
  } finally {
    pipelineRunning = false;
    console.log(`[pipeline] ===== 완료 =====\n`);
  }
}

// 12시간마다 실행 (한국 시간)
cron.schedule('0 */12 * * *', runPipeline, { timezone: 'Asia/Seoul' });
console.log('[scheduler] 12시간 주기 파이프라인 등록 완료');

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
app.listen(PORT, async () => {
  console.log(`✅ 서버 실행 중: PORT=${PORT}`);

  // ── hourly_access_logs 테이블 자동 생성 ──
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hourly_access_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        access_hour DATETIME NOT NULL,
        user_id VARCHAR(50) NOT NULL,
        UNIQUE KEY uq_hour_user (access_hour, user_id)
      )
    `);
  } catch {}

  // ── class_num 컬럼 자동 추가 (학생 반번호, 선생님 담임반) ──
  try {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'class_num'`
    );
    if (!cols.length) {
      await pool.query('ALTER TABLE users ADD COLUMN class_num VARCHAR(10) DEFAULT NULL');
      console.log('[migration] users.class_num 컬럼 추가');
    }
  } catch {}

  // 선생님 계정 자동 등록 (없으면 추가) + 담임반 설정
  // homeroom: 담임반 번호 (없으면 null → 수행 성실도 비표시)
  const teachers = [
    { id: '문가람', name: '문가람', role: 'teacher', password: '1234', homeroom: '6' },
    { id: '이경규', name: '이경규', role: 'teacher', password: '1234', homeroom: '7' },
    { id: '신율빈', name: '신율빈', role: 'teacher', password: '1234', homeroom: '5' },
    { id: '박정은', name: '박정은', role: 'teacher', password: '1234', homeroom: '8' },
    { id: '이상돈', name: '이상돈', role: 'teacher', password: '1234', homeroom: '4' },
  ];
  for (const t of teachers) {
    try {
      await pool.query(
        'INSERT IGNORE INTO users (id, name, role, password, class_num) VALUES (?, ?, ?, ?, ?)',
        [t.id, t.name, t.role, t.password, t.homeroom]
      );
      // 기존 계정이면 담임반만 갱신 (homeroom이 설정된 경우만)
      if (t.homeroom) {
        await pool.query('UPDATE users SET class_num = ? WHERE id = ? AND role = ?', [t.homeroom, t.id, 'teacher']);
      }
    } catch {}
  }

  // ── 학생 반번호 자동 세팅 (class_num이 NULL인 학생만) ──
  try {
    const classMap = require('./classMap.json'); // 이름 → 반번호 매핑
    const [students] = await pool.query(
      "SELECT id, name FROM users WHERE role = 'student' AND class_num IS NULL"
    );
    for (const s of students) {
      let classNum = null;
      // 1순위: ID suffix에서 반번호 추출 (동명이인: 김재민_6 → 6)
      const suffixMatch = s.id.match(/_(\d+)$/);
      if (suffixMatch) {
        classNum = suffixMatch[1];
      } else if (classMap[s.name]) {
        // 2순위: 이름으로 매핑 (유일한 이름)
        classNum = classMap[s.name];
      }
      if (classNum) {
        await pool.query('UPDATE users SET class_num = ? WHERE id = ?', [classNum, s.id]);
      }
    }
    console.log(`[migration] 학생 반번호 세팅 완료 (${students.length}명 처리)`);
  } catch (e) { console.error('[migration] 학생 반번호 세팅 오류:', e.message); }

  runPipeline();
});
