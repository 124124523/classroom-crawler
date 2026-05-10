// NEIS 학사일정 API → Firestore school_schedule 동기화
// 향후 6개월치 일정을 가져와서 매일 1회 동기화한다.
// API: https://open.neis.go.kr/hub/SchoolSchedule

require('dotenv').config();
const { db } = require('./firestore');

const NEIS_BASE = 'https://open.neis.go.kr/hub/SchoolSchedule';

async function fetchNeisRange(fromYmd, toYmd, pageIndex = 1) {
  const params = new URLSearchParams({
    KEY: process.env.NEIS_API_KEY,
    Type: 'json',
    pIndex: String(pageIndex),
    pSize: '1000',
    ATPT_OFCDC_SC_CODE: process.env.NEIS_ATPT_CODE,
    SD_SCHUL_CODE: process.env.NEIS_SCHOOL_CODE,
    AA_FROM_YMD: fromYmd,
    AA_TO_YMD: toYmd,
  });
  const url = `${NEIS_BASE}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NEIS API HTTP ${res.status}`);
  const data = await res.json();
  // NEIS 응답 구조: { SchoolSchedule: [{head:[...]},{row:[...]}] }
  // 자료 없을 시: { RESULT: { CODE: 'INFO-200', MESSAGE: '데이터없음' } }
  const arr = data?.SchoolSchedule;
  if (!arr) return [];
  const rowEntry = arr.find(e => e.row);
  return rowEntry?.row || [];
}

function classifyEvent(eventName) {
  // 수업 여부 판단: 시험/방학/체육행사 등은 수업 안 함
  const noClassPatterns = ['방학', '재량휴업', '체육대회', '시험', '수능', '대학별', '학력평가'];
  const isNoClass = noClassPatterns.some(p => eventName.includes(p));
  return isNoClass ? '수업안함' : '수업';
}

async function syncNeisSchedule() {
  console.log('[neis] 학사일정 동기화 시작');
  if (!process.env.NEIS_API_KEY || !process.env.NEIS_ATPT_CODE || !process.env.NEIS_SCHOOL_CODE) {
    console.warn('[neis] NEIS_* 환경변수가 없습니다. 건너뜀.');
    return { fetched: 0, written: 0 };
  }

  const today = new Date();
  const kst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
  const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

  const from = ymd(kst);
  // 6개월 후
  const toDate = new Date(kst.getTime() + 180 * 24 * 60 * 60 * 1000);
  const to = ymd(toDate);

  console.log(`[neis] 조회 범위: ${from} ~ ${to}`);

  // 페이지네이션 (1000개씩)
  const allRows = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await fetchNeisRange(from, to, page);
    if (rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`[neis] 가져온 일정: ${allRows.length}개`);

  if (allRows.length === 0) return { fetched: 0, written: 0 };

  // Firestore 배치 쓰기 (450개씩)
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let maxId = 0;
  const existingSnap = await db.collection('school_schedule').get();
  existingSnap.docs.forEach(d => { const n = parseInt(d.id); if (n > maxId) maxId = n; });

  // 기존 인덱스 (date + event_name → docId) — 중복 방지
  const existing = {};
  existingSnap.docs.forEach(d => {
    const data = d.data();
    const key = `${data.date}|${data.event_name}`;
    existing[key] = d.id;
  });

  let written = 0;
  const BATCH = 450;
  for (let i = 0; i < allRows.length; i += BATCH) {
    const chunk = allRows.slice(i, i + BATCH);
    const batch = db.batch();
    for (const r of chunk) {
      const date = `${r.AA_YMD.slice(0, 4)}-${r.AA_YMD.slice(4, 6)}-${r.AA_YMD.slice(6, 8)}`;
      const eventName = r.EVENT_NM;
      const classYn = classifyEvent(eventName);

      const key = `${date}|${eventName}`;
      const docId = existing[key] || String(++maxId);
      batch.set(db.collection('school_schedule').doc(docId), {
        id: parseInt(docId),
        date,
        event_name: eventName,
        class_yn: classYn,
        grade3_yn: 'Y',
        updated_at: ts,
      }, { merge: true });
      written++;
    }
    await batch.commit();
  }

  console.log(`[neis] 완료 → ${written}개 일정 동기화`);
  return { fetched: allRows.length, written };
}

module.exports = { syncNeisSchedule };

// 단독 실행 시
if (require.main === module) {
  syncNeisSchedule()
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
