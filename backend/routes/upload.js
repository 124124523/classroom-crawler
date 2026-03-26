// backend/routes/upload.js
const express    = require('express');
const router     = express.Router();
const cloudinary = require('cloudinary').v2;
const multer     = require('multer');

// ★ Railway Variables의 실제 변수명으로 통일
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
});

function runSingle(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('image')(req, res, err => err ? reject(err) : resolve());
  });
}

function runMultiple(req, res) {
  return new Promise((resolve, reject) => {
    upload.array('images', 10)(req, res, err => err ? reject(err) : resolve());
  });
}

async function uploadBuffer(buffer, mime, folder) {
  const uri    = `data:${mime};base64,${buffer.toString('base64')}`;
  const result = await cloudinary.uploader.upload(uri, {
    folder,
    transformation: [{ width: 1600, crop: 'limit', quality: 'auto' }],
  });
  return result.secure_url;
}

// ================================================================
// POST /api/upload/single  (이미지 1장)
// ================================================================
router.post('/single', async (req, res) => {
  try { await runSingle(req, res); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  if (!req.file) return res.status(400).json({ error: '이미지가 없습니다.' });
  if (!req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: '이미지 파일만 가능합니다.' });
  }

  try {
    const url = await uploadBuffer(req.file.buffer, req.file.mimetype, 'schoolboard');
    res.json({ success: true, url });
  } catch (e) {
    console.error('[upload/single]', e.message);
    res.status(500).json({ error: 'Cloudinary 오류: ' + e.message });
  }
});

// ================================================================
// POST /api/upload/multiple  (이미지 여러 장)
// ================================================================
router.post('/multiple', async (req, res) => {
  try { await runMultiple(req, res); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  if (!req.files?.length) return res.status(400).json({ error: '파일이 없습니다.' });

  try {
    const urls = await Promise.all(
      req.files.map(f => uploadBuffer(f.buffer, f.mimetype, 'schoolboard'))
    );
    res.json({ success: true, urls });
  } catch (e) {
    console.error('[upload/multiple]', e.message);
    res.status(500).json({ error: 'Cloudinary 오류: ' + e.message });
  }
});

// ================================================================
// POST /api/upload  (단일, 기존 호환용)
// ================================================================
router.post('/', async (req, res) => {
  try { await runSingle(req, res); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  if (!req.file) return res.status(400).json({ error: '이미지가 없습니다.' });

  try {
    const folder = req.body?.folder || 'schoolboard/notices';
    const url    = await uploadBuffer(req.file.buffer, req.file.mimetype, folder);
    res.json({ success: true, url });
  } catch (e) {
    res.status(500).json({ error: 'Cloudinary 오류: ' + e.message });
  }
});

module.exports = router;