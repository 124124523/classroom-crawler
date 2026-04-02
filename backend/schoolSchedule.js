// backend/schoolSchedule.js
// school_schedule 테이블 모델 + NEIS 학사일정 동기화
const db = require('./db');

let ensurePromise = null;

function ensureSchoolScheduleTable() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS school_schedule (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          date        DATE NOT NULL,
          event_name  VARCHAR(200) NOT NULL,
          class_yn    VARCHAR(20) NOT NULL DEFAULT '',
          grade3_yn   CHAR(1) NOT NULL DEFAULT 'Y',
          updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_schedule_date_name (date, event_name)
        )
      `);
    })().catch(err => {
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}

// 특정 월의 3학년 학사일정 조회
async function getScheduleByMonth(year, month) {
  await ensureSchoolScheduleTable();
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const [rows] = await db.query(
    `SELECT date, event_name AS name, class_yn AS classYn
       FROM school_schedule
      WHERE date BETWEEN ? AND ? AND grade3_yn = 'Y'
      ORDER BY date ASC`,
    [from, to]
  );
  return rows;
}

// NEIS API에서 학사일정을 가져와 DB에 저장 (특정 연-월)
async function syncScheduleMonth(year, month) {
  await ensureSchoolScheduleTable();

  const apiKey     = process.env.NEIS_API_KEY;
  const atptCode   = process.env.NEIS_ATPT_CODE;
  const schoolCode = process.env.NEIS_SCHOOL_CODE;

  if (!apiKey || !atptCode || !schoolCode) {
    console.warn('[schedule-sync] NEIS API 설정이 없습니다.');
    return { synced: 0 };
  }

  const from = `${year}${String(month).padStart(2, '0')}01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}${String(month).padStart(2, '0')}${String(lastDay).padStart(2, '0')}`;

  const url = `https://open.neis.go.kr/hub/SchoolSchedule?` +
    `KEY=${encodeURIComponent(apiKey)}` +
    `&Type=json&pIndex=1&pSize=100` +
    `&ATPT_OFCDC_SC_CODE=${encodeURIComponent(atptCode)}` +
    `&SD_SCHUL_CODE=${encodeURIComponent(schoolCode)}` +
    `&AA_FROM_YMD=${from}&AA_TO_YMD=${to}`;

  const response = await fetch(url);
  const data = await response.json();

  const rows = data?.SchoolSchedule?.[1]?.row || [];

  let synced = 0;
  for (const r of rows) {
    // 3학년 관련 이벤트만 저장
    if (r.THREE_GRADE_EVENT_YN !== 'Y') continue;

    const date = `${r.AA_YMD.slice(0, 4)}-${r.AA_YMD.slice(4, 6)}-${r.AA_YMD.slice(6, 8)}`;
    const eventName = r.EVENT_NM.trim();
    const classYn = r.SBTR_DD_SC_NM || '';

    await db.query(
      `INSERT INTO school_schedule (date, event_name, class_yn, grade3_yn)
       VALUES (?, ?, ?, 'Y')
       ON DUPLICATE KEY UPDATE
         class_yn = VALUES(class_yn),
         grade3_yn = VALUES(grade3_yn)`,
      [date, eventName, classYn]
    );
    synced++;
  }

  return { synced };
}

// 현재 월 ± 1개월 범위 동기화
async function syncScheduleRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based

  const months = [];
  // 이전 달
  if (month === 1) months.push([year - 1, 12]);
  else months.push([year, month - 1]);
  // 이번 달
  months.push([year, month]);
  // 다음 달
  if (month === 12) months.push([year + 1, 1]);
  else months.push([year, month + 1]);

  let total = 0;
  for (const [y, m] of months) {
    try {
      const result = await syncScheduleMonth(y, m);
      total += result.synced;
    } catch (e) {
      console.error(`[schedule-sync] ${y}-${m} 동기화 오류:`, e.message);
    }
  }
  return { total };
}

module.exports = {
  ensureSchoolScheduleTable,
  getScheduleByMonth,
  syncScheduleMonth,
  syncScheduleRange,
};
