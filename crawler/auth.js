// crawler/auth.js
require('dotenv').config();
const { google } = require('googleapis');
const pool = require('./db');

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

// ── 마감일 파싱 ──────────────────────────────────────
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

// ── 한 계정의 coursework 크롤링 ───────────────────────
async function crawlForUser(userId) {
  const auth      = await getClientForUser(userId);
  const classroom = google.classroom({ version: 'v1', auth });

  const courseRes = await classroom.courses.list({
    studentId:    'me',
    courseStates: ['ACTIVE'],
    pageSize:     50,
  });

  const courses = courseRes.data.courses || [];
  console.log(`  [crawler] ${userId}: 수업 ${courses.length}개`);

  let upserted = 0, skipped = 0;

  for (const course of courses) {
    try {
      const cwRes = await classroom.courses.courseWork.list({
        courseId: course.id,
        orderBy:  'dueDate asc',
        pageSize: 50,
      });

      for (const cw of (cwRes.data.courseWork || [])) {
        const { date: dueDate, time: dueTime } = parseDueDate(cw.dueDate, cw.dueTime);
        if (!dueDate) { skipped++; continue; }

        await pool.query(
          `INSERT INTO coursework
             (coursework_id, course_id, course_name, title, description, due_date, due_time, state, link, fetched_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             course_name = VALUES(course_name),
             title       = VALUES(title),
             description = VALUES(description),
             due_date    = VALUES(due_date),
             due_time    = VALUES(due_time),
             state       = VALUES(state),
             link        = VALUES(link),
             fetched_by  = VALUES(fetched_by)`,
          [
            cw.id, course.id, course.name,
            cw.title, cw.description || null,
            dueDate, dueTime,
            cw.state || 'PUBLISHED',
            cw.alternateLink || null,
            userId,
          ]
        );
        upserted++;
      }
    } catch (e) {
      console.error(`  [crawler] ${userId} 수업(${course.name}) 오류: ${e.message}`);
    }
  }

  return { upserted, skipped };
}

// ── 전체 크롤링 (모든 tokens 계정) ───────────────────
async function crawlAll() {
  console.log(`[crawler] 시작: ${new Date().toLocaleString('ko-KR')}`);

  const [tokenRows] = await pool.query('SELECT user_id FROM tokens');
  if (!tokenRows.length) {
    console.warn('[crawler] tokens 테이블이 비어 있습니다. 구글 인증을 먼저 진행하세요.');
    return { upserted: 0, skipped: 0, failed: 0 };
  }

  let totalUpserted = 0, totalSkipped = 0, totalFailed = 0;

  for (const { user_id } of tokenRows) {
    try {
      const { upserted, skipped } = await crawlForUser(user_id);
      totalUpserted += upserted;
      totalSkipped  += skipped;
      console.log(`  [crawler] ${user_id}: upsert ${upserted}개, 스킵 ${skipped}개`);
    } catch (e) {
      console.error(`  [crawler] ${user_id} 실패: ${e.message}`);
      totalFailed++;
    }
  }

  console.log(`[crawler] 완료 → upsert ${totalUpserted}개, 스킵 ${totalSkipped}개, 실패 ${totalFailed}개`);
  return { upserted: totalUpserted, skipped: totalSkipped, failed: totalFailed };
}

module.exports = { getOAuthClient, getClientForUser, crawlAll };