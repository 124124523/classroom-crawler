const { google } = require('googleapis');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const pool = require('./db');

const SUPPORTED_TYPES = {
  'application/vnd.google-apps.document':     'google_docs',
  'application/vnd.google-apps.spreadsheet':  'google_sheets',
  'application/pdf':                           'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
  'application/vnd.ms-excel':                 'excel',
};

// ✅ 최적화 ②: 저장할 최대 글자 수 (약 10KB, DB 공간 절약)
const MAX_CONTENT_LENGTH = 20000;

async function extractAndSaveMaterials(auth, userId, courseId, work) {
  const materials = work.materials || [];
  if (materials.length === 0) return { saved: 0, skipped: 0, errors: [] };

  const drive = google.drive({ version: 'v3', auth });
  let saved = 0, skipped = 0;
  const errors = [];

  for (const material of materials) {
    const driveFile = material.driveFile?.driveFile;
    if (!driveFile) { skipped++; continue; }

    const fileId = driveFile.id;
    const title  = driveFile.title || 'Untitled';
    const materialId = `${work.id}_${fileId}`;

    // ✅ 최적화 ①: 이미 추출된 파일은 다운로드/파싱 자체를 스킵
    try {
      const [existing] = await pool.query(
        'SELECT id FROM materials WHERE id = ? AND content IS NOT NULL',
        [materialId]
      );
      if (existing.length > 0) {
        console.log(`  [skip] 이미 추출됨: ${title}`);
        skipped++;
        continue;
      }
    } catch (_) {}

    try {
      const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType' });
      const mimeType = meta.data.mimeType;
      const type = SUPPORTED_TYPES[mimeType] || 'other';

      let content = null;

      if (type === 'google_docs')   content = await exportGoogleDoc(drive, fileId);
      else if (type === 'google_sheets') content = await exportGoogleSheet(drive, fileId);
      else if (type === 'pdf')      content = await extractPdf(drive, fileId);
      else if (type === 'excel')    content = await extractExcel(drive, fileId);
      else skipped++;

      // ✅ 최적화 ②: content 길이 제한
      if (content && content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH) + '\n...(이하 생략)';
      }

      await pool.query(
        `INSERT INTO materials
           (id, coursework_id, course_id, user_id, title, type, drive_file_id, mime_type, content, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           title = VALUES(title), content = VALUES(content), extracted_at = NOW()`,
        [materialId, work.id, courseId, userId, title, type, fileId, mimeType, content]
      );
      saved++;

    } catch (err) {
      errors.push({ fileId, title, error: err.message });
      console.error(`  [materials] ❌ ${title}: ${err.message}`);
    }
  }

  return { saved, skipped, errors };
}

// ── 추출 헬퍼 ────────────────────────────────────────

async function exportGoogleDoc(drive, fileId) {
  const res = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data).toString('utf-8').trim();
}

async function exportGoogleSheet(drive, fileId) {
  const res = await drive.files.export(
    { fileId, mimeType: 'text/csv' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data).toString('utf-8').trim();
}

async function extractPdf(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  const parsed = await pdfParse(Buffer.from(res.data));
  return parsed.text.trim();
}

async function extractExcel(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  const workbook = XLSX.read(Buffer.from(res.data), { type: 'buffer' });
  return workbook.SheetNames.map((name) => {
    return `[Sheet: ${name}]\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`;
  }).join('\n\n').trim();
}

module.exports = { extractAndSaveMaterials };