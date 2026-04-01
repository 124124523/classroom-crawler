// backend/sync.js
const pool = require('./db');

// ================================================================
// [Fix A] 비학업 수업명 조기 스킵 패턴
// ================================================================
// 구글 클래스룸에는 교과 수업 외에도 홈룸·학년행사·이전학년 수업이
// 섞여 들어온다. 이 패턴에 해당하면 parseCourseName 자체를 호출하지
// 않고 조용히 skippedEarly 카운터만 올린다 (console 출력 없음).
//
// 패턴 추가 방법: SKIP_PATTERNS 배열에 RegExp 또는 string을 추가.
const SKIP_PATTERNS = [
  /학특사/,                           // 학년 특색 활동
  /홈룸|담임|창체|자율활동|자율시간/,    // 행정·창의체험
  /\d+학년\s*\d+반/,                  // "3학년 4반" 형식 홈룸
  /^\d{4}\s+\d+-\d+(\s|$)/,          // "2026 3-4 ..." 형식
  /^20(2[0-4])[\s_]/,                // 2024년 이전 수업 ("2024 ...", "2023_...")
];

function isSkippableCourse(courseName) {
  return SKIP_PATTERNS.some(p =>
    p instanceof RegExp ? p.test(courseName) : courseName.includes(p)
  );
}

// ================================================================
// 수업명 키워드 → 선생님 강제 매핑
// 구글 클래스룸 수업명에 선생님 이름이 없거나 공동 담당일 때 사용
// ================================================================
const COURSE_KEYWORD_TEACHER_MAP = [
  // 고급물리학: "수행" 포함 → 박한준, "학기" 포함 → 이윤경
  { subjectKeyword: '고급물리학', courseKeyword: '수행', teacher: '박한준' },
  { subjectKeyword: '고급물리학', courseKeyword: '학기', teacher: '이윤경' },
];

function findTeacherByKeyword(courseName, matchedSubject) {
  if (!matchedSubject) return null;
  const subjNorm   = matchedSubject.replace(/\s/g, '');
  const courseNorm = courseName.replace(/\s/g, '');
  for (const map of COURSE_KEYWORD_TEACHER_MAP) {
    if (
      subjNorm.includes(map.subjectKeyword.replace(/\s/g, '')) &&
      courseNorm.includes(map.courseKeyword)
    ) {
      return map.teacher;
    }
  }
  return null;
}

