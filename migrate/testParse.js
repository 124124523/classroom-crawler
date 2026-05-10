// SQL 파서가 정상 동작하는지 검증
// 실제 Firestore 쓰기는 하지 않음 (서비스 계정 키 불필요)
// 사용법: node migrate/testParse.js

const path = require('path');
const fs = require('fs');
const { parseSqlFile } = require('./parseSql');

const SQL_DIR = path.join(__dirname, '..', 'db 파일');
const TABLES = [
  'railway_users_',
  'railway_subjects_',
  'railway_classes_',
  'railway_enrollments_',
  'railway_assignments_',
  'railway_notices_',
  'railway_assignment_comments_',
  'railway_notice_comments_',
  'railway_comment_reads_',
  'railway_notice_reads_',
  'railway_completions_',
  'railway_personal_events_',
  'railway_coursework_',
  'railway_tokens_',
  'railway_meal_day_images_',
  'railway_timetables_',
  'railway_school_schedule_',
];

const files = fs.readdirSync(SQL_DIR);
console.log('테이블별 파싱 결과:\n');
console.log('테이블명'.padEnd(28) + '행 수'.padStart(8) + '   샘플 컬럼');
console.log('─'.repeat(80));

for (const pattern of TABLES) {
  const file = files.find(f => f.startsWith(pattern) && !f.includes('school_meals'));
  if (!file) {
    console.log(pattern.padEnd(28) + '(파일 없음)');
    continue;
  }

  try {
    const filePath = path.join(SQL_DIR, file);
    const { tableName, columns, rows } = parseSqlFile(filePath);
    const sample = columns.slice(0, 4).join(', ') + (columns.length > 4 ? ', ...' : '');
    console.log(tableName.padEnd(28) + String(rows.length).padStart(8) + '   ' + sample);
  } catch (err) {
    console.log(pattern.padEnd(28) + 'ERROR: ' + err.message);
  }
}

console.log('\n파싱 검증 완료. 이상 없으면 "node migrate/import.js" 로 실제 import 진행.');
