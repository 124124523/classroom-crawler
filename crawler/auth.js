// crawler/auth.js (Firestore 버전)
// 기존 MySQL 코드를 그대로 Firestore Admin SDK 호출로 치환
// CALLBACK_URL 은 토큰 갱신에는 필요 없으므로 기본값 OK

require('dotenv').config();
const { google } = require('googleapis');
const { db } = require('./firestore');

const PARALLEL_LIMIT = 10;
const FS_BATCH_LIMIT = 450;  // Firestore 배치 한도 500, 여유 50

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL || 'urn:ietf:wg:oauth:2.0:oob'
  );
}

async function getClientForUser(tokenDocId, userId) {
  const ref = db.collection('tokens').doc(String(tokenDocId));
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`토큰 없음: ${userId}`);
  const t = snap.data();

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expiry_date: t.token_expiry ? new Date(t.token_expiry).getTime() : null,
  });

  // 만료 시 자동 갱신 → Firestore 업데이트
  oauth2Client.on('tokens', async (newTokens) => {
    try {
      const upd = {
        updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      };
      if (newTokens.access_token) upd.access_token = newTokens.access_token;
      if (newTokens.expiry_date) upd.token_expiry = new Date(newTokens.expiry_date).toISOString().replace('T', ' ').slice(0, 19);
      await ref.update(upd);
    } catch (e) {
      console.warn(`  [crawler] 토큰 갱신 저장 실패 (${userId}): ${e.message}`);
    }
  });

  return oauth2Client;
}

