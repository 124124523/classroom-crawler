// crawler/sync.js (Firestore 버전)
// coursework → assignments 동기화 + 수업명 매칭 로직
// 기존 backend/sync.js 의 로직을 그대로 보존하면서 MySQL → Firestore 로 전환

const { db, admin } = require('./firestore');

// 비학업 수업명 조기 스킵 패턴 (홈룸/창체/이전학년)
const SKIP_PATTERNS = [
  /학특사/,
  /홈룸|담임|창체|자율활동|자율시간/,
  /\d+학년\s*\d+반/,
  /^\d{4}\s+\d+-\d+(\s|$)/,
  /^20(2[0-4])[\s_]/,
];
function isSkippableCourse(courseName) {
  return SKIP_PATTERNS.some(p =>
    p instanceof RegExp ? p.test(courseName) : courseName.includes(p)
  );
}

// 키워드 기반 선생님 강제 매핑 (공동담당 분반)
const COURSE_KEYWORD_TEACHER_MAP = [
  { subjectKeyword: '고급물리학', courseKeyword: '수행', teacher: '박한준' },
  { subjectKeyword: '고급물리학', courseKeyword: '학기', teacher: '이윤경' },
];
function findTeacherByKeyword(courseName, matchedSubject) {
  if (!matchedSubject) return null;
  const subjNorm = matchedSubject.replace(/\s/g, '');
  const courseNorm = courseName.replace(/\s/g, '');
  for (const map of COURSE_KEYWORD_TEACHER_MAP) {
    if (subjNorm.includes(map.subjectKeyword.replace(/\s/g, '')) &&
        courseNorm.includes(map.courseKeyword)) {
      return map.teacher;
    }
  }
  return null;
}

// ── 캐시 (실행마다 1회만 로드) ─────────────────────────
let _classes = null, _subjects = null, _teachers = null;
async function loadAll() {
  const [csnap, ssnap] = await Promise.all([
    db.collection('classes').get(),
    db.collection('subjects').get(),
  ]);
  _classes = csnap.docs.map(d => ({ id: parseInt(d.id), ...d.data() }));
  _subjects = ssnap.docs.map(d => ({ id: parseInt(d.id), ...d.data() }));
  _teachers = [...new Set(
    _classes.filter(c => c.teacher).flatMap(c => c.teacher.split(',').map(t => t.trim()))
  )];
}

