const { google } = require('googleapis');
const { getClientForUser } = require('./auth');
const pool = require('./db');

async function crawlUser(userId) {
  const auth = await getClientForUser(userId);
  const classroom = google.classroom({ version: 'v1', auth });

  // 수업 목록 가져오기
  const { data: { courses = [] } } = await classroom.courses.list();

  for (const course of courses) {
    // 각 수업의 과제 가져오기
    const { data: { courseWork = [] } } = await classroom.courses.courseWork.list({
      courseId: course.id,
    }).catch(() => ({ data: { courseWork: [] } }));

    for (const work of courseWork) {
      const dueDate = work.dueDate
        ? `${work.dueDate.year}-${String(work.dueDate.month).padStart(2,'0')}-${String(work.dueDate.day).padStart(2,'0')}`
        : null;

      await pool.query(
        `INSERT INTO coursework (user_id, course_id, course_name, coursework_id, title, due_date, state)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE title = VALUES(title), due_date = VALUES(due_date), state = VALUES(state)`,
        [userId, course.id, course.name, work.id, work.title, dueDate, work.state]
      );
    }
  }

  return `${userId} 완료 (수업 ${courses.length}개)`;
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