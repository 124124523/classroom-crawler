// /api/* fetch 호출을 가로채서 Firestore SDK 호출로 변환
// 기존 페이지의 fetch('/api/...') 코드는 그대로 둔 채 이 shim 만 import 하면 동작한다.

import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit as fbLimit, serverTimestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

import { db, CLOUDINARY } from './firebase-init.js';
import {
  getCurrentUser, getMyMapping, logout as authLogout,
  changePassword as authChangePassword,
} from './auth.js';

// ─── 응답 헬퍼 ─────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function ok(extra = {}) { return json({ success: true, ...extra }); }
function err(message, status = 400) { return json({ success: false, message }, status); }

// ─── 공통 컨텍스트 ─────────────────────────────────────────
async function ctx() {
  const user = await getCurrentUser();
  if (!user) throw Object.assign(new Error('unauthorized'), { status: 401 });
  const mapping = await getMyMapping();
  if (!mapping) throw Object.assign(new Error('no mapping'), { status: 401 });
  return { user, mapping, legacyId: mapping.legacyId, role: mapping.role };
}

// 학생이 Classroom 동의했는지 (tokens 컬렉션에 본인 토큰이 있는지)
async function userHasClassroomToken(legacyId) {
  const q = query(collection(db, 'tokens'), where('user_id', '==', legacyId));
  const snap = await getDocs(q);
  return !snap.empty;
}

// ─── 라우터 ─────────────────────────────────────────────────
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

function matchPath(pattern, path) {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

// ─── 유틸 ───────────────────────────────────────────────────
async function getEnrolledClassIds(legacyId) {
  const q = query(collection(db, 'enrollments'), where('user_id', '==', legacyId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data().class_id);
}

async function chunkedIn(coll, field, values, extra = []) {
  // Firestore 'in' 쿼리는 30개 제한 → 여러 번 쪼갠다
  if (values.length === 0) return [];
  const out = [];
  for (let i = 0; i < values.length; i += 30) {
    const chunk = values.slice(i, i + 30);
    const q = query(collection(db, coll), where(field, 'in', chunk), ...extra);
    const snap = await getDocs(q);
    snap.docs.forEach(d => out.push({ id: d.id, ...d.data() }));
  }
  return out;
}

const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ─────────────────────────────────────────────────────────────
// Auth / Me
// ─────────────────────────────────────────────────────────────
route('GET', '/api/me', async () => {
  const c = await ctx();
  const hasConsent = c.role === 'student' ? await userHasClassroomToken(c.legacyId) : false;
  return json({
    id: c.legacyId,
    role: c.role,
    name: c.mapping.name,
    class_num: c.mapping.classNum,
    email: c.user.email,
    has_classroom_consent: hasConsent,
  });
});

route('POST', '/api/logout', async () => {
  await authLogout();
  return ok();
});

route('PUT', '/api/me/password', async ({ body }) => {
  try {
    await authChangePassword(body.current_password, body.new_password);
    return ok();
  } catch (e) {
    return err(e.message || '비밀번호 변경 실패', 400);
  }
});

// ─────────────────────────────────────────────────────────────
// Assignments
// ─────────────────────────────────────────────────────────────
route('GET', '/api/assignments', async ({ search }) => {
  const c = await ctx();
  const mine = search.get('mine') === 'true';

  let assignments = [];
  let classIds;

  if (mine && (c.role === 'leader' || c.role === 'teacher')) {
    // 본인이 담당하는 분반의 과제만 (간단히: 본인 작성 과제)
    const q = query(collection(db, 'assignments'), where('writer', '==', c.legacyId));
    const snap = await getDocs(q);
    assignments = snap.docs.map(d => ({ id: parseInt(d.id), ...d.data() }));
  } else if (c.role === 'student') {
    classIds = await getEnrolledClassIds(c.legacyId);
    if (classIds.length === 0) return json([]);
    assignments = await chunkedIn('assignments', 'class_id', classIds);
    assignments = assignments.map(a => ({ ...a, id: parseInt(a.id) }));
  } else {
    // admin/teacher: 모두
    const snap = await getDocs(collection(db, 'assignments'));
    assignments = snap.docs.map(d => ({ id: parseInt(d.id), ...d.data() }));
  }

  // 분반/과목 정보 join (writer 표시용)
  const classDocs = await getDocs(collection(db, 'classes'));
  const classMap = {};
  classDocs.docs.forEach(d => { classMap[d.id] = d.data(); });
  const subjectDocs = await getDocs(collection(db, 'subjects'));
  const subjectMap = {};
  subjectDocs.docs.forEach(d => { subjectMap[d.id] = d.data(); });

  // 학생의 완료 상태
  let completionMap = {};
  if (c.role === 'student') {
    const compSnap = await getDocs(query(
      collection(db, 'completions'),
      where('user_id', '==', c.legacyId),
      where('target_type', '==', 'assignment')
    ));
    compSnap.docs.forEach(d => { completionMap[d.data().target_id] = 1; });
  }

  const result = assignments.map(a => {
    const cls = classMap[a.class_id] || {};
    const subj = subjectMap[cls.subject_id] || {};
    return {
      id: a.id,
      title: a.title,
      content: a.content,
      writer: a.writer,
      class_id: a.class_id,
      deadline: a.deadline,
      image_urls: a.image_urls,
      gclassroom_id: a.gclassroom_id,
      created_at: a.created_at,
      updated_at: a.updated_at,
      subject_name: subj.name || '',
      class_code: cls.class_code || '',
      teacher: cls.teacher || '',
      category: subj.category || '일반',
      completed: completionMap[String(a.id)] ? 1 : 0,
    };
  });

  // 마감 3일 지난 과제는 목록에서 제외 (KST 기준)
  const cutoffMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
  let filtered = result.filter(a => {
    if (!a.deadline) return true;
    const iso = a.deadline.replace(' ', 'T') + '+09:00';
    const t = Date.parse(iso);
    if (isNaN(t)) return true;
    return t >= cutoffMs;
  });

  // 학생 + Classroom 동의 → 완료된 과제는 목록에서 자동 숨김
  if (c.role === 'student' && await userHasClassroomToken(c.legacyId)) {
    filtered = filtered.filter(a => Number(a.completed) !== 1);
  }

  filtered.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || ''));
  return json(filtered);
});

