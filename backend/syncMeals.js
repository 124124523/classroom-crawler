// backend/syncMeals.js
// NEIS 공식 API → school_meals 테이블 동기화
const pool = require('./db');

const NEIS_KEY    = process.env.NEIS_API_KEY;
const ATPT_CODE   = process.env.NEIS_ATPT_CODE;
const SCHOOL_CODE = process.env.NEIS_SCHOOL_CODE;

// ================================================================
// NEIS API에서 특정 월 급식 데이터 가져오기
// yyyymm: "202603" 형식
// ================================================================
async function fetchMealsFromNEIS(yyyymm) {
  if (!NEIS_KEY || !ATPT_CODE || !SCHOOL_CODE) {
    throw new Error('NEIS_API_KEY, NEIS_ATPT_CODE, NEIS_SCHOOL_CODE 환경변수가 필요합니다.');
  }

  // NEIS MLSV_YMD는 8자리(YYYYMMDD)만 인식 — 월 범위는 FROM/TO 파라미터 사용
  const year     = yyyymm.slice(0, 4);
  const month    = yyyymm.slice(4, 6);
  const lastDay  = new Date(Number(year), Number(month), 0).getDate();
  const fromYmd  = `${yyyymm}01`;
  const toYmd    = `${yyyymm}${String(lastDay).padStart(2, '0')}`;

  const params = new URLSearchParams({
    KEY:                NEIS_KEY,
    Type:               'json',
    pIndex:             '1',
    pSize:              '100',
    ATPT_OFCDC_SC_CODE: ATPT_CODE,
    SD_SCHUL_CODE:      SCHOOL_CODE,
    MLSV_FROM_YMD:      fromYmd,
    MLSV_TO_YMD:        toYmd,
  });

  const url = `https://open.neis.go.kr/hub/mealServiceDietInfo?${params}`;
  console.log(`  [mealSync] NEIS 요청: ${fromYmd} ~ ${toYmd}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NEIS HTTP 오류: ${res.status}`);

  const data = await res.json();

  const info = data.mealServiceDietInfo;
  if (!info) {
    const code = data.RESULT?.CODE;
    if (code === 'INFO-200') {
      console.log(`  [mealSync] ${yyyymm}: 해당 기간 급식 데이터 없음`);
      return [];
    }
    throw new Error(`NEIS 응답 오류: ${JSON.stringify(data.RESULT || data)}`);
  }

  return info[1]?.row || [];
}

// ================================================================
// 급식 메뉴 문자열 정리
// NEIS: "잡곡밥<br/>된장찌개1.5.<br/>제육볶음10." 형식
// ================================================================
function parseMenu(ddishNm) {
  return ddishNm
    .replace(/<br\/>/gi, '\n')
    .replace(/\d+\./g, '')
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)
    .join('\n');
}

// ================================================================
// 특정 월 급식을 DB에 upsert
// school_meals ENUM: 'lunch' | 'dinner' 만 지원 (조식 스킵)
// ================================================================
async function syncMealsToDb(yyyymm) {
  const rows = await fetchMealsFromNEIS(yyyymm);

  let inserted = 0, failed = 0;

  for (const row of rows) {
    const rawDate     = row.MLSV_YMD;
    const date        = `${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`;
    const mealTypeKor = row.MMEAL_SC_NM;
    const menu        = parseMenu(row.DDISH_NM || '');

    // DB ENUM이 'lunch'|'dinner' 만 지원
    let meal_type;
    if (mealTypeKor === '중식')      meal_type = 'lunch';
    else if (mealTypeKor === '석식') meal_type = 'dinner';
    else {
      console.log(`  [mealSync] 스킵 (${date} ${mealTypeKor}): ENUM 미지원`);
      continue;
    }

    try {
      await pool.query(
        `INSERT INTO school_meals (date, meal_type, menu)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE menu = VALUES(menu)`,
        [date, meal_type, menu]
      );
      inserted++;
    } catch (e) {
      console.error(`  [mealSync] DB 오류 (${date} ${meal_type}):`, e.message);
      failed++;
    }
  }

  console.log(`  [mealSync] ${yyyymm} → 처리 ${inserted}건, 실패 ${failed}건`);
  return { inserted, failed, total: rows.length };
}

// ================================================================
// 이번 달 + 다음 달 동기화 (월말 대비)
// ================================================================
async function syncCurrentAndNextMonth() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = now.getMonth();

  const thisMonth = `${y}${String(m + 1).padStart(2, '0')}`;
  const nextMonth = m === 11
    ? `${y + 1}01`
    : `${y}${String(m + 2).padStart(2, '0')}`;

  console.log('[mealSync] 급식 동기화 시작 →', thisMonth, nextMonth);

  const r1 = await syncMealsToDb(thisMonth);
  const r2 = await syncMealsToDb(nextMonth);

  const result = {
    inserted: r1.inserted + r2.inserted,
    failed:   r1.failed   + r2.failed,
    total:    r1.total    + r2.total,
  };

  console.log(`[mealSync] 완료 → 총 ${result.total}건 처리, 실패 ${result.failed}건`);
  return result;
}

// ================================================================
// 학교 코드 조회 헬퍼
// 사용법: node -e "require('./syncMeals').findSchoolCode('대전대신고')"
// ================================================================
async function findSchoolCode(schoolName) {
  const params = new URLSearchParams({
    KEY:             NEIS_KEY,
    Type:            'json',
    SCHUL_NM:        schoolName,
    SCHUL_KND_SC_NM: '고등학교',
  });

  const res  = await fetch(`https://open.neis.go.kr/hub/schoolInfo?${params}`);
  const data = await res.json();
  const rows = data.schoolInfo?.[1]?.row || [];

  rows.forEach(r => {
    console.log(`학교명: ${r.SCHUL_NM}`);
    console.log(`  ATPT_OFCDC_SC_CODE: ${r.ATPT_OFCDC_SC_CODE}`);
    console.log(`  SD_SCHUL_CODE:      ${r.SD_SCHUL_CODE}`);
    console.log(`  주소: ${r.ORG_RDNMA}`);
    console.log('---');
  });

  return rows;
}

module.exports = { syncCurrentAndNextMonth, syncMealsToDb, findSchoolCode };