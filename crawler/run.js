// crawler/run.js — 크롤링 + 동기화 통합 실행 진입점
// GitHub Actions 워크플로우와 로컬 모두에서 동일하게 실행 가능
//   $ node crawler/run.js

require('dotenv').config();
const { exchangePendingTokens } = require('./exchangeTokens');
const { crawlAll } = require('./auth');
const { syncCourseworkToAssignments } = require('./sync');

(async () => {
  const t0 = Date.now();
  try {
    // 1) 새로 동의한 학생들의 OAuth 코드 → access/refresh 토큰 교환
    await exchangePendingTokens();
    // 2) 모든 토큰 (선생/학생) 으로 Classroom 크롤
    const c = await crawlAll();
    // 3) coursework → assignments 동기화
    const s = await syncCourseworkToAssignments();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n=== 완료 (${elapsed}초) ===`);
    console.log(`크롤: upsert ${c.upserted}, 스킵 ${c.skipped}, 실패 ${c.failed}`);
    console.log(`동기화: 추가 ${s.inserted}, 스킵 ${s.skipped}, 조기스킵 ${s.skippedEarly}, 실패 ${s.failed}`);
    process.exit(0);
  } catch (err) {
    console.error('치명적 오류:', err);
    process.exit(1);
  }
})();
