// backend/mealDayImages.js
// meal_day_images 테이블 모델 (Instagram 급식 사진)
const db = require('./db');

let ensurePromise = null;

function ensureMealDayImagesTable() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS meal_day_images (
          id                INT AUTO_INCREMENT PRIMARY KEY,
          date              DATE NOT NULL,
          image_url         VARCHAR(2048) NOT NULL,
          week_label        VARCHAR(50) NOT NULL,
          source_post_code  VARCHAR(100) NOT NULL,
          source_caption    TEXT NOT NULL,
          source_taken_at   DATETIME NOT NULL,
          source_slide_index TINYINT NOT NULL,
          updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_meal_day_images_date (date),
          KEY idx_meal_day_images_post (source_post_code)
        )
      `);
    })().catch(err => {
      ensurePromise = null;
      throw err;
    });
  }

  return ensurePromise;
}

async function getMealImageByDate(date) {
  await ensureMealDayImagesTable();
  const [rows] = await db.query(
    `SELECT id, date, image_url, week_label, source_post_code, source_caption,
            source_taken_at, source_slide_index, updated_at
       FROM meal_day_images
      WHERE date = ?
      LIMIT 1`,
    [date]
  );
  return rows[0] || null;
}

async function getMealImagesByDates(dates) {
  await ensureMealDayImagesTable();
  if (!Array.isArray(dates) || !dates.length) return [];

  const placeholders = dates.map(() => '?').join(', ');
  const [rows] = await db.query(
    `SELECT id, date, image_url, week_label, source_post_code, source_caption,
            source_taken_at, source_slide_index, updated_at
       FROM meal_day_images
      WHERE date IN (${placeholders})`,
    dates
  );
  return rows;
}

async function listMealImages(limit = 60) {
  await ensureMealDayImagesTable();
  const safeLimit = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(200, Number(limit)))
    : 60;

  const [rows] = await db.query(
    `SELECT id, date, image_url, week_label, source_post_code, source_caption,
            source_taken_at, source_slide_index, updated_at
       FROM meal_day_images
      ORDER BY date DESC
      LIMIT ${safeLimit}`
  );
  return rows;
}

async function listMealImagesByRange(from, to) {
  await ensureMealDayImagesTable();
  const [rows] = await db.query(
    `SELECT id, date, image_url, week_label, source_post_code, source_caption,
            source_taken_at, source_slide_index, updated_at
       FROM meal_day_images
      WHERE date BETWEEN ? AND ?
      ORDER BY date ASC`,
    [from, to]
  );
  return rows;
}

async function upsertMealImage(record) {
  await ensureMealDayImagesTable();

  await db.query(
    `INSERT INTO meal_day_images
        (date, image_url, week_label, source_post_code, source_caption, source_taken_at, source_slide_index)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
        image_url = VALUES(image_url),
        week_label = VALUES(week_label),
        source_post_code = VALUES(source_post_code),
        source_caption = VALUES(source_caption),
        source_taken_at = VALUES(source_taken_at),
        source_slide_index = VALUES(source_slide_index)`,
    [
      record.date,
      record.image_url,
      record.week_label,
      record.source_post_code,
      record.source_caption,
      record.source_taken_at,
      record.source_slide_index,
    ]
  );
}

async function deleteMealImageById(id) {
  await ensureMealDayImagesTable();
  await db.query('DELETE FROM meal_day_images WHERE id = ?', [id]);
}

module.exports = {
  ensureMealDayImagesTable,
  getMealImageByDate,
  getMealImagesByDates,
  listMealImages,
  listMealImagesByRange,
  upsertMealImage,
  deleteMealImageById,
};
