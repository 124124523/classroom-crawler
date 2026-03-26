// backend/sync.js
const pool = require('./db');

// ================================================================
// 수업명 키워드 → 선생님 강제 매핑
// 구글 클래스룸 수업명에 선생님 이름이 없거나 공동 담당일 때 사용
// ================================================================
const COURSE_KEYWORD_TEACHER_MAP = [
  // 고급물리학: "수행" 포함 → 박한준, "학기" 포함 → 이윤경
  { subjectKeyword: '고급물리학', courseKeyword: '수행', teacher: '박한준' },
  { subjectKeyword: '고급물리학', courseKeyword: '학기', teacher: '이윤경' },
];

// 키워드 매핑으로 선생님 찾기
function findTeacherByKeyword(courseName, matchedSubject) {
  if (!matchedSubject) return null;
  const subjNorm   = matchedSubject.replace(/\s/g, '');
  const courseNorm = courseName.replace(/\s/g, '');
  for (const map of COURSE_KEYWORD_TEACHER_MAP) {
    if (subjNorm.includes(map.subjectKeyword.replace(/\s/g,'')) &&
        courseNorm.includes(map.courseKeyword)) {
      return map.teacher;
    }
  }
  return null;
}

// ── DB에서 선생님 목록 캐시 ────────────────────────────
let teacherCache = null;
async function getTeachers() {
  if (teacherCache) return teacherCache;
  const [rows] = await pool.query('SELECT DISTINCT teacher FROM classes WHERE teacher IS NOT NULL');
  // 쉼표로 구분된 복수 선생님도 분리해서 flat하게 보관
  teacherCache = [...new Set(
    rows.flatMap(r => r.teacher.split(',').map(t => t.trim()))
  )];
  return teacherCache;
}

// ── 과목 목록 캐시 ─────────────────────────────────────
let subjectCache = null;
async function getSubjects() {
  if (subjectCache) return subjectCache;
  const [rows] = await pool.query('SELECT id, name FROM subjects');
  subjectCache = rows;
  return subjectCache;
}

