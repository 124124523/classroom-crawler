// backend/routes/schedule.js — NEIS 학사일정 API
const express = require('express');
const router  = express.Router();

function requireLogin(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }
  next();
}

// GET /api/schedule?year=2026&month=4
// NEIS 학사일정 API에서 해당 월의 학사일정을 가져온다
router.get('/', requireLogin, async (req, res) => {
  const apiKey = process.env.NEIS_API_KEY;
  const atptCode = process.env.NEIS_ATPT_CODE;
  const schoolCode = process.env.NEIS_SCHOOL_CODE;

  if (!apiKey || !atptCode || !schoolCode) {
    return res.status(500).json({ message: 'NEIS API 설정이 없습니다.' });
  }

  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  // 해당 월의 시작일~종료일 (YYYYMMDD 형식)
  const from = `${year}${String(month).padStart(2, '0')}01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to   = `${year}${String(month).padStart(2, '0')}${String(lastDay).padStart(2, '0')}`;

  try {
    const url = `https://open.neis.go.kr/hub/SchoolSchedule?` +
      `KEY=${encodeURIComponent(apiKey)}` +
      `&Type=json&pIndex=1&pSize=100` +
      `&ATPT_OFCDC_SC_CODE=${encodeURIComponent(atptCode)}` +
      `&SD_SCHUL_CODE=${encodeURIComponent(schoolCode)}` +
      `&AA_FROM_YMD=${from}&AA_TO_YMD=${to}`;

    const response = await fetch(url);
    const data = await response.json();

    // NEIS API 응답 구조: { SchoolSchedule: [{ head: [...] }, { row: [...] }] }
    const rows = data?.SchoolSchedule?.[1]?.row || [];

    const events = rows.map(r => ({
      date: `${r.AA_YMD.slice(0,4)}-${r.AA_YMD.slice(4,6)}-${r.AA_YMD.slice(6,8)}`,
      name: r.EVENT_NM.trim(),
      // 수업 여부: 1=수업일, 2=휴업일, 3=공휴일
      classYn: r.SBTR_DD_SC_NM || '',
    }));

    res.json({ events });
  } catch (err) {
    console.error('[schedule] NEIS API 오류:', err.message);
    res.status(500).json({ message: 'NEIS API 호출 실패' });
  }
});

module.exports = router;
