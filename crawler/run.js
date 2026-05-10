// crawler/run.js — 크롤링 + 동기화 통합 실행 진입점
// GitHub Actions 워크플로우와 로컬 모두에서 동일하게 실행 가능
//   $ node crawler/run.js

require('dotenv').config();
const { crawlAll } = require('./auth');
const { syncCourseworkToAssignments } = require('./sync');

(async () => {
  const t0 = Date.now();
  try {
    const c = await crawlAll();
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
