// crawler/db.js
// Railway는 .env 파일 없이 Variables로 직접 주입 → path 옵션 제거
require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  // DATETIME 컬럼을 문자열로 반환 (UTC 변환 방지)
  dateStrings: true,
});

module.exports = pool;