async function parseCourseName(courseName) {
  const subjects = _subjects;
  const teachers = _teachers;

  // 한글만 추출 → 과목명 매칭
  const koreanOnly = courseName
    .replace(/[A-Za-z0-9()（）\[\]_\-.,\s\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let matchedSubject = null;
  for (const subj of [...subjects].sort((a, b) => b.name.length - a.name.length)) {
    const subjNorm = subj.name.replace(/\s/g, '');
    const korNorm = koreanOnly.replace(/\s/g, '');
    if (korNorm.includes(subjNorm)) { matchedSubject = subj.name; break; }
  }

  let matchedTeacher = null;
  if (matchedSubject) {
    matchedTeacher = findTeacherByKeyword(courseName, matchedSubject);
    if (!matchedTeacher) {
      const subjNorm = matchedSubject.replace(/\s/g, '');
      const korNorm = koreanOnly.replace(/\s/g, '');
      const remaining = korNorm.replace(subjNorm, '');
      for (const teacher of [...teachers].sort((a, b) => b.length - a.length)) {
        if (remaining.includes(teacher)) { matchedTeacher = teacher; break; }
      }
      if (!matchedTeacher) {
        const bracketKor = courseName.match(/[(\（]([가-힣]{1,3})[)\）]/);
        if (bracketKor) {
          const found = teachers.find(t => t.startsWith(bracketKor[1]));
          if (found) matchedTeacher = found;
        }
      }
    }
  }

  // 분반코드 추출 (괄호/공백/하이픈 등 다양한 패턴)
  let matchedClass = null;
  const bracketMatch = courseName.match(/[(\（]([A-Za-z])\d*반?[)\）]/i);
  if (bracketMatch) matchedClass = bracketMatch[1].toUpperCase();
  if (!matchedClass) {
    const banMatch = courseName.match(/[\s_]([A-Z])반/i);
    if (banMatch) matchedClass = banMatch[1].toUpperCase();
  }
  if (!matchedClass) {
    const dashClass = courseName.match(/([A-Z])-class/i);
    if (dashClass) matchedClass = dashClass[1].toUpperCase();
  }
  if (!matchedClass) {
    const endMatch = courseName.match(/[\s_]([A-Z])\s*$/i);
    if (endMatch) matchedClass = endMatch[1].toUpperCase();
  }
  if (!matchedClass) {
    const glued = courseName.match(/[가-힣]([A-Z])(?:\s|$|[^a-zA-Z])/);
    if (glued) matchedClass = glued[1].toUpperCase();
  }
  if (!matchedClass) {
    const spaceMatch = courseName.match(/\s([A-Z])(?:\s*$|\s*\()/);
    if (spaceMatch) matchedClass = spaceMatch[1].toUpperCase();
  }

  return { matchedSubject, matchedTeacher, matchedClass };
}

async function findClassId(courseName) {
  const subjMap = {};
  _subjects.forEach(s => { subjMap[s.id] = s.name; });
  const classes = _classes.map(c => ({ ...c, subject_name: subjMap[c.subject_id] }));

  const { matchedSubject, matchedTeacher, matchedClass } = await parseCourseName(courseName);

  let bestMatch = null, bestScore = 0;
  const candidates = [];
  for (const cls of classes) {
    let score = 0;
    if (matchedSubject && cls.subject_name === matchedSubject) score++;
    if (matchedTeacher && cls.teacher) {
      const clsTeachers = cls.teacher.split(',').map(t => t.trim());
      if (clsTeachers.some(t => t === matchedTeacher || t.startsWith(matchedTeacher))) score++;
    }
    if (matchedClass && cls.class_code && cls.class_code.toUpperCase() === matchedClass) score++;

    if (score >= 2) {
      candidates.push({ cls, score });
      if (score > bestScore) { bestScore = score; bestMatch = cls; }
    }
  }

  const top = candidates.filter(c => c.score === bestScore);

  // 동점 → 분반코드 일치 우선
  if (top.length > 1 && matchedClass) {
    const byCode = top.filter(c => c.cls.class_code && c.cls.class_code.toUpperCase() === matchedClass);
    if (byCode.length === 1) return byCode[0].cls.id;
    return null;  // sibling 해소 시도
  }
  if (bestMatch) return bestMatch.id;

  // 폴백: 단일분반 과목
  if (matchedSubject) {
    const subjClasses = classes.filter(c => c.subject_name === matchedSubject);
    if (subjClasses.length === 1) return subjClasses[0].id;
  }
  return null;
}

async function resolveByUserSibling(fetchedBy, matchedSubject, allCourseworks) {
  if (!fetchedBy || !matchedSubject) return null;
  const siblings = allCourseworks.filter(c => c.fetched_by === fetchedBy);

  for (const sibling of siblings) {
    if (isSkippableCourse(sibling.course_name)) continue;
    const parsed = await parseCourseName(sibling.course_name);
    if (parsed.matchedSubject !== matchedSubject) continue;
    if (!parsed.matchedClass) continue;

    const subjMap = {};
    _subjects.forEach(s => { subjMap[s.id] = s.name; });
    const found = _classes
      .map(c => ({ ...c, subject_name: subjMap[c.subject_id] }))
      .filter(c => c.subject_name === matchedSubject &&
                   c.class_code && c.class_code.toUpperCase() === parsed.matchedClass);

    if (found.length === 1) return found[0].id;
  }
  return null;
}

async function ensureClassroomBot() {
  // Firestore 에서는 FK 가 없어 'classroom_bot' 학생 데이터가 강제되진 않지만
  // 일관성을 위해 사용자 문서를 보장
  const ref = db.collection('users').doc('classroom_bot');
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      name: '클래스룸봇',
      role: 'admin',
      class_num: null,
      firebase_uid: null,
      email: null,
    });
  }
}

const FS_BATCH_LIMIT = 450;