// ================================================================
// parseCourseName: 수업명 → { matchedSubject, matchedTeacher, matchedClass }
// 패턴1: 한글만 추출 → 과목명 매칭
// 패턴2: 한글에서 과목명 제거 → DB 선생님 목록과 대조
// 패턴3: 알파벳 추출 → 분반코드
// ================================================================
async function parseCourseName(courseName) {
  const subjects = await getSubjects();
  const teachers = await getTeachers();

  // ── 패턴1: 한글만 추출 → 과목명 매칭 ──────────────────
  const koreanOnly = courseName
    .replace(/[A-Za-z0-9()（）\[\]_\-.,\s\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let matchedSubject = null;
  // 긴 과목명 우선 매칭
  for (const subj of [...subjects].sort((a,b) => b.name.length - a.name.length)) {
    const subjNorm = subj.name.replace(/\s/g, '');
    const korNorm  = koreanOnly.replace(/\s/g, '');
    if (korNorm.includes(subjNorm)) {
      matchedSubject = subj.name;
      break;
    }
  }

  // ── 패턴2: 선생님 매칭 (키워드맵 → 풀네임 → 성씨) ───────
  let matchedTeacher = null;
  if (matchedSubject) {
    // ① 키워드 매핑 우선 (공동담당 과목 구분용)
    matchedTeacher = findTeacherByKeyword(courseName, matchedSubject);

    if (!matchedTeacher) {
      const subjNorm  = matchedSubject.replace(/\s/g, '');
      const korNorm   = koreanOnly.replace(/\s/g, '');
      const remaining = korNorm.replace(subjNorm, '');

      // ② 한글 잔여에서 풀네임 매칭 (긴 이름 먼저)
      for (const teacher of [...teachers].sort((a,b) => b.length - a.length)) {
        if (remaining.includes(teacher)) {
          matchedTeacher = teacher;
          break;
        }
      }

      // ③ 괄호 안 한글 성씨: D(최) → 최슬기
      if (!matchedTeacher) {
        const bracketKor = courseName.match(/[(\（]([가-힣]{1,3})[)\）]/);
        if (bracketKor) {
          const found = teachers.find(t => t.startsWith(bracketKor[1]));
          if (found) matchedTeacher = found;
        }
      }
    }
  }

  // ── 패턴3: 분반코드 추출 ──────────────────────────────
  let matchedClass = null;

  // 괄호 안 단독 알파벳: (C반), (C)
  const bracketMatch = courseName.match(/[(\（]([A-Za-z])\d*반?[)\）]/i);
  if (bracketMatch) {
    matchedClass = bracketMatch[1].toUpperCase();
  }

  // "알파벳-class" 패턴: B-class, A-class
  if (!matchedClass) {
    const dashClass = courseName.match(/([A-Z])-class/i);
    if (dashClass) matchedClass = dashClass[1].toUpperCase();
  }

  // 끝 단독 알파벳: 미적분_F, 수학 C
  if (!matchedClass) {
    const endMatch = courseName.match(/[\s_]([A-Z])\s*$/i);
    if (endMatch) matchedClass = endMatch[1].toUpperCase();
  }

  // 한글 뒤 바로 붙은 알파벳: 고급화학G
  if (!matchedClass) {
    const glued = courseName.match(/[가-힣]([A-Z])(?:\s|$|[^a-zA-Z])/);
    if (glued) matchedClass = glued[1].toUpperCase();
  }

  // 공백 뒤 단독 대문자: 영어독해와작문 E
  if (!matchedClass) {
    const spaceMatch = courseName.match(/\s([A-Z])(?:\s*$|\s*\()/);
    if (spaceMatch) matchedClass = spaceMatch[1].toUpperCase();
  }

  return { matchedSubject, matchedTeacher, matchedClass };
}

// ================================================================
// findClassId: parseCourseName 결과로 class_id 찾기
// ================================================================
async function findClassId(courseName) {
  const [classes] = await pool.query(`
    SELECT c.id, c.class_code, c.teacher, s.name AS subject_name
    FROM classes c JOIN subjects s ON c.subject_id = s.id
  `);

  const { matchedSubject, matchedTeacher, matchedClass } = await parseCourseName(courseName);

  let bestMatch = null;
  let bestScore = 0;
  const candidates = [];

  for (const cls of classes) {
    let score = 0;
    const reasons = [];

    // 과목명 일치
    if (matchedSubject && cls.subject_name === matchedSubject) {
      score++; reasons.push(`과목명(${matchedSubject})`);
    }

    // 선생님 일치 (복수 선생님 포함)
    if (matchedTeacher && cls.teacher) {
      const clsTeachers = cls.teacher.split(',').map(t => t.trim());
      if (clsTeachers.some(t => t === matchedTeacher || t.startsWith(matchedTeacher))) {
        score++; reasons.push(`선생님(${matchedTeacher})`);
      }
    }

    // 분반코드 일치
    if (matchedClass && cls.class_code.toUpperCase() === matchedClass) {
      score++; reasons.push(`분반(${matchedClass})`);
    }

    if (score >= 2) {
      candidates.push({ cls, score, reasons });
      if (score > bestScore) { bestScore = score; bestMatch = cls; }
    }
  }

  const topCandidates = candidates.filter(c => c.score === bestScore);

  if (topCandidates.length > 1) {
    console.warn(`  [sync] ⚠️  "${courseName}" 후보 ${topCandidates.length}개 (점수: ${bestScore}점)`);
    topCandidates.forEach(c =>
      console.warn(`    → class_id=${c.cls.id} [${c.cls.subject_name} ${c.cls.class_code}반] ${c.reasons.join(', ')}`)
    );
  } else if (bestMatch) {
    console.log(`  [sync] ✅ "${courseName}" → ${bestMatch.subject_name} ${bestMatch.class_code}반 (${topCandidates[0].reasons.join(', ')})`);
  } else if (matchedSubject) {
    // ── 폴백: 과목명만 1점이지만 해당 과목 분반이 DB에 1개뿐이면 자동 매칭 ──
    const subjClasses = classes.filter(c => c.subject_name === matchedSubject);
    if (subjClasses.length === 1) {
      const only = subjClasses[0];
      console.log(`  [sync] ✅ "${courseName}" → ${only.subject_name} ${only.class_code}반 (단일분반 폴백)`);
      return only.id;
    }
    console.warn(`  [sync] ❌ "${courseName}" → 매칭 실패 (과목:${matchedSubject||'?'} 선생님:${matchedTeacher||'?'} 분반:${matchedClass||'?'})`);
  } else {
    console.warn(`  [sync] ❌ "${courseName}" → 매칭 실패 (과목:${matchedSubject||'?'} 선생님:${matchedTeacher||'?'} 분반:${matchedClass||'?'})`);
  }

  return bestMatch ? bestMatch.id : null;
}

// ================================================================
// syncCourseworkToAssignments
// ================================================================
async function syncCourseworkToAssignments() {
  console.log('[sync] coursework → assignments 동기화 시작');

  // 캐시 초기화 (매 실행마다 최신 DB 반영)
  teacherCache = null;
  subjectCache = null;

  const [courseworks] = await pool.query(`
    SELECT coursework_id, course_name, title, description, due_date, link
    FROM coursework
    WHERE due_date IS NOT NULL AND state = 'PUBLISHED'
  `);

  let inserted = 0, skipped = 0, failed = 0;

  for (const cw of courseworks) {
    try {
      const [existing] = await pool.query(
        'SELECT id FROM assignments WHERE gclassroom_id = ?', [cw.coursework_id]
      );
      if (existing.length > 0) { skipped++; continue; }

      const classId = await findClassId(cw.course_name);
      if (!classId) { failed++; continue; }

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