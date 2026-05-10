// pendingTokens 컬렉션의 OAuth 코드를 Google 에 교환하여 tokens 컬렉션에 저장
// 5분마다 GitHub Actions 에서 실행

require('dotenv').config();
const { db } = require('./firestore');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_AGE_MIN = 30;  // 30분 지난 pendingTokens 는 코드 만료로 간주, 삭제

async function exchangeOne(pendingDoc) {
  const data = pendingDoc.data();
  const { code, redirect_uri, user_id, requested_at } = data;

  // 너무 오래된 pendingToken 은 코드 만료로 간주 → 삭제
  const ageMin = (Date.now() - new Date(requested_at).getTime()) / 60000;
  if (ageMin > MAX_AGE_MIN) {
    console.log(`  [exchange] ${user_id}: ${ageMin.toFixed(1)}분 경과 → 삭제`);
    await pendingDoc.ref.delete();
    return { user_id, status: 'expired' };
  }

  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`  [exchange] ${user_id} 실패 (${res.status}): ${text}`);
    // 4xx 면 코드 무효 → 삭제 (재시도 불가능)
    if (res.status >= 400 && res.status < 500) {
      await pendingDoc.ref.delete();
      return { user_id, status: 'invalid' };
    }
    return { user_id, status: 'retry' };
  }

  const tk = await res.json();
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const expiry = new Date(Date.now() + (tk.expires_in || 3600) * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);

  // 기존 token 문서가 있으면 업데이트, 없으면 새로 생성
  const existSnap = await db.collection('tokens').where('user_id', '==', user_id).get();
  const tokenData = {
    user_id,
    access_token: tk.access_token,
    token_expiry: expiry,
    updated_at: ts,
  };
  // refresh_token 은 첫 동의 시에만 발급됨 (이후 재발급 안 됨, 받았을 때만 저장)
  if (tk.refresh_token) tokenData.refresh_token = tk.refresh_token;

  let tokenDocId;
  if (existSnap.empty) {
    const all = await db.collection('tokens').get();
    const maxId = all.docs.reduce((m, d) => Math.max(m, parseInt(d.id) || 0), 0);
    tokenDocId = String(maxId + 1);
    tokenData.created_at = ts;
    tokenData.id = maxId + 1;
    await db.collection('tokens').doc(tokenDocId).set(tokenData);
  } else {
    tokenDocId = existSnap.docs[0].id;
    await existSnap.docs[0].ref.set(tokenData, { merge: true });
  }

  // 성공 → pendingToken 삭제
  await pendingDoc.ref.delete();
  console.log(`  [exchange] ${user_id} 성공`);
  return { user_id, status: 'ok', tokenDocId };
}

async function exchangePendingTokens() {
  const snap = await db.collection('pendingTokens').get();
  if (snap.empty) {
    console.log('[exchange] 처리할 pendingTokens 없음');
    return { ok: 0, expired: 0, invalid: 0, retry: 0, newTokens: [] };
  }
  console.log(`[exchange] ${snap.size}개 처리 시작`);

  const newTokens = [];
  const results = await Promise.allSettled(snap.docs.map(d => exchangeOne(d)));
  const tally = { ok: 0, expired: 0, invalid: 0, retry: 0, error: 0 };
  for (const r of results) {
    if (r.status === 'fulfilled') {
      tally[r.value.status] = (tally[r.value.status] || 0) + 1;
      if (r.value.status === 'ok') {
        newTokens.push({ user_id: r.value.user_id, tokenDocId: r.value.tokenDocId });
      }
    } else {
      tally.error++;
      console.error('  [exchange] 예외:', r.reason?.message);
    }
  }
  console.log(`[exchange] 완료: ok=${tally.ok} expired=${tally.expired} invalid=${tally.invalid} retry=${tally.retry} error=${tally.error}`);
  return { ...tally, newTokens };
}

// 토큰 교환 + 새로 동의한 학생만 즉시 크롤 + sync
async function exchangeAndCrawlNew() {
  const result = await exchangePendingTokens();
  if (!result.newTokens || result.newTokens.length === 0) return result;

  console.log(`[exchange] 새로 동의한 ${result.newTokens.length}명 즉시 크롤 시작`);

  // crawlForUser 와 sync 는 동적으로 require (순환 참조 회피)
  const { crawlForUser } = require('./auth');
  const { syncCourseworkToAssignments } = require('./sync');

  for (const { tokenDocId, user_id } of result.newTokens) {
    try {
      const r = await crawlForUser(tokenDocId, user_id);
      console.log(`  [exchange→crawl] ${user_id}: upsert ${r.upserted}, 제출 ${r.submissionsMarked || 0}`);
    } catch (e) {
      console.error(`  [exchange→crawl] ${user_id} 실패: ${e.message}`);
    }
  }

  try {
    await syncCourseworkToAssignments();
  } catch (e) {
    console.error('[exchange→sync] 실패:', e.message);
  }

  return result;
}

module.exports = { exchangePendingTokens, exchangeAndCrawlNew };

if (require.main === module) {
  exchangeAndCrawlNew()
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
