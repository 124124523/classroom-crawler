// SQL 덤프 파일을 Firestore로 일괄 import
// 사용법: node migrate/import.js [테이블명1 테이블명2 ...]
//   인자 없으면 전체 17개 테이블 import
//   예: node migrate/import.js users subjects classes

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const { parseSqlFile } = require('./parseSql');

// 서비스 계정 키 로드 (.gitignore에 등록되어 있음)
const serviceAccount = require('../serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 어떤 SQL 파일에서 어떤 컬렉션으로 매핑할지
// docIdField: 어느 컬럼 값을 Firestore 문서 ID로 쓸지 (생략 시 auto-id)
const TABLE_MAP = [
  { sqlPattern: 'railway_users_', collection: 'users', docIdField: 'id' },
  { sqlPattern: 'railway_subjects_', collection: 'subjects', docIdField: 'id' },
  { sqlPattern: 'railway_classes_', collection: 'classes', docIdField: 'id' },
  { sqlPattern: 'railway_enrollments_', collection: 'enrollments', docIdField: 'id' },
  { sqlPattern: 'railway_assignments_', collection: 'assignments', docIdField: 'id' },
  { sqlPattern: 'railway_notices_', collection: 'notices', docIdField: 'id' },
  { sqlPattern: 'railway_assignment_comments_', collection: 'assignment_comments', docIdField: 'id' },
  { sqlPattern: 'railway_notice_comments_', collection: 'notice_comments', docIdField: 'id' },
  { sqlPattern: 'railway_comment_reads_', collection: 'comment_reads', docIdField: 'id' },
  { sqlPattern: 'railway_notice_reads_', collection: 'notice_reads', docIdField: 'id' },
  { sqlPattern: 'railway_completions_', collection: 'completions', docIdField: 'id' },
  { sqlPattern: 'railway_personal_events_', collection: 'personal_events', docIdField: 'id' },
  { sqlPattern: 'railway_coursework_', collection: 'coursework', docIdField: 'coursework_id' },
  { sqlPattern: 'railway_tokens_', collection: 'tokens', docIdField: 'id' },
  { sqlPattern: 'railway_meal_day_images_', collection: 'meal_day_images', docIdField: 'date' },
  { sqlPattern: 'railway_timetables_', collection: 'timetables', docIdField: 'user_id' },
  { sqlPattern: 'railway_school_schedule_', collection: 'school_schedule', docIdField: 'id' },
];

const SQL_DIR = path.join(__dirname, '..', 'db 파일');
const BATCH_SIZE = 400;

function findSqlFile(pattern) {
  const files = fs.readdirSync(SQL_DIR);
  // school_meals 파일은 전체 덤프라 제외 (별도 테이블 파일이 있음)
  const match = files.find(
    f => f.startsWith(pattern) &&
         !f.includes('railway_school_meals_')
  );
  if (!match) return null;
  return path.join(SQL_DIR, match);
}

async function importTable({ sqlPattern, collection, docIdField }) {
  const filePath = findSqlFile(sqlPattern);
  if (!filePath) {
    console.log(`  ⚠ SQL 파일 없음: ${sqlPattern}`);
    return;
  }

  console.log(`\n[${collection}] ← ${path.basename(filePath)}`);
  const { rows } = parseSqlFile(filePath);
  console.log(`  파싱된 행: ${rows.length}개`);

  if (rows.length === 0) {
    console.log('  (데이터 없음, 건너뜀)');
    return;
  }

  // 배치 단위로 분할 쓰기
  let written = 0;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const chunk = rows.slice(start, start + BATCH_SIZE);
    const batch = db.batch();

    for (const row of chunk) {
      // null 값은 Firestore에 그대로 저장 (필드 자체는 유지)
      const docId = String(row[docIdField] ?? '');
      if (!docId) {
        console.warn(`  ⚠ docId 비어있음, 행 건너뜀:`, row);
        continue;
      }
      const ref = db.collection(collection).doc(docId);
      batch.set(ref, row);
    }

    await batch.commit();
    written += chunk.length;
    process.stdout.write(`\r  쓰기: ${written}/${rows.length}`);
  }
  console.log(`\n  ✓ 완료: ${written}개 문서`);
}

async function main() {
  const argFilter = process.argv.slice(2);
  const targets = argFilter.length > 0
    ? TABLE_MAP.filter(t => argFilter.includes(t.collection))
    : TABLE_MAP;

  if (targets.length === 0) {
    console.error('일치하는 테이블이 없습니다. 사용 가능:');
    TABLE_MAP.forEach(t => console.error('  -', t.collection));
    process.exit(1);
  }

  console.log(`\n=== Firestore Import 시작 ===`);
  console.log(`프로젝트: ${serviceAccount.project_id}`);
  console.log(`대상 컬렉션: ${targets.map(t => t.collection).join(', ')}`);

  const startTime = Date.now();
  for (const t of targets) {
    try {
      await importTable(t);
    } catch (err) {
      console.error(`\n  ✗ ${t.collection} 실패:`, err.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== 완료 (${elapsed}초) ===`);
  process.exit(0);
}

main().catch(err => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