// ── DB에서 선생님 목록 캐시 ────────────────────────────
let teacherCache = null;
async function getTeachers() {
  if (teacherCache) return teacherCache;
  const [rows] = await pool.query(
    'SELECT DISTINCT teacher FROM classes WHERE teacher IS NOT NULL'
  );
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
  for (const subj of [...subjects].sort((a, b) => b.name.length - a.name.length)) {
    const subjNorm = subj.name.replace(/\s/g, '');
    const korNorm  = koreanOnly.replace(/\s/g, '');
    if (korNorm.includes(subjNorm)) {
      matchedSubject = subj.name;
      break;
    }
  }

  // ── 패턴2: 선생님 매칭 ─────────────────────────────────
  let matchedTeacher = null;
  if (matchedSubject) {
    // ① 키워드 매핑 우선 (공동담당 과목 구분용)
    matchedTeacher = findTeacherByKeyword(courseName, matchedSubject);

    if (!matchedTeacher) {
      const subjNorm  = matchedSubject.replace(/\s/g, '');
      const korNorm   = koreanOnly.replace(/\s/g, '');
      const remaining = korNorm.replace(subjNorm, '');

      // ② 한글 잔여에서 풀네임 매칭 (긴 이름 먼저)
      for (const teacher of [...teachers].sort((a, b) => b.length - a.length)) {
        if (remaining.includes(teacher)) {
          matchedTeacher = teacher;
          break;
        }
      }

      // ③ 괄호 안 한글 성씨: (최) → 최슬기
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
  if (bracketMatch) matchedClass = bracketMatch[1].toUpperCase();

  // "알파벳반" 패턴 (괄호 밖): A반, B반_선생님
  if (!matchedClass) {
    const banMatch = courseName.match(/[\s_]([A-Z])반/i);
    if (banMatch) matchedClass = banMatch[1].toUpperCase();
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
// 반환값:
//   number  → 단일 분반으로 확정됨
//   null    → 매칭 실패 or 동점 ambiguous (호출부에서 sibling 해소 시도)
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

    if (matchedSubject && cls.subject_name === matchedSubject) {
      score++; reasons.push(`과목명(${matchedSubject})`);
    }
    if (matchedTeacher && cls.teacher) {
      const clsTeachers = cls.teacher.split(',').map(t => t.trim());
      if (clsTeachers.some(t => t === matchedTeacher || t.startsWith(matchedTeacher))) {
        score++; reasons.push(`선생님(${matchedTeacher})`);
      }
    }
    if (matchedClass && cls.class_code.toUpperCase() === matchedClass) {
      score++; reasons.push(`분반(${matchedClass})`);
    }

    if (score >= 2) {
      candidates.push({ cls, score, reasons });
      if (score > bestScore) { bestScore = score; bestMatch = cls; }
    }
  }

  const topCandidates = candidates.filter(c => c.score === bestScore);

  // ── [Fix B] 동점 타이브레이커: 분반코드 일치 후보를 우선 선택 ──
  // 예) "월5(E반)2026이경규_화법과작문"
  //   → C반(과목+선생님) vs E반(과목+분반) 동점 2점
  //   → matchedClass=E → E반 단독 선택
  if (topCandidates.length > 1) {
    if (matchedClass) {
      const byCode = topCandidates.filter(
        c => c.cls.class_code.toUpperCase() === matchedClass
      );
      if (byCode.length === 1) {
        const winner = byCode[0].cls;
        console.log(
          `  [sync] ✅ "${courseName}" → ${winner.subject_name} ${winner.class_code}반 ` +
          `(타이브레이커: 분반코드, ${byCode[0].reasons.join(', ')})`
        );
        return winner.id;
      }
    }

    // 타이브레이커로도 좁히지 못하면 null 반환 → 호출부에서 sibling 해소 시도
    console.warn(
      `  [sync] ⚠️  "${courseName}" 후보 ${topCandidates.length}개 → sibling 해소 시도`
    );
    return null;

  } else if (bestMatch) {
    console.log(
      `  [sync] ✅ "${courseName}" → ` +
      `${bestMatch.subject_name} ${bestMatch.class_code}반 ` +
      `(${topCandidates[0].reasons.join(', ')})`
    );
    return bestMatch.id;

  } else if (matchedSubject) {
    // 폴백: 해당 과목 분반이 DB에 1개뿐이면 자동 매칭
    const subjClasses = classes.filter(c => c.subject_name === matchedSubject);
    if (subjClasses.length === 1) {
      const only = subjClasses[0];
      console.log(
        `  [sync] ✅ "${courseName}" → ` +
        `${only.subject_name} ${only.class_code}반 (단일분반 폴백)`
      );
      return only.id;
    }
    console.warn(
      `  [sync] ❌ "${courseName}" → 매칭 실패 ` +
      `(과목:${matchedSubject} 선생님:${matchedTeacher || '?'} 분반:${matchedClass || '?'})`
    );
  }

  return null;
}

// ================================================================
// [Fix C] resolveByUserSibling — 동일 사용자 sibling으로 분반 해소
// ================================================================
// 배경:
//   같은 학생의 구글 클래스룸에 보통 두 수업이 함께 존재한다.
//     "고급 물리학(수행) C-class"  ← 분반코드 C 명시 → findClassId 확정
//     "고급물리학(2026-1학기)"      ← 분반코드 없음   → findClassId null
//
//   전자(sibling)로 후자의 분반을 해소한다.
//   같은 fetched_by 유저의 다른 coursework 중, 동일 과목(matchedSubject)에서
//   분반코드가 추출 가능한 수업을 찾아 단일 class_id를 반환한다.
async function resolveByUserSibling(fetchedBy, matchedSubject, allCourseworks) {
  if (!fetchedBy || !matchedSubject) return null;

  const siblings = allCourseworks.filter(c => c.fetched_by === fetchedBy);

  for (const sibling of siblings) {
    if (isSkippableCourse(sibling.course_name)) continue;

    const parsed = await parseCourseName(sibling.course_name);
    if (parsed.matchedSubject !== matchedSubject) continue;
    if (!parsed.matchedClass) continue;

    const [rows] = await pool.query(
      `SELECT c.id, c.class_code, s.name AS subject_name
       FROM classes c
       JOIN subjects s ON c.subject_id = s.id
       WHERE s.name = ? AND UPPER(c.class_code) = ?`,
      [matchedSubject, parsed.matchedClass]
    );

    if (rows.length === 1) {
      console.log(
        `  [sync] 🔗 sibling 해소: "${sibling.course_name}" (${fetchedBy}) ` +
        `→ ${rows[0].subject_name} ${rows[0].class_code}반`
      );
      return rows[0].id;
    }
  }

  return null;
}

// ================================================================
// [Fix A] classroom_bot 계정 보장
// ================================================================
// assignments.writer → users.id FK 제약 때문에
// users 테이블에 classroom_bot이 없으면 모든 INSERT가 FK 오류로 실패한다.
// DB 초기화 후에도 sync 실행 시점에 자동 복구한다.
async function ensureClassroomBot() {
  try {
    await pool.query(
      `INSERT IGNORE INTO users (id, password, name, role)
       VALUES ('classroom_bot', 'DISABLED', '클래스룸봇', 'admin')`
    );
  } catch (e) {
    console.warn('[sync] classroom_bot 계정 보장 실패:', e.message);
  }
}

// ================================================================
// syncCourseworkToAssignments
// ================================================================
async function syncCourseworkToAssignments() {
  console.log('[sync] coursework → assignments 동기화 시작');

  // 캐시 초기화 (매 실행마다 최신 DB 반영)
  teacherCache = null;
  subjectCache = null;

  // [Fix A] FK 오류 원천 차단 — classroom_bot 존재 보장
  await ensureClassroomBot();

  // fetched_by 포함 조회 — [Fix C] sibling 해소에 필요
  const [courseworks] = await pool.query(`
    SELECT coursework_id, course_name, title, description, due_date, link, fetched_by
    FROM coursework
    WHERE due_date IS NOT NULL AND state = 'PUBLISHED'
  `);

  let inserted = 0, skipped = 0, failed = 0, skippedEarly = 0;

  for (const cw of courseworks) {
    try {

      // ── [Fix A] 비학업 수업명 조기 스킵 ────────────────────────
      // 홈룸·행정·이전학년 수업은 console 출력 없이 조용히 넘긴다
      if (isSkippableCourse(cw.course_name)) {
        skippedEarly++;
        continue;
      }

      // ── 1단계: 수업명 직접 매칭 ─────────────────────────────────
      let classId = await findClassId(cw.course_name);

      // ── [Fix C] 2단계: ambiguous → 동일 유저 sibling으로 해소 ───
      if (!classId && cw.fetched_by) {
        const { matchedSubject } = await parseCourseName(cw.course_name);
        if (matchedSubject) {
          classId = await resolveByUserSibling(
            cw.fetched_by, matchedSubject, courseworks
          );
        }
      }

      // ── 기존 레코드 확인 ────────────────────────────────────────
      const [existing] = await pool.query(
        'SELECT id, class_id FROM assignments WHERE gclassroom_id = ?',
        [cw.coursework_id]
      );

      if (existing.length > 0) {
        // 이미 존재 — class_id 또는 deadline이 바뀐 경우 업데이트
        const updates = [];
        const params  = [];

        if (classId && existing[0].class_id !== classId) {
          updates.push('class_id = ?');
          params.push(classId);
        }
        // 크롤러에서 가져온 마감일시로 항상 갱신 (시간 정보 반영)
        updates.push('deadline = ?');
        params.push(cw.due_date);

        if (updates.length) {
          params.push(cw.coursework_id);
          await pool.query(
            `UPDATE assignments SET ${updates.join(', ')} WHERE gclassroom_id = ?`,
            params
          );
        }
        skipped++;
        continue;
      }

      // 신규 — classId 없으면 failed 처리
      if (!classId) { failed++; continue; }

      // ── [Fix D] 동일 과제 중복 삽입 방지 ─────────────────
      // 같은 과제가 다른 구글 클래스룸 섹션에 게시되면
      // coursework_id는 다르지만 title+class_id+deadline 날짜가 동일 → 중복
      const [dupCheck] = await pool.query(
        `SELECT id FROM assignments
         WHERE class_id = ? AND title = ? AND DATE(deadline) = DATE(?)
         LIMIT 1`,
        [classId, cw.title, cw.due_date]
      );
      if (dupCheck.length > 0) {
        skipped++;
        continue;
      }

      const content = [
        cw.description || '',
        cw.link ? `\n\n🔗 Google Classroom: ${cw.link}` : '',
      ].join('').trim();

      await pool.query(
        `INSERT INTO assignments
           (title, content, writer, class_id, deadline, gclassroom_id)
         VALUES (?, ?, 'classroom_bot', ?, ?, ?)`,
        [cw.title, content, classId, cw.due_date, cw.coursework_id]
      );
      inserted++;

    } catch (err) {
      console.error(`  [sync] 오류 (${cw.title}): ${err.message}`);
      failed++;
    }
  }

  console.log(
    `[sync] 완료 → 추가 ${inserted}개, 스킵 ${skipped}개, ` +
    `조기스킵 ${skippedEarly}개, 실패 ${failed}개`
  );
  return { inserted, skipped, skippedEarly, failed };
}

module.exports = { syncCourseworkToAssignments, findClassId };