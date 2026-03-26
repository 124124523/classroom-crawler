const { google } = require('googleapis');
const { getClientForUser } = require('./auth');
const pool = require('./db');

function getTwoMonthsAgo() {
  const d = new Date();
  d.setMonth(d.getMonth() - 2);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDate({ year, month, day }) {
  return new Date(year, month - 1, day);
}

async function isIncomplete(classroom, courseId, workId) {
  try {
    const { data: { studentSubmissions = [] } } = await classroom.courses.courseWork.studentSubmissions.list({
      courseId, courseWorkId: workId, userId: 'me',
    });
    if (studentSubmissions.length === 0) return true;
    const state = studentSubmissions[0].state;
    return state !== 'TURNED_IN' && state !== 'RETURNED';
  } catch {
    return true;
  }
}

async function crawlUser(userId) {
  const auth = await getClientForUser(userId);
  const classroom = google.classroom({ version: 'v1', auth });

  const { data: { courses = [] } } = await classroom.courses.list();

  const twoMonthsAgo = getTwoMonthsAgo();
  let savedCount = 0, skippedCount = 0, filteredCount = 0;

  for (const course of courses) {
    const { data: { courseWork = [] } } = await classroom.courses.courseWork.list({
      courseId: course.id,
    }).catch(() => ({ data: { courseWork: [] } }));

    // JS에서 최신순 정렬 (정확도 보장)
    const sorted = courseWork
      .filter(w => w.dueDate)
      .sort((a, b) => toDate(b.dueDate) - toDate(a.dueDate));

    for (const work of sorted) {
      const due = toDate(work.dueDate);

      // 2개월 이전 도달 시 중단
      if (due < twoMonthsAgo) {
        console.log(`  [${userId}] "${course.name}" → ${due.toLocaleDateString('ko-KR')} 이하, 중단`);
        break;
      }

      // 제출 완료 과제 제외
      const incomplete = await isIncomplete(classroom, course.id, work.id);
      if (!incomplete) { filteredCount++; continue; }

      const dueDate = `${work.dueDate.year}-${String(work.dueDate.month).padStart(2,'0')}-${String(work.dueDate.day).padStart(2,'0')}`;

      const [cwExisting] = await pool.query(
        'SELECT coursework_id FROM coursework WHERE coursework_id=? AND user_id=?',
        [work.id, userId]
      );

      if (cwExisting.length === 0) {
        await pool.query(
          `INSERT INTO coursework (user_id, course_id, course_name, coursework_id, title, due_date, state)
           VALUES (?,?,?,?,?,?,?)`,
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