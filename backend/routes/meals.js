// backend/routes/meals.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/meals?date=YYYY-MM-DD
router.get('/', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  try {
    const [rows] = await db.query(
      "SELECT * FROM school_meals WHERE date = ? ORDER BY FIELD(meal_type,'lunch','dinner')",
      [date]
    );

    const meals = {};
    rows.forEach(r => {
      meals[r.meal_type] = {
        menu:     r.menu,
        calories: r.calories || null,
      };
    });

    res.json({ date, meals });
  } catch (err) {
    console.error('[meals] GET 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// GET /api/meals/list — 최근 60건 (관리자용)
router.get('/list', async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM school_meals ORDER BY date DESC, FIELD(meal_type,'lunch','dinner') LIMIT 60"
    );
    res.json(rows);
  } catch (err) {
    console.error('[meals] GET /list 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// POST /api/meals — 급식 등록/수정 (upsert)
router.post('/', async (req, res) => {
  const { date, meal_type, menu } = req.body;
  if (!date || !meal_type || !menu) {
    return res.status(400).json({ message: 'date, meal_type, menu 필드가 필요합니다.' });
  }

  try {
    const [r] = await db.query(
      'INSERT INTO school_meals (date, meal_type, menu) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE menu = ?',
      [date, meal_type, menu, menu]
    );
    res.json({ message: '등록되었습니다.', id: r.insertId });
  } catch (err) {
    console.error('[meals] POST 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

// DELETE /api/meals/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM school_meals WHERE id = ?', [req.params.id]);
    res.json({ message: '삭제되었습니다.' });
  } catch (err) {
    console.error('[meals] DELETE 오류:', err.message);
    res.status(500).json({ message: '서버 오류' });
  }
});

module.exports = router;