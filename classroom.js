const { google } = require('googleapis');
const { getClientForUser } = require('./auth');
const pool = require('./db');

// 필터 ①②: 마감일이 있고, 2개월 전 이후(미래 포함)인지 확인
function isTargetWork(dueDate) {
  if (!dueDate) return false; // 마감일 없으면 제외

  const { year, month, day } = dueDate;
  const due = new Date(year, month - 1, day);

  const now = new Date();
  const twoMonthsAgo = new Date(now);
  twoMonthsAgo.setMonth(now.getMonth() - 2);

  return due >= twoMonthsAgo; // 2개월 전 이후면 포함 (미래도 포함)
}

// 필터 ③: 학생 제출 상태가 미완료인지 확인
// 제출 상태: NEW(미시작), CREATED(임시저장), TURNED_IN(제출완료), RETURNED(반환됨), RECLAIMED_BY_STUDENT(회수)
async function isIncomplete(classroom, courseId, workId) {
  try {
    const { data: { studentSubmissions = [] } } = await classroom.courses.courseWork.studentSubmissions.list({
      courseId,
      courseWorkId: workId,
      userId: 'me',
    });

    if (studentSubmissions.length === 0) return true; // 제출 정보 없으면 미완료로 간주

    const state = studentSubmissions[0].state;
    // TURNED_IN(제출완료), RETURNED(반환/채점완료)은 완료로 간주 → 제외
    return state !== 'TURNED_IN' && state !== 'RETURNED';
  } catch {
    return true; // 오류 시 미완료로 간주하여 포함
  }
}

async function crawlUser(userId) {
  const auth = await getClientForUser(userId);
  const classroom = google.classroom({ version: 'v1', auth });

  const { data: { courses = [] } } = await classroom.courses.list();

  let savedCount = 0;
  let skippedCount = 0;
  let filteredCount = 0;

  for (const course of courses) {
    const { data: { courseWork = [] } } = await classroom.courses.courseWork.list({
      courseId: course.id,
    }).catch(() => ({ data: { courseWork: [] } }));

    for (const work of courseWork) {
      // 필터 ①②: 마감일 없거나 2개월 이전 과제 제외
      if (!isTargetWork(work.dueDate)) {
        filteredCount++;
        continue;
      }

      // 필터 ③: 이미 제출 완료된 과제 제외
      const incomplete = await isIncomplete(classroom, course.id, work.id);
      if (!incomplete) {
        filteredCount++;
        continue;
      }

      const dueDate = `${work.dueDate.year}-${String(work.dueDate.month).padStart(2,'0')}-${String(work.dueDate.day).padStart(2,'0')}`;

      const [cwExisting] = await pool.query(
        'SELECT coursework_id FROM coursework WHERE coursework_id = ? AND user_id = ?',
        [work.id, userId]
      );

      if (cwExisting.length === 0) {
        await pool.query(
          `INSERT INTO coursework (user_id, course_id, course_name, coursework_id, title, due_date, state)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, course.id, course.name, work.id, work.title, dueDate, work.state]
        );
        savedCount++;
      } else {
        skippedCount++;
      }
    }
  }

  return `${userId} 완료 (새 과제 ${savedCount}개, 스킵 ${skippedCount}개, 필터 제외 ${filteredCount}개)`;
}

async function crawlAll() {
  const [rows] = await pool.query('SELECT user_id FROM tokens');
  const results = [];

  for (const row of rows) {
    try {
      console.log(`[crawl-all] 시작: ${row.user_id}`);
      const result = await crawlUser(row.user_id);
      console.log(`[crawl-all] ${result}`);
      results.push({ userId: row.user_id, status: 'ok', result });
    } catch (err) {
      console.error(`[crawl-all] 실패: ${row.user_id} - ${err.message}`);
      results.push({ userId: row.user_id, status: 'error', message: err.message });
    }
  }

  return results;
}

module.exports = { crawlAll, crawlUser };