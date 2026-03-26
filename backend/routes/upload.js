// backend/routes/upload.js
const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;

// Cloudinary 설정 — Railway Variables에서 자동으로 읽어옴
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 파일을 메모리에 임시 저장 (디스크 저장 없이 Cloudinary로 바로 업로드)
const storage = multer.memoryStorage();
const upload  = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 최대 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('이미지 파일만 업로드 가능합니다.'));
    }
  },
});

// 파일 버퍼를 Cloudinary에 업로드하는 헬퍼 함수
function uploadToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: folder || 'schoolboard' },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// ── 이미지 1장 업로드 ────────────────────────────────
// POST /api/upload/single
router.post('/single', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '파일이 없습니다.' });
  try {
    const url = await uploadToCloudinary(req.file.buffer, 'schoolboard');
    res.json({ url });
  } catch (e) {
    console.error('[upload] single 오류:', e.message);
    res.status(500).json({ message: '업로드 실패' });
  }
});

// ── 이미지 여러 장 업로드 ────────────────────────────
// POST /api/upload/multiple
router.post('/multiple', upload.array('images', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ message: '파일이 없습니다.' });
  }
  try {
    const urls = await Promise.all(
      req.files.map(f => uploadToCloudinary(f.buffer, 'schoolboard'))
    );
    res.json({ urls });
  } catch (e) {
    console.error('[upload] multiple 오류:', e.message);
    res.status(500).json({ message: '업로드 실패' });
  }
});

module.exports = router;