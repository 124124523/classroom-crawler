const express = require('express');
const router = express.Router();
const pool = require('../db');

function requireLogin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: '로그인 필요' });
  next();
}

// GET /api/meals?date=2026-03-26 - 특정 날짜 급식
router.get('/', requireLogin, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const [rows] = await pool.query(
      'SELECT * FROM school_meals WHERE date = ? ORDER BY meal_type ASC',
      [date]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meals/week - 이번 주 급식
router.get('/week', requireLogin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM school_meals
      WHERE date BETWEEN DATE(DATE_SUB(NOW(), INTERVAL WEEKDAY(NOW()) DAY))
                     AND DATE(DATE_ADD(DATE_SUB(NOW(), INTERVAL WEEKDAY(NOW()) DAY), INTERVAL 4 DAY))
      ORDER BY date ASC, meal_type ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals - 급식 등록 (어드민)
router.post('/', requireLogin, async (req, res) => {
  if (req.session.userRole !== 'admin')
    return res.status(403).json({ error: '권한 없음' });

  const { date, mealType, menu } = req.body;
  if (!date || !mealType || !menu)
    return res.status(400).json({ error: 'date, mealType, menu 필요' });

  try {
    await pool.query(
      `INSERT INTO school_meals (date, meal_type, menu)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE menu = VALUES(menu)`,
      [date, mealType, menu]
    );
    res.json({ message: '급식 등록 완료' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;