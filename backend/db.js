require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  // DATETIME 컬럼을 JS Date 객체가 아닌 문자열('2026-03-30 14:00:00')로 반환
  // → JSON 직렬화 시 UTC 변환 없이 DB 저장값 그대로 프론트에 전달
  dateStrings: true,
});

module.exports = pool;