async function syncCourseworkToAssignments() {
  console.log('[sync] coursework → assignments 동기화 시작');
  await loadAll();
  await ensureClassroomBot();

  const t0 = Date.now();

  // 1) coursework + assignments 모두 한 번에 로드 (네트워크 호출 2회만 발생)
  const [cwSnap, aSnap] = await Promise.all([
    db.collection('coursework').get(),
    db.collection('assignments').get(),
  ]);

  const courseworks = cwSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.due_date && c.state === 'PUBLISHED');

  // 인덱스 1: gclassroom_id → 기존 assignment
  const existingByGid = {};
  // 인덱스 2: 중복 검사용 키 (class_id|title|date) → 존재 여부
  const dupKey = new Set();
  let maxAssignId = 0;
  for (const d of aSnap.docs) {
    const data = d.data();
    if (data.gclassroom_id) existingByGid[data.gclassroom_id] = { docId: d.id, ...data };
    const date = (data.deadline || '').slice(0, 10);
    dupKey.add(`${data.class_id}|${data.title}|${date}`);
    const n = parseInt(d.id);
    if (n > maxAssignId) maxAssignId = n;
  }

  // 2) 모든 coursework 처리 → 쓰기 작업을 메모리에 모음
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const updates = [];   // { ref, data }
  const inserts = [];   // { ref, data }
  let skipped = 0, failed = 0, skippedEarly = 0;

  for (const cw of courseworks) {
    try {
      if (isSkippableCourse(cw.course_name)) { skippedEarly++; continue; }

      let classId = await findClassId(cw.course_name);
      if (!classId && cw.fetched_by) {
        const { matchedSubject } = await parseCourseName(cw.course_name);
        if (matchedSubject) {
          classId = await resolveByUserSibling(cw.fetched_by, matchedSubject, courseworks);
        }
      }

      const existing = existingByGid[cw.coursework_id];
      if (existing) {
        // 변경 사항이 있을 때만 업데이트
        const upd = {};
        if (classId && existing.class_id !== classId) upd.class_id = classId;
        if (existing.deadline !== cw.due_date) upd.deadline = cw.due_date;
        if (Object.keys(upd).length > 0) {
          upd.updated_at = ts;
          updates.push({
            ref: db.collection('assignments').doc(existing.docId),
            data: upd,
          });
        }
        skipped++;
        continue;
      }

      if (!classId) { failed++; continue; }

      const targetDate = (cw.due_date || '').slice(0, 10);
      const key = `${classId}|${cw.title}|${targetDate}`;
      if (dupKey.has(key)) { skipped++; continue; }
      dupKey.add(key);  // 같은 sync 안에서도 중복 방지

      const content = [
        cw.description || '',
        cw.link ? `\n\n🔗 Google Classroom: ${cw.link}` : '',
      ].join('').trim();

      const newId = ++maxAssignId;
      inserts.push({
        ref: db.collection('assignments').doc(String(newId)),
        data: {
          id: newId,
          title: cw.title,
          content,
          writer: 'classroom_bot',
          class_id: classId,
          deadline: cw.due_date,
          gclassroom_id: cw.coursework_id,
          image_urls: null,
          created_at: ts,
          updated_at: ts,
        },
      });
    } catch (e) {
      console.error(`  [sync] 오류 (${cw.title}): ${e.message}`);
      failed++;
    }
  }

  // 3) 모든 쓰기를 450개씩 배치 commit, 배치들을 병렬로 처리
  await commitInChunks([...updates.map(u => ({ ...u, op: 'update' })), ...inserts.map(i => ({ ...i, op: 'set' }))]);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[sync] 완료 (${elapsed}초) → 추가 ${inserts.length}, 업데이트 ${updates.length}, 스킵 ${skipped}, 조기스킵 ${skippedEarly}, 실패 ${failed}`);
  return { inserted: inserts.length, skipped, skippedEarly, failed };
}

async function commitInChunks(ops) {
  if (!ops.length) return;
  const chunks = [];
  for (let i = 0; i < ops.length; i += FS_BATCH_LIMIT) {
    chunks.push(ops.slice(i, i + FS_BATCH_LIMIT));
  }
  await Promise.all(chunks.map(chunk => {
    const batch = db.batch();
    for (const op of chunk) {
      if (op.op === 'set') batch.set(op.ref, op.data);
      else batch.update(op.ref, op.data);
    }
    return batch.commit();
  }));
}

module.exports = { syncCourseworkToAssignments };
