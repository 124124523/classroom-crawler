// MySQL 덤프 파일 파서
// CREATE TABLE에서 컬럼명, INSERT INTO에서 데이터를 추출한다.

const fs = require('fs');

function parseColumns(sql) {
  const createMatch = sql.match(/CREATE TABLE `(\w+)` \(([\s\S]*?)\) ENGINE/);
  if (!createMatch) throw new Error('CREATE TABLE 구문을 찾을 수 없음');

  const tableName = createMatch[1];
  const body = createMatch[2];
  const columns = [];

  for (const line of body.split('\n')) {
    const m = line.match(/^\s*`(\w+)`\s+/);
    if (m) columns.push(m[1]);
  }

  return { tableName, columns };
}

// VALUES (...) , (...) , ... 부분을 상태머신으로 파싱
function parseValues(sql) {
  const startMatch = sql.match(/INSERT INTO `\w+` VALUES\s+/);
  if (!startMatch) return [];

  let i = startMatch.index + startMatch[0].length;
  const rows = [];

  while (i < sql.length) {
    while (i < sql.length && /\s/.test(sql[i])) i++;
    if (sql[i] === ';') break;
    if (sql[i] !== '(') break;
    i++;

    const row = [];
    while (i < sql.length && sql[i] !== ')') {
      while (i < sql.length && /\s/.test(sql[i])) i++;

      if (sql[i] === "'") {
        // 문자열
        i++;
        let str = '';
        while (i < sql.length) {
          if (sql[i] === '\\') {
            const next = sql[i + 1];
            if (next === 'n') str += '\n';
            else if (next === 't') str += '\t';
            else if (next === 'r') str += '\r';
            else if (next === '0') str += '\0';
            else if (next === 'Z') str += '\x1A';
            else str += next;
            i += 2;
          } else if (sql[i] === "'") {
            if (sql[i + 1] === "'") {
              str += "'";
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            str += sql[i];
            i++;
          }
        }
        row.push(str);
      } else if (sql.substr(i, 4).toUpperCase() === 'NULL') {
        row.push(null);
        i += 4;
      } else {
        // 숫자 또는 기타 리터럴
        let val = '';
        while (i < sql.length && sql[i] !== ',' && sql[i] !== ')') {
          val += sql[i];
          i++;
        }
        val = val.trim();
        if (/^-?\d+$/.test(val)) row.push(parseInt(val, 10));
        else if (/^-?\d+\.\d+$/.test(val)) row.push(parseFloat(val));
        else row.push(val);
      }

      while (i < sql.length && /\s/.test(sql[i])) i++;
      if (sql[i] === ',') i++;
    }
    i++; // ) 건너뛰기

    rows.push(row);

    while (i < sql.length && /\s/.test(sql[i])) i++;
    if (sql[i] === ',') i++;
  }

  return rows;
}

function parseSqlFile(filePath) {
  const sql = fs.readFileSync(filePath, 'utf-8');
  const { tableName, columns } = parseColumns(sql);
  const rawRows = parseValues(sql);

  // 컬럼명을 키로 매핑
  const rows = rawRows.map(r => {
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = r[idx];
    });
    return obj;
  });

  return { tableName, columns, rows };
}

module.exports = { parseSqlFile };
