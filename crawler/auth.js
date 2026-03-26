// crawler/auth.js
require('dotenv').config();
const { google } = require('googleapis');
const pool = require('./db');

// ── 병렬 처리 동시 실행 수 제한 ──────────────────────
// Google API 호출 제한 대비 한 번에 최대 5명씩 병렬 처리
const PARALLEL_LIMIT = 5;

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

// ── 마감일 파싱 ───────────────────────────────────────
function parseDueDate(dueDate, dueTime) {
  if (!dueDate) return { date: null, time: null };
  const { year, month, day } = dueDate;
  const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  let timeStr = null;
  if (dueTime) {
    const h = String(dueTime.hours   || 0).padStart(2,'0');
    const m = String(dueTime.minutes || 0).padStart(2,'0');
    timeStr = `${h}:${m}`;
  }
  return { date: dateStr, time: timeStr };
}

// ── 오늘 날짜 (KST) ───────────────────────────────────
function getTodayKST() {
  const now = new Date();
  // UTC+9
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── 한 수업의 coursework 배치 upsert ─────────────────
async function batchUpsertCourseWork(items, userId) {
  if (!items.length) return;

  // mysql2는 VALUES ? 에 2차원 배열 전달로 배치 INSERT 가능
  const values = items.map(item => [
    item.coursework_id,
    item.course_id,
    item.course_name,
    item.title,
    item.description,
    item.due_date,
    item.due_time,
    item.state,
    item.link,
    userId,
  ]);

  await pool.query(
    `INSERT INTO coursework
       (coursework_id, course_id, course_name, title, description,
        due_date, due_time, state, link, fetched_by)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       course_name = VALUES(course_name),
       title       = VALUES(title),
       description = VALUES(description),
       due_date    = VALUES(due_date),
       due_time    = VALUES(due_time),
       state       = VALUES(state),
       link        = VALUES(link),
       fetched_by  = VALUES(fetched_by)`,
    [values]
  );
}

// ── 한 계정의 coursework 크롤링 ───────────────────────
async function crawlForUser(userId) {
  const auth      = await getClientForUser(userId);
  const classroom = google.classroom({ version: 'v1', auth });
  const today     = getTodayKST();

  const courseRes = await classroom.courses.list({
    studentId:    'me',
    courseStates: ['ACTIVE'],
    pageSize:     50,
  });

  const courses = courseRes.data.courses || [];
  console.log(`  [crawler] ${userId}: 수업 ${courses.length}개`);

  let upserted = 0, skipped = 0;

  // ── 각 수업의 coursework를 병렬로 가져오기 ────────────
  await Promise.all(courses.map(async (course) => {
    try {
      const cwRes = await classroom.courses.courseWork.list({
        courseId: course.id,
        orderBy:  'dueDate asc',
        pageSize: 50,
      });

      const toUpsert = [];

      for (const cw of (cwRes.data.courseWork || [])) {
        const { date: dueDate, time: dueTime } = parseDueDate(cw.dueDate, cw.dueTime);

        // ── 증분1: 마감일 없는 과제 스킵 ────────────────
        if (!dueDate) { skipped++; continue; }

        // ── 증분2: 오늘 이전 마감 과제 스킵 (이미 지난 과제) ─
        if (dueDate < today) { skipped++; continue; }

        toUpsert.push({
          coursework_id: cw.id,
          course_id:     course.id,
          course_name:   course.name,
          title:         cw.title,
          description:   cw.description || null,
          due_date:      dueDate,
          due_time:      dueTime,
          state:         cw.state || 'PUBLISHED',
          link:          cw.alternateLink || null,
        });
      }

      // ── 배치 upsert (수업 1개당 DB 쿼리 1번으로 축소) ──
      await batchUpsertCourseWork(toUpsert, userId);
      upserted += toUpsert.length;

    } catch (e) {
      console.error(`  [crawler] ${userId} 수업(${course.name}) 오류: ${e.message}`);
    }
  }));

  return { upserted, skipped };
}

// ── 전체 크롤링 (병렬 처리) ───────────────────────────
async function crawlAll() {
  console.log(`[crawler] 시작: ${new Date().toLocaleString('ko-KR')}`);

  const [tokenRows] = await pool.query('SELECT user_id FROM tokens');
  if (!tokenRows.length) {
    console.warn('[crawler] tokens 테이블이 비어 있습니다. 구글 인증을 먼저 진행하세요.');
    return { upserted: 0, skipped: 0, failed: 0 };
  }

  let totalUpserted = 0, totalSkipped = 0, totalFailed = 0;

  // ── PARALLEL_LIMIT 명씩 나눠서 병렬 처리 ─────────────
  for (let i = 0; i < tokenRows.length; i += PARALLEL_LIMIT) {
    const batch = tokenRows.slice(i, i + PARALLEL_LIMIT);

    const results = await Promise.allSettled(
      batch.map(({ user_id }) => crawlForUser(user_id))
    );

    results.forEach((result, idx) => {
      const userId = batch[idx].user_id;
      if (result.status === 'fulfilled') {
        const { upserted, skipped } = result.value;
        totalUpserted += upserted;
        totalSkipped  += skipped;
        console.log(`  [crawler] ${userId}: upsert ${upserted}개, 스킵 ${skipped}개`);
      } else {
        console.error(`  [crawler] ${userId} 실패: ${result.reason?.message}`);
        totalFailed++;
      }
    });
  }

  console.log(`[crawler] 완료 → upsert ${totalUpserted}개, 스킵 ${totalSkipped}개, 실패 ${totalFailed}개`);
  return { upserted: totalUpserted, skipped: totalSkipped, failed: totalFailed };
}

module.exports = { getOAuthClient, getClientForUser, crawlAll };