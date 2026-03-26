// backend/routes/meals.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ================================================================
// GET /api/meals
// ?date=YYYY-MM-DD  → 해당 날짜 급식
// (없으면 오늘)
// ================================================================
router.get('/', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  db.query(
    "SELECT * FROM school_meals WHERE date = ? ORDER BY FIELD(meal_type,'lunch','dinner')",
    [date],
    (err, rows) => {
      if (err) return res.status(500).json({ message: '서버 오류' });

      // frontend가 { meals: { lunch: {...}, dinner: {...} } } 형태를 기대
      const meals = {};
      rows.forEach(r => {
        meals[r.meal_type] = {
          menu:     r.menu,
          calories: r.calories || null,
        };
      });

      res.json({ date, meals });
    }
  );
});

// ================================================================
// GET /api/meals/list — 최근 60건 (관리자용)
// ================================================================
router.get('/list', (req, res) => {
  db.query(
    "SELECT * FROM school_meals ORDER BY date DESC, FIELD(meal_type,'lunch','dinner') LIMIT 60",
    (err, rows) => {
      if (err) return res.status(500).json({ message: '서버 오류' });
      res.json(rows);
    }
  );
});

// ================================================================
// POST /api/meals — 급식 등록/수정 (upsert)
// ================================================================
router.post('/', (req, res) => {
  const { date, meal_type, menu } = req.body;
  if (!date || !meal_type || !menu) {
    return res.status(400).json({ message: 'date, meal_type, menu 필드가 필요합니다.' });
  }

  db.query(
    'INSERT INTO school_meals (date, meal_type, menu) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE menu = ?',
    [date, meal_type, menu, menu],
    (err, r) => {
      if (err) return res.status(500).json({ message: '서버 오류' });
      res.json({ message: '등록되었습니다.', id: r.insertId });
    }
  );
});

// ================================================================
// DELETE /api/meals/:id
// ================================================================
router.delete('/:id', (req, res) => {
  db.query('DELETE FROM school_meals WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ message: '서버 오류' });
    res.json({ message: '삭제되었습니다.' });
  });
});

module.exports = router;