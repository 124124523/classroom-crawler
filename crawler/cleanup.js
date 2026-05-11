// 정기 데이터 정리 — 매일 1회 GitHub Actions 가 실행
//   1. coursework: 마감 90일 지난 것 삭제
//   2. completions: 90일 지난 자동 추적 (target_type='coursework') 삭제
//   3. pendingTokens: 1시간 이상 된 잔여 항목 삭제 (안전망)

require('dotenv').config();
const { db } = require('./firestore');

const FS_BATCH = 450;
const COURSEWORK_RETAIN_DAYS = 90;
const COMPLETIONS_RETAIN_DAYS = 90;

function ymdDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function batchDelete(docs, label) {
  if (docs.length === 0) return 0;
  let deleted = 0;
  for (let i = 0; i < docs.length; i += FS_BATCH) {
    const chunk = docs.slice(i, i + FS_BATCH);
    const batch = db.batch();
    chunk.forEach(d => batch.delete(d.ref));
    await batch.commit();
    deleted += chunk.length;
    process.stdout.write(`\r  [${label}] ${deleted}/${docs.length} 삭제`);
  }
  console.log();
  return deleted;
}

async function cleanupCoursework() {
  const cutoff = ymdDaysAgo(COURSEWORK_RETAIN_DAYS);
  const snap = await db.collection('coursework')
    .where('due_date', '<', cutoff)
    .get();
  console.log(`[cleanup] coursework: due_date < ${cutoff} → ${snap.size}개 삭제`);
  await batchDelete(snap.docs, 'coursework');
  return snap.size;
}

async function cleanupCompletions() {
  // target_type='coursework' 인 완료 기록 중 오래된 것
  // completed_at 기준 (YYYY-MM-DD HH:MM:SS 문자열)
  const cutoffDateTime = `${ymdDaysAgo(COMPLETIONS_RETAIN_DAYS)} 00:00:00`;
  const snap = await db.collection('completions')
    .where('target_type', '==', 'coursework')
    .where('completed_at', '<', cutoffDateTime)
    .get();
  console.log(`[cleanup] completions (coursework): completed_at < ${cutoffDateTime} → ${snap.size}개 삭제`);
  await batchDelete(snap.docs, 'completions');
  return snap.size;
}

async function cleanupPendingTokens() {
  // 1시간 이상 된 pendingToken 은 거의 확실히 만료 (auth code TTL 10분)
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const snap = await db.collection('pendingTokens')
    .where('requested_at', '<', cutoff)
    .get();
  console.log(`[cleanup] pendingTokens: requested_at < ${cutoff} → ${snap.size}개 삭제`);
  await batchDelete(snap.docs, 'pendingTokens');
  return snap.size;
}

async function cleanupAll() {
  console.log(`[cleanup] 시작: ${new Date().toLocaleString('ko-KR')}`);
  const cw = await cleanupCoursework();
  const cp = await cleanupCompletions();
  const pt = await cleanupPendingTokens();
  console.log(`[cleanup] 완료: coursework ${cw}, completions ${cp}, pendingTokens ${pt}`);
  return { coursework: cw, completions: cp, pendingTokens: pt };
}

module.exports = { cleanupAll };

if (require.main === module) {
  cleanupAll()
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
