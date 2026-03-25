const { google } = require('googleapis');
const { getClientForUser } = require('./auth');
const { extractAndSaveMaterials } = require('./materials');
const pool = require('./db');

async function crawlUser(userId) {
  const auth = await getClientForUser(userId);
  const classroom = google.classroom({ version: 'v1', auth });

  const { data: { courses = [] } } = await classroom.courses.list();

  let savedCount = 0;
  let skippedCount = 0;
  let materialCount = 0;

  for (const course of courses) {
    const { data: { courseWork = [] } } = await classroom.courses.courseWork.list({
      courseId: course.id,
    }).catch(() => ({ data: { courseWork: [] } }));

    for (const work of courseWork) {
      // 마감일이 있는데 2026년이 아니면 스킵 (2025년 이전 과제 제외)
      // 마감일 없는 과제는 포함 (선생님 참고자료 등)
      if (work.dueDate && work.dueDate.year !== 2026) continue;

      const dueDate = work.dueDate
        ? `2026-${String(work.dueDate.month).padStart(2,'0')}-${String(work.dueDate.day).padStart(2,'0')}`
        : null;

      // ✅ 최적화 ③: 이미 저장된 coursework는 DB 쿼리 스킵
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

      // materials 추출 (내부에서 이미 추출된 파일은 자동 스킵)
      try {
        const matResult = await extractAndSaveMaterials(auth, userId, course.id, work);
        materialCount += matResult.saved;
        if (matResult.saved > 0) {
          console.log(`  [${userId}] "${work.title}" → 파일 ${matResult.saved}개 저장, ${matResult.skipped}개 스킵`);
        }
      } catch (err) {
        console.error(`  [${userId}] materials 오류 (${work.title}): ${err.message}`);
      }
    }
  }

  return `${userId} 완료 (새 과제 ${savedCount}개, 스킵 ${skippedCount}개, 새 파일 ${materialCount}개)`;
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