// dueDate(UTC) + dueTime(UTC) → KST 'YYYY-MM-DD HH:MM:00'
function parseDueDate(dueDate, dueTime) {
  if (!dueDate) return null;
  const { year, month, day } = dueDate;

  if (dueTime && (dueTime.hours != null || dueTime.minutes != null)) {
    const utcH = dueTime.hours || 0;
    const utcM = dueTime.minutes || 0;
    const utc = new Date(Date.UTC(year, month - 1, day, utcH, utcM));
    const kst = new Date(utc.getTime() + 9 * 60 * 60 * 1000);
    const ky = kst.getUTCFullYear();
    const km = String(kst.getUTCMonth() + 1).padStart(2, '0');
    const kd = String(kst.getUTCDate()).padStart(2, '0');
    const kh = String(kst.getUTCHours()).padStart(2, '0');
    const ki = String(kst.getUTCMinutes()).padStart(2, '0');
    return `${ky}-${km}-${kd} ${kh}:${ki}:00`;
  }
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} 23:59:00`;
}

// coursework upsert (Firestore: coursework/{coursework_id})
// 큰 배열은 450개씩 쪼개서 병렬 commit
async function upsertCourseWork(items, userId) {
  if (!items.length) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const chunks = [];
  for (let i = 0; i < items.length; i += FS_BATCH_LIMIT) {
    chunks.push(items.slice(i, i + FS_BATCH_LIMIT));
  }
  await Promise.all(chunks.map(chunk => {
    const batch = db.batch();
    for (const item of chunk) {
      const ref = db.collection('coursework').doc(item.coursework_id);
      batch.set(ref, {
        coursework_id: item.coursework_id,
        course_id: item.course_id,
        course_name: item.course_name,
        title: item.title,
        description: item.description,
        due_date: item.due_date,
        state: item.state,
        link: item.link,
        fetched_by: userId,
        fetched_at: ts,
      }, { merge: true });
    }
    return batch.commit();
  }));
}

// 사용자가 학생인지 확인 (users 컬렉션 조회)
async function isStudentUser(userId) {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) return false;
  return snap.data().role === 'student';
}

// 학생 제출 상태 → completions 컬렉션 동기화
// userId: 학생의 legacyId (예: '형민호')
// classroom: Google Classroom v1 API client
// courses: 학생이 등록된 수업 목록
async function syncStudentSubmissions(userId, classroom, courses) {
  // 1) 본인 제출 상태 모두 fetch (수업당 1회 호출, courseWorkId='-' 이 와일드카드)
  const allSubs = [];
  await Promise.all(courses.map(async (course) => {
    try {
      const res = await classroom.courses.courseWork.studentSubmissions.list({
        courseId: course.id,
        courseWorkId: '-',
        userId: 'me',
        pageSize: 200,
      });
      for (const sub of (res.data.studentSubmissions || [])) {
        allSubs.push(sub);
      }
    } catch (e) {
      console.error(`  [submissions] ${userId} 수업(${course.name}) 오류: ${e.message}`);
    }
  }));

  if (allSubs.length === 0) return { matched: 0, marked: 0 };

  // 제출(TURNED_IN/RETURNED) 상태인 과제 → completions 에 등록
  // target_type='coursework' + target_id=courseWorkId 로 통일 (assignment.id 매핑 불필요)
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const COMPLETED_STATES = new Set(['TURNED_IN', 'RETURNED']);

  let marked = 0;
  const completionsBatch = db.batch();

  for (const sub of allSubs) {
    const courseWorkId = sub.courseWorkId;
    if (!courseWorkId) continue;
    const docId = `${userId}_coursework_${courseWorkId}`;
    const ref = db.collection('completions').doc(docId);

    if (COMPLETED_STATES.has(sub.state)) {
      completionsBatch.set(ref, {
        user_id: userId,
        target_type: 'coursework',
        target_id: courseWorkId,
        completed_at: ts,
        source: 'classroom',
        submission_state: sub.state,
      }, { merge: true });
      marked++;
    }
  }

  if (marked > 0) await completionsBatch.commit();
  return { matched: allSubs.length, marked };
}

async function crawlForUser(tokenDocId, userId) {
  const auth = await getClientForUser(tokenDocId, userId);
  const classroom = google.classroom({ version: 'v1', auth });

  const cutoff = new Date(Date.now() + 9*60*60*1000 - 30*24*60*60*1000)
    .toISOString().slice(0, 10);

  const [activeRes, archivedRes] = await Promise.all([
    classroom.courses.list({ studentId: 'me', courseStates: ['ACTIVE'],   pageSize: 50 }),
    classroom.courses.list({ studentId: 'me', courseStates: ['ARCHIVED'], pageSize: 50 }),
  ]);

  const courses = [
    ...(activeRes.data.courses  || []),
    ...(archivedRes.data.courses || []),
  ];
  console.log(`  [crawler] ${userId}: 수업 ${courses.length}개`);

  let skipped = 0;
  const allItems = [];

  // 모든 수업의 coursework 를 병렬로 fetch (네트워크 병렬화)
  await Promise.all(courses.map(async (course) => {
    try {
      const cwRes = await classroom.courses.courseWork.list({
        courseId: course.id,
        courseWorkStates: ['PUBLISHED'],
        orderBy: 'dueDate asc',
        pageSize: 50,
      });

      for (const cw of (cwRes.data.courseWork || [])) {
        const dueDate = parseDueDate(cw.dueDate, cw.dueTime);
        if (!dueDate) { skipped++; continue; }
        if (dueDate.slice(0, 10) < cutoff) { skipped++; continue; }
        allItems.push({
          coursework_id: cw.id,
          course_id: course.id,
          course_name: course.name,
          title: cw.title,
          description: cw.description || null,
          due_date: dueDate,
          state: cw.state || 'PUBLISHED',
          link: cw.alternateLink || null,
        });
      }
    } catch (e) {
      console.error(`  [crawler] ${userId} 수업(${course.name}) 오류: ${e.message}`);
    }
  }));

  // 한 계정의 모든 coursework 를 한번에 batch upsert (네트워크 RTT 절감)
  await upsertCourseWork(allItems, userId);

  // 학생 토큰이면 본인 제출 상태도 동기화
  let submissionsMarked = 0;
  try {
    if (await isStudentUser(userId)) {
      const r = await syncStudentSubmissions(userId, classroom, courses);
      submissionsMarked = r.marked;
      if (r.marked > 0) console.log(`  [crawler] ${userId}: 제출 ${r.marked}개 표시`);
    }
  } catch (e) {
    console.error(`  [crawler] ${userId} 제출 동기화 오류: ${e.message}`);
  }

  return { upserted: allItems.length, skipped, submissionsMarked };
}

// 토큰을 6개 bucket 으로 나눠 시간대별 분산 크롤 (API quota 분산)
// UTC 시간 기준으로 hour%6 == tokenDocId%6 인 토큰만 그 시각에 크롤
// → 토큰당 6시간마다 1회 크롤 (1시간 cron 유지하면서 부하 분산)
const BUCKET_COUNT = 6;
function tokenInCurrentBucket(tokenDocId) {
  const idNum = parseInt(tokenDocId);
  if (isNaN(idNum)) return true;  // 숫자 아닌 docId 는 안전을 위해 항상 포함
  const bucketIdx = new Date().getUTCHours() % BUCKET_COUNT;
  return idNum % BUCKET_COUNT === bucketIdx;
}

async function crawlAll() {
  console.log(`[crawler] 시작: ${new Date().toLocaleString('ko-KR')}`);

  const tokSnap = await db.collection('tokens').get();
  if (tokSnap.empty) {
    console.warn('[crawler] tokens 컬렉션이 비어 있음');
    return { upserted: 0, skipped: 0, failed: 0 };
  }
  const allTokens = tokSnap.docs.map(d => ({ id: d.id, user_id: d.data().user_id }));
  const tokens = allTokens.filter(t => tokenInCurrentBucket(t.id));
  console.log(`[crawler] 토큰 ${allTokens.length}개 중 이 bucket ${tokens.length}개 처리 (UTC hour ${new Date().getUTCHours()} → bucket ${new Date().getUTCHours() % BUCKET_COUNT})`);

  let totalUpserted = 0, totalSkipped = 0, totalFailed = 0;

  for (let i = 0; i < tokens.length; i += PARALLEL_LIMIT) {
    const batch = tokens.slice(i, i + PARALLEL_LIMIT);
    const results = await Promise.allSettled(
      batch.map(({ id, user_id }) => crawlForUser(id, user_id))
    );
    results.forEach((result, idx) => {
      const { user_id } = batch[idx];
      if (result.status === 'fulfilled') {
        const { upserted, skipped } = result.value;
        totalUpserted += upserted;
        totalSkipped += skipped;
        console.log(`  [crawler] ${user_id}: upsert ${upserted}, 스킵 ${skipped}`);
      } else {
        console.error(`  [crawler] ${user_id} 실패: ${result.reason?.message}`);
        totalFailed++;
      }
    });
  }

  console.log(`[crawler] 완료 → upsert ${totalUpserted}, 스킵 ${totalSkipped}, 실패 ${totalFailed}`);
  return { upserted: totalUpserted, skipped: totalSkipped, failed: totalFailed };
}

module.exports = { crawlAll };
