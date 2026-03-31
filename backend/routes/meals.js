// backend/routes/meals.js
// Instagram 급식 사진 API (meal_day_images 테이블)
const express = require('express');
const {
  ensureMealDayImagesTable,
  getMealImageByDate,
  listMealImages,
  listMealImagesByRange,
  upsertMealImage,
  deleteMealImageById,
} = require('../mealDayImages');

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ message: '로그인이 필요합니다.' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session?.user?.role !== 'admin') return res.status(403).json({ message: '관리자 권한이 필요합니다.' });
  next();
}

// KST 오늘 날짜 반환 (서버는 UTC 환경)
function getTodayInKst() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const partMap = {};
  for (const part of parts) {
    if (part.type !== 'literal') partMap[part.type] = part.value;
  }
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

// 서버 시작 시 테이블 자동 생성
ensureMealDayImagesTable().catch(err => {
  console.error('[meals] 테이블 초기화 실패:', err.message);
});

// GET /api/meals?date=YYYY-MM-DD — 특정 날짜 급식 사진
router.get('/', requireLogin, async (req, res) => {
  const date = req.query.date || getTodayInKst();

  try {
    const row = await getMealImageByDate(date);

    res.json({
      date,
      has_data: Boolean(row),
      image_url: row?.image_url || null,
      week_label: row?.week_label || null,
      source_caption: row?.source_caption || null,
      source_post_code: row?.source_post_code || null,
      source_taken_at: row?.source_taken_at || null,
    });
  } catch (err) {
    console.error('[meals] GET 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/meals/list — 최근 60건 (관리자용)
router.get('/list', requireAdmin, async (req, res) => {
  try {
    const rows = await listMealImages(60);
    res.json(rows);
  } catch (err) {
    console.error('[meals] GET /list 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/meals/range?from=YYYY-MM-DD&to=YYYY-MM-DD — 날짜 범위 급식 사진
router.get('/range', requireLogin, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ message: 'from, to 값이 필요합니다.' });
  }

  try {
    const rows = await listMealImagesByRange(from, to);
    res.json({ from, to, rows });
  } catch (err) {
    console.error('[meals] GET /range 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/meals — 급식 사진 등록/수정 (관리자)
router.post('/', requireAdmin, async (req, res) => {
  const {
    date,
    image_url,
    week_label,
    source_caption,
    source_post_code,
    source_taken_at,
    source_slide_index,
  } = req.body;

  if (!date || !image_url || !week_label || !source_caption || !source_post_code || !source_taken_at || source_slide_index == null) {
    return res.status(400).json({ message: '필수 필드가 부족합니다.' });
  }

  try {
    await upsertMealImage({
      date,
      image_url,
      week_label,
      source_caption,
      source_post_code,
      source_taken_at,
      source_slide_index,
    });
    res.json({ message: '등록되었습니다.' });
  } catch (err) {
    console.error('[meals] POST 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// DELETE /api/meals/:id (관리자)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await deleteMealImageById(req.params.id);
    res.json({ message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[meals] DELETE 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

module.exports = router;
