const { google } = require('googleapis');
const { getClientForUser } = require('./auth');
const pool = require('./db');

async function crawlUser(userId) {
  const auth = await getClientForUser(userId);
  const classroom = google.classroom({ version: 'v1', auth });

  const { data: { courses = [] } } = await classroom.courses.list();

  let savedCount = 0;

  for (const course of courses) {
    const { data: { courseWork = [] } } = await classroom.courses.courseWork.list({
      courseId: course.id,
    }).catch(() => ({ data: { courseWork: [] } }));

    for (const work of courseWork) {
      // 2026년 과제만 필터링
      if (!work.dueDate || work.dueDate.year !== 2026) continue;

      const dueDate = `2026-${String(work.dueDate.month).padStart(2,'0')}-${String(work.dueDate.day).padStart(2,'0')}`;

      await pool.query(
        `INSERT INTO coursework (user_id, course_id, course_name, coursework_id, title, due_date, state)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title),
           due_date = VALUES(due_date),
           state = VALUES(state),
           course_name = VALUES(course_name)`,
        [userId, course.id, course.name, work.id, work.title, dueDate, work.state]
      );
      savedCount++;
    }
  }

  return `${userId} 완료 (수업 ${courses.length}개, 2026년 과제 ${savedCount}개 저장)`;
}

async function crawlAll() {
  const [rows] = await pool.query('SELECT user_id FROM tokens');
  const results = [];

  for (const row of rows) {
    try {
      const result = await crawlUser(row.user_id);
      results.push({ userId: row.user_id, status: 'ok', result });
    } catch (err) {
      results.push({ userId: row.user_id, status: 'error', message: err.message });
    }
  }

  return results;
}

module.exports = { crawlAll, crawlUser };