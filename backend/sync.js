// backend/sync.js
// coursework 테이블 → assignments 테이블 동기화
const pool = require('./db');

// 과목명 유사도 체크
function subjectNameMatch(courseName, subjectName) {
  const c = courseName.replace(/\s/g, '').toLowerCase();
  const s = subjectName.replace(/\s/g, '').toLowerCase();
  if (c.includes(s) || s.includes(c)) return true;
  const pureC = c.replace(/[A-Za-z0-9\s]/g, '');
  const pureS = s.replace(/\s/g, '');
  if (pureC.length >= 1 && pureS.startsWith(pureC)) return true;
  return false;
}

// 분반 코드 추출
function extractClassCode(courseName) {
  const match = courseName.match(/([A-Z]\d)\s*반?\s*$/i);
  if (match) return match[1].toUpperCase();
  const single = courseName.match(/([A-Z])\s*반?\s*$/i);
  if (single) return single[1].toUpperCase();
  const spaceMatch = courseName.match(/\s([A-Z]\d?)(?:\s|반|$)/i);
  if (spaceMatch) return spaceMatch[1].toUpperCase();
  return null;
}

// 선생님 이름 매칭
function teacherMatch(courseName, teacherStr) {
  if (!teacherStr) return false;
  const c = courseName.replace(/\s/g, '');
  const teachers = teacherStr.split(',').map(t => t.trim());
  const subjectChars = '수학문화영어화학물리학생명과학지구사회논리심리교육윤리비교보건경제정보탐구방법';

  return teachers.some(teacher => {
    if (c.includes(teacher)) return true;
    const lastName = teacher.charAt(0);
    if (c.includes(lastName)) {
      if (!subjectChars.includes(lastName)) return true;
      if (c.includes(teacher.slice(0, 2))) return true;
    }
    return false;
  });
}

// course_name → class_id 스코어링 (2/3 이상 매칭)
async function findClassId(courseName) {
  const [classes] = await pool.query(`
    SELECT c.id, c.class_code, c.teacher, s.name AS subject_name
    FROM classes c JOIN subjects s ON c.subject_id = s.id
  `);

  const extractedCode = extractClassCode(courseName);
  let bestMatch = null;
  let bestScore = 0;
  const candidates = [];

  for (const cls of classes) {
    let score = 0;
    const reasons = [];

    if (extractedCode && cls.class_code.toUpperCase() === extractedCode) {
      score++; reasons.push(`분반(${extractedCode})`);
    }
    if (subjectNameMatch(courseName, cls.subject_name)) {
      score++; reasons.push(`과목명(${cls.subject_name})`);
    }
    if (teacherMatch(courseName, cls.teacher)) {
      score++; reasons.push(`선생님(${cls.teacher})`);
    }

    if (score >= 2) {
      candidates.push({ cls, score, reasons });
      if (score > bestScore) { bestScore = score; bestMatch = cls; }
    }
  }

  const topCandidates = candidates.filter(c => c.score === bestScore);
  if (topCandidates.length > 1) {
    console.warn(`  [sync] ⚠️ "${courseName}" 후보 ${topCandidates.length}개 (점수: ${bestScore})`);
    topCandidates.forEach(c =>
      console.warn(`    → class_id=${c.cls.id} [${c.cls.subject_name} ${c.cls.class_code}반] ${c.reasons.join(', ')}`)
    );
  } else if (bestMatch) {
    console.log(`  [sync] ✅ "${courseName}" → ${bestMatch.subject_name} ${bestMatch.class_code}반 (${topCandidates[0].reasons.join(', ')})`);
  } else {
    console.warn(`  [sync] ❌ "${courseName}" → 매칭 실패`);
  }

  return bestMatch ? bestMatch.id : null;
}

// coursework → assignments 동기화
async function syncCourseworkToAssignments() {
  console.log('[sync] coursework → assignments 동기화 시작');

  const [courseworks] = await pool.query(`
    SELECT coursework_id, course_name, title, description, due_date, link
    FROM coursework
    WHERE due_date IS NOT NULL AND state = 'PUBLISHED'
  `);

  let inserted = 0, skipped = 0, failed = 0;

  for (const cw of courseworks) {
    try {
      // 이미 sync된 항목 스킵
      const [existing] = await pool.query(
        'SELECT id FROM assignments WHERE gclassroom_id = ?', [cw.coursework_id]
      );
      if (existing.length > 0) { skipped++; continue; }

      const classId = await findClassId(cw.course_name);
      if (!classId) { failed++; continue; }

      // content에 설명 + 링크 포함
      const content = [
        cw.description || '',
        cw.link ? `\n\n🔗 Google Classroom: ${cw.link}` : '',
      ].join('').trim();

      await pool.query(
        `INSERT INTO assignments (title, content, writer, class_id, deadline, gclassroom_id)
         VALUES (?, ?, 'classroom_bot', ?, ?, ?)`,
        [cw.title, content, classId, cw.due_date, cw.coursework_id]
      );
      inserted++;
    } catch (err) {
      console.error(`  [sync] 오류 (${cw.title}): ${err.message}`);
      failed++;
    }
  }

  console.log(`[sync] 완료 → 추가 ${inserted}개, 스킵 ${skipped}개, 실패 ${failed}개`);
  return { inserted, skipped, failed };
}

module.exports = { syncCourseworkToAssignments, findClassId };

