// backend/routes/schedule.js — 학사일정 API (DB 캐시 기반)
const express = require('express');
const router  = express.Router();
const { getScheduleByMonth, syncScheduleMonth } = require('../schoolSchedule');

function requireLogin(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }
  next();
}

// GET /api/schedule?year=2026&month=4
// DB에서 3학년 학사일정 조회 (캐시 miss 시 NEIS에서 동기화 후 반환)
router.get('/', requireLogin, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  try {
    let events = await getScheduleByMonth(year, month);

    // DB에 해당 월 데이터가 없으면 NEIS에서 가져와서 저장
    if (!events.length) {
      try {
        await syncScheduleMonth(year, month);
        events = await getScheduleByMonth(year, month);
      } catch (e) {
        console.error('[schedule] NEIS 동기화 실패:', e.message);
      }
    }

    res.json({ events });
  } catch (err) {
    console.error('[schedule] DB 조회 오류:', err.message);
    res.status(500).json({ message: '학사일정 조회 실패' });
  }
});

module.exports = router;