route('POST', '/api/assignments', async ({ body }) => {
  const c = await ctx();
  if (!['admin','teacher','leader'].includes(c.role)) return err('권한 없음', 403);
  // 새 ID 자동 생성 (현재 max id + 1)
  const snap = await getDocs(collection(db, 'assignments'));
  const maxId = snap.docs.reduce((m, d) => Math.max(m, parseInt(d.id) || 0), 0);
  const newId = String(maxId + 1);
  await setDoc(doc(db, 'assignments', newId), {
    id: maxId + 1,
    title: body.title,
    content: body.content || '',
    writer: c.legacyId,
    class_id: body.class_id,
    deadline: body.deadline || null,
    image_urls: body.image_urls || null,
    gclassroom_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  return ok({ id: maxId + 1 });
});

route('PUT', '/api/assignments/:id', async ({ params, body }) => {
  const c = await ctx();
  if (!['admin','teacher','leader'].includes(c.role)) return err('권한 없음', 403);
  const ref = doc(db, 'assignments', String(params.id));
  await updateDoc(ref, {
    ...body,
    updated_at: nowIso(),
  });
  return ok();
});

route('DELETE', '/api/assignments/:id', async ({ params }) => {
  const c = await ctx();
  if (!['admin','teacher','leader'].includes(c.role)) return err('권한 없음', 403);
  await deleteDoc(doc(db, 'assignments', String(params.id)));
  return ok();
});

route('GET', '/api/assignments/completion-stats', async () => {
  // 선생/관리자용: 과제별 완료 학생 수
  await ctx();
  const compSnap = await getDocs(query(collection(db, 'completions'), where('target_type', '==', 'assignment')));
  const stats = {};
  compSnap.docs.forEach(d => {
    const tid = d.data().target_id;
    stats[tid] = (stats[tid] || 0) + 1;
  });
  return json(stats);
});

// ─────────────────────────────────────────────────────────────
// Notices
// ─────────────────────────────────────────────────────────────
route('GET', '/api/notices', async ({ search }) => {
  const c = await ctx();
  const mine = search.get('mine') === 'true';
  let docs;
  if (mine) {
    const q = query(collection(db, 'notices'), where('writer', '==', c.legacyId));
    docs = (await getDocs(q)).docs;
  } else {
    docs = (await getDocs(collection(db, 'notices'))).docs;
  }
  const arr = docs.map(d => ({ id: parseInt(d.id), ...d.data() }));
  arr.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return json(arr);
});

route('POST', '/api/notices', async ({ body }) => {
  const c = await ctx();
  if (!['admin','teacher','leader'].includes(c.role)) return err('권한 없음', 403);
  const snap = await getDocs(collection(db, 'notices'));
  const maxId = snap.docs.reduce((m, d) => Math.max(m, parseInt(d.id) || 0), 0);
  const newId = String(maxId + 1);
  await setDoc(doc(db, 'notices', newId), {
    id: maxId + 1,
    title: body.title,
    content: body.content || '',
    writer: c.legacyId,
    class_id: body.class_id || null,
    image_urls: body.image_urls || null,
    target_class_num: body.target_class_num || null,
    created_at: nowIso(),
  });
  return ok({ id: maxId + 1 });
});

route('PUT', '/api/notices/:id', async ({ params, body }) => {
  const c = await ctx();
  if (!['admin','teacher','leader'].includes(c.role)) return err('권한 없음', 403);
  await updateDoc(doc(db, 'notices', String(params.id)), body);
  return ok();
});

route('DELETE', '/api/notices/:id', async ({ params }) => {
  const c = await ctx();
  if (!['admin','teacher','leader'].includes(c.role)) return err('권한 없음', 403);
  await deleteDoc(doc(db, 'notices', String(params.id)));
  return ok();
});

// ─────────────────────────────────────────────────────────────
// Comments (assignment_comments / notice_comments 통합)
// ─────────────────────────────────────────────────────────────
function commentColl(type) {
  return type === 'assignment' ? 'assignment_comments' : 'notice_comments';
}
function commentRefField(type) {
  return type === 'assignment' ? 'assignment_id' : 'notice_id';
}

route('GET', '/api/comments/:type/:id', async ({ params, search }) => {
  await ctx();
  const page = parseInt(search.get('page') || '1', 10);
  const lim = parseInt(search.get('limit') || '20', 10);
  const refId = parseInt(params.id, 10);
  const coll = commentColl(params.type);
  const fld = commentRefField(params.type);

  const q = query(collection(db, coll), where(fld, '==', refId));
  const snap = await getDocs(q);
  const all = snap.docs.map(d => ({ id: parseInt(d.id), ...d.data() }));
  all.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const start = (page - 1) * lim;
  return json({
    comments: all.slice(start, start + lim),
    total: all.length,
    page,
    limit: lim,
    hasMore: start + lim < all.length,
  });
});

route('POST', '/api/comments', async ({ body }) => {
  const c = await ctx();
  const { type, ref_id, content, parent_id } = body;
  const coll = commentColl(type);
  const fld = commentRefField(type);
  const snap = await getDocs(collection(db, coll));
  const maxId = snap.docs.reduce((m, d) => Math.max(m, parseInt(d.id) || 0), 0);
  const newId = String(maxId + 1);
  await setDoc(doc(db, coll, newId), {
    id: maxId + 1,
    [fld]: parseInt(ref_id),
    writer: c.legacyId,
    content,
    parent_id: parent_id ? parseInt(parent_id) : null,
    created_at: nowIso(),
  });
  return ok({ id: maxId + 1 });
});

route('POST', '/api/comments/read', async ({ body }) => {
  const c = await ctx();
  const { comment_id, ctype } = body;
  // 중복 방지를 위해 합성 ID 사용
  const docId = `${c.legacyId}_${ctype}_${comment_id}`;
  await setDoc(doc(db, 'comment_reads', docId), {
    user_id: c.legacyId,
    comment_id: parseInt(comment_id),
    ctype,
    read_at: nowIso(),
  }, { merge: true });
  return ok();
});

route('POST', '/api/comments/read-all', async ({ body }) => {
  const c = await ctx();
  const { type, ref_id } = body;
  const coll = commentColl(type);
  const fld = commentRefField(type);
  const snap = await getDocs(query(collection(db, coll), where(fld, '==', parseInt(ref_id))));
  for (const d of snap.docs) {
    const docId = `${c.legacyId}_${type}_${d.id}`;
    await setDoc(doc(db, 'comment_reads', docId), {
      user_id: c.legacyId,
      comment_id: parseInt(d.id),
      ctype: type,
      read_at: nowIso(),
    }, { merge: true });
  }
  return ok();
});

route('GET', '/api/comments/unread-summary', async () => {
  const c = await ctx();
  // 본인이 본 댓글 ID 셋
  const readSnap = await getDocs(query(collection(db, 'comment_reads'), where('user_id', '==', c.legacyId)));
  const readSet = new Set(readSnap.docs.map(d => `${d.data().ctype}_${d.data().comment_id}`));

  let total = 0;
  for (const t of ['assignment', 'notice']) {
    const coll = commentColl(t);
    const snap = await getDocs(collection(db, coll));
    for (const d of snap.docs) {
      const key = `${t}_${d.id}`;
      const writer = d.data().writer;
      if (writer !== c.legacyId && !readSet.has(key)) total++;
    }
  }
  return json({ unread_count: total });
});

route('GET', '/api/comments/unread-per-item', async () => {
  const c = await ctx();
  const readSnap = await getDocs(query(collection(db, 'comment_reads'), where('user_id', '==', c.legacyId)));
  const readSet = new Set(readSnap.docs.map(d => `${d.data().ctype}_${d.data().comment_id}`));

  const out = { assignments: {}, notices: {} };
  const aSnap = await getDocs(collection(db, 'assignment_comments'));
  for (const d of aSnap.docs) {
    if (d.data().writer === c.legacyId) continue;
    if (readSet.has(`assignment_${d.id}`)) continue;
    const key = String(d.data().assignment_id);
    out.assignments[key] = (out.assignments[key] || 0) + 1;
  }
  const nSnap = await getDocs(collection(db, 'notice_comments'));
  for (const d of nSnap.docs) {
    if (d.data().writer === c.legacyId) continue;
    if (readSet.has(`notice_${d.id}`)) continue;
    const key = String(d.data().notice_id);
    out.notices[key] = (out.notices[key] || 0) + 1;
  }
  return json(out);
});

// ─────────────────────────────────────────────────────────────
// Subjects / Classes
// ─────────────────────────────────────────────────────────────
route('GET', '/api/subjects', async () => {
  const c = await ctx();
  const subSnap = await getDocs(collection(db, 'subjects'));
  const clsSnap = await getDocs(collection(db, 'classes'));
  const enrSnap = c.role === 'student'
    ? await getDocs(query(collection(db, 'enrollments'), where('user_id', '==', c.legacyId)))
    : null;
  const enrolled = enrSnap ? new Set(enrSnap.docs.map(d => d.data().class_id)) : null;

  const subjects = subSnap.docs.map(d => ({ id: parseInt(d.id), ...d.data() }));
  const classes = clsSnap.docs.map(d => ({ id: parseInt(d.id), ...d.data() }));
  const result = subjects.map(s => {
    const subClasses = classes
      .filter(cl => cl.subject_id === s.id)
      .map(cl => ({
        ...cl,
        is_enrolled: enrolled ? enrolled.has(cl.id) : null,
      }));
    return { ...s, classes: subClasses };
  });
  return json(result);
});

route('GET', '/api/subjects/my-classes', async () => {
  const c = await ctx();
  // 본인 담당 분반: leader/teacher용 (writer 가 본인)
  // 단순화: enrollment 유사하게 처리. 실제 운영 데이터에 따라 필요시 보강.
  const clsSnap = await getDocs(collection(db, 'classes'));
  const subSnap = await getDocs(collection(db, 'subjects'));
  const subMap = {};
  subSnap.docs.forEach(d => { subMap[d.id] = d.data(); });

  // teacher/leader는 자기 이름과 매칭되는 class
  const classes = clsSnap.docs
    .map(d => ({ id: parseInt(d.id), ...d.data() }))
    .filter(cl => cl.teacher === c.mapping.name || c.role === 'admin');

  return json(classes.map(cl => ({
    ...cl,
    subject_name: subMap[cl.subject_id]?.name || '',
    category: subMap[cl.subject_id]?.category || '일반',
  })));
});

route('GET', '/api/subjects/classes/all', async () => {
  await ctx();
  const clsSnap = await getDocs(collection(db, 'classes'));
  const subSnap = await getDocs(collection(db, 'subjects'));
  const subMap = {};
  subSnap.docs.forEach(d => { subMap[d.id] = d.data(); });
  return json(clsSnap.docs.map(d => {
    const cl = d.data();
    return {
      id: parseInt(d.id),
      ...cl,
      subject_name: subMap[cl.subject_id]?.name || '',
      category: subMap[cl.subject_id]?.category || '일반',
    };
  }));
});

route('POST', '/api/subjects', async ({ body }) => {
  const c = await ctx();
  if (c.role !== 'admin') return err('권한 없음', 403);
  const snap = await getDocs(collection(db, 'subjects'));
  const maxId = snap.docs.reduce((m, d) => Math.max(m, parseInt(d.id) || 0), 0);
  const newId = String(maxId + 1);
  await setDoc(doc(db, 'subjects', newId), {
    id: maxId + 1,
    name: body.name,
    category: body.category || '일반',
  });
  return ok({ id: maxId + 1 });
});

route('DELETE', '/api/subjects/:id', async ({ params }) => {
  const c = await ctx();
  if (c.role !== 'admin') return err('권한 없음', 403);
  await deleteDoc(doc(db, 'subjects', String(params.id)));
  return ok();
});

// ─────────────────────────────────────────────────────────────
// Personal events / Timetable
// ─────────────────────────────────────────────────────────────
route('GET', '/api/timetable/personal', async () => {
  const c = await ctx();
  const q = query(collection(db, 'personal_events'), where('user_id', '==', c.legacyId));
  const snap = await getDocs(q);
  const arr = snap.docs.map(d => ({ id: parseInt(d.id), ...d.data() }));
  arr.sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
  return json(arr);
});

route('POST', '/api/timetable/personal', async ({ body }) => {
  const c = await ctx();
  const snap = await getDocs(collection(db, 'personal_events'));
  const maxId = snap.docs.reduce((m, d) => Math.max(m, parseInt(d.id) || 0), 0);
  const newId = String(maxId + 1);
  await setDoc(doc(db, 'personal_events', newId), {
    id: maxId + 1,
    user_id: c.legacyId,
    class_id: body.class_id || null,
    title: body.title,
    description: body.description || null,
    due_date: body.due_date || null,
    image_url: body.image_url || null,
    created_at: nowIso(),
  });
  return ok({ id: maxId + 1 });
});

route('DELETE', '/api/timetable/personal/:id', async ({ params }) => {
  await ctx();
  await deleteDoc(doc(db, 'personal_events', String(params.id)));
  return ok();
});

route('POST', '/api/timetable/complete', async ({ body }) => {
  const c = await ctx();
  const target_id = String(body.assignment_id ?? body.target_id);
  const target_type = body.target_type || 'assignment';
  const docId = `${c.legacyId}_${target_type}_${target_id}`;
  if (body.completed) {
    await setDoc(doc(db, 'completions', docId), {
      user_id: c.legacyId,
      target_type,
      target_id,
      completed_at: nowIso(),
    });
  } else {
    await deleteDoc(doc(db, 'completions', docId)).catch(() => {});
  }
  return ok();
});

route('GET', '/api/timetable', async () => {
  const c = await ctx();
  const snap = await getDoc(doc(db, 'timetables', c.legacyId));
  if (!snap.exists()) return json({ image_url: null });
  return json(snap.data());
});

// ─────────────────────────────────────────────────────────────
// Meals / School schedule
// ─────────────────────────────────────────────────────────────
route('GET', '/api/meals/range', async ({ search }) => {
  await ctx();
  const from = search.get('from');
  const to = search.get('to');
  const snap = await getDocs(query(
    collection(db, 'meal_day_images'),
    where('date', '>=', from),
    where('date', '<=', to)
  ));
  return json(snap.docs.map(d => d.data()));
});

route('GET', '/api/meals', async ({ search }) => {
  await ctx();
  const date = search.get('date');
  const snap = await getDoc(doc(db, 'meal_day_images', date));
  if (!snap.exists()) return json(null);
  return json(snap.data());
});

route('GET', '/api/schedule', async ({ search }) => {
  await ctx();
  const year = search.get('year');
  const month = String(search.get('month')).padStart(2, '0');
  const from = `${year}-${month}-01`;
  const to = `${year}-${month}-31`;
  const snap = await getDocs(query(
    collection(db, 'school_schedule'),
    where('date', '>=', from),
    where('date', '<=', to)
  ));
  return json(snap.docs.map(d => ({ id: parseInt(d.id), ...d.data() })));
});

// ─────────────────────────────────────────────────────────────
// Admin (관리자만 사용)
// ─────────────────────────────────────────────────────────────
route('GET', '/api/admin/users', async () => {
  const c = await ctx();
  if (c.role !== 'admin') return err('권한 없음', 403);
  const snap = await getDocs(collection(db, 'users'));
  return json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

route('GET', '/api/admin/active-users', async () => {
  const c = await ctx();
  if (c.role !== 'admin') return err('권한 없음', 403);
  // 최근 로그인 통계는 더 이상 추적하지 않음 → 빈 배열
  return json({ active: [], total_24h: 0 });
});

route('GET', '/api/admin/access-stats', async () => {
  const c = await ctx();
  if (c.role !== 'admin') return err('권한 없음', 403);
  return json({ daily: [], hourly: [] });  // 로그 수집 미구현
});

route('GET', '/api/admin/coverage', async () => {
  const c = await ctx();
  if (c.role !== 'admin') return err('권한 없음', 403);
  const tokSnap = await getDocs(collection(db, 'tokens'));
  return json({ total: tokSnap.size, accounts: tokSnap.docs.map(d => d.data().user_id) });
});

route('POST', '/api/classroom/sync', async () => {
  const c = await ctx();
  if (c.role !== 'admin') return err('권한 없음', 403);
  return err('크롤러는 GitHub Actions에서 자동 실행됩니다. 수동 실행은 미지원.', 200);
});

route('GET', '/api/classroom/auth-status', async () => {
  await ctx();
  const tokSnap = await getDocs(collection(db, 'tokens'));
  return json({ count: tokSnap.size });
});

// ─────────────────────────────────────────────────────────────
// Upload (Cloudinary unsigned upload 직접 호출)
// ─────────────────────────────────────────────────────────────
async function cloudinaryUpload(file) {
  if (!CLOUDINARY.cloudName || CLOUDINARY.cloudName === 'TODO_FILL_IN') {
    throw new Error('Cloudinary 설정 미완료 (firebase-init.js 의 CLOUDINARY 값을 채워주세요)');
  }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CLOUDINARY.uploadPreset);
  fd.append('folder', 'schoolboard');
  const res = await window.__originalFetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/image/upload`,
    { method: 'POST', body: fd }
  );
  if (!res.ok) throw new Error('Cloudinary 업로드 실패: ' + res.status);
  const data = await res.json();
  return data.secure_url;
}

// 기존 코드는 FormData 로 file/files 를 보냄.
// fetch 래퍼가 body 를 그대로 (FormData) 전달함.
route('POST', '/api/upload/single', async ({ body }) => {
  if (!(body instanceof FormData)) return err('FormData 가 아닙니다', 400);
  const file = body.get('image') || body.get('file');
  if (!file) return err('파일이 없습니다', 400);
  const url = await cloudinaryUpload(file);
  return ok({ url });
});

route('POST', '/api/upload/multiple', async ({ body }) => {
  if (!(body instanceof FormData)) return err('FormData 가 아닙니다', 400);
  const files = body.getAll('images');
  if (!files.length) return err('파일이 없습니다', 400);
  const urls = await Promise.all(files.map(f => cloudinaryUpload(f)));
  return ok({ urls });
});

// ─────────────────────────────────────────────────────────────
// Fetch 가로채기
// ─────────────────────────────────────────────────────────────
// pre-shim.js 가 먼저 로드돼 있으면 그게 보존한 원본 fetch 를 사용
const originalFetch = (window.__originalFetch || window.fetch).bind(window);

window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url || !url.startsWith('/api/')) return originalFetch(input, init);

  const u = new URL(url, location.origin);
  const method = (init.method || 'GET').toUpperCase();
  let body = null;
  if (init.body) {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }

  for (const r of routes) {
    if (r.method !== method) continue;
    const params = matchPath(r.pattern, u.pathname);
    if (params) {
      try {
        return await r.handler({ params, search: u.searchParams, body, method });
      } catch (e) {
        console.error('[shim]', method, u.pathname, e);
        return json({ success: false, message: e.message }, e.status || 500);
      }
    }
  }
  console.warn('[shim] 미구현 엔드포인트:', method, u.pathname);
  return json({ success: false, message: 'not implemented', path: u.pathname }, 501);
};

console.log('[shim] /api/* 가로채기 활성화');

// pre-shim 큐가 있으면 처리 (인라인 스크립트가 먼저 호출한 fetch 들)
window.__shimReady = true;
if (typeof window.__drainApiQueue === 'function') {
  window.__drainApiQueue();
}
