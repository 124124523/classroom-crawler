# SchoolBoard — 대전대신고등학교 학사관리 웹앱

## 프로젝트 개요
3학년 학생 333명의 수행평가, 공지, 시간표, 급식을 관리하는 웹 애플리케이션.
Google Classroom에서 과제를 자동 크롤링하여 학생별 수강 분반에 맞게 표시한다.

## 기술 스택
- **Backend**: Node.js + Express
- **Database**: MySQL on Railway (`dateStrings: true` 필수)
- **Frontend**: 바닐라 HTML/CSS/JS (프레임워크 없음, SPA 아님)
- **크롤러**: Google Classroom API (googleapis 패키지)
- **이미지**: Cloudinary (업로드/저장)
- **급식**: NEIS 공식 API + Instagram 급식 사진 크롤링
- **배포**: Railway (git push → 자동 배포)

## 프로젝트 구조
```
classroom-crawler/
├── backend/
│   ├── db.js              ← MySQL 커넥션 풀 (dateStrings: true 필수!)
│   ├── server.js          ← Express 서버 + 크론 스케줄러
│   ├── sync.js            ← coursework → assignments 동기화
│   ├── syncMeals.js       ← NEIS API → school_meals 동기화
│   ├── mealDayImages.js   ← 급식 사진 DB 모델
│   └── routes/
│       ├── login.js       ← 로그인 (세션 기반)
│       ├── assignments.js ← 수행평가 CRUD + 완료 상태
│       ├── notices.js     ← 공지 CRUD + 읽음 처리
│       ├── comments.js    ← 공지/과제 댓글
│       ├── subjects.js    ← 과목/분반 관리
│       ├── meals.js       ← 급식 메뉴 + 사진 API
│       ├── Timetable.js   ← 시간표/개인일정/완료 토글
│       ├── upload.js      ← Cloudinary 이미지 업로드
│       ├── classroom.js   ← Google OAuth + 크롤링 트리거
│       └── admin.js       ← 관리자 기능 (계정/커버리지/급식동기화)
├── crawler/
│   ├── auth.js            ← Google Classroom 크롤러 (OAuth + coursework 수집)
│   └── db.js              ← 크롤러용 MySQL 커넥션 풀 (dateStrings: true 필수!)
└── frontend/
    ├── login.html         ← 로그인 페이지
    ├── student.html       ← 학생 대시보드 (수행평가보드/캘린더/시간표/급식)
    ├── leader.html        ← 반장 페이지 (과제/공지 관리)
    ├── teacher.html       ← 선생님 페이지 (과제/공지 관리)
    ├── admin.html         ← 관리자 페이지 (계정/분반/동기화/커버리지)
    └── style.css          ← 공통 스타일
```

## API 라우트
```
POST /api/login              ← 로그인
GET  /api/me                 ← 세션 확인
POST /api/logout             ← 로그아웃
PUT  /api/me/password        ← 비밀번호 변경
PUT  /api/me/id              ← 아이디 변경

GET/POST/PUT/DELETE /api/assignments  ← 수행평가
GET/POST/PUT/DELETE /api/notices      ← 공지
GET/POST/DELETE     /api/comments     ← 댓글
GET/POST            /api/subjects     ← 과목/분반

GET/POST/DELETE /api/timetable/personal  ← 개인 일정
POST            /api/timetable/complete  ← 과제 완료 토글
GET/POST        /api/timetable/image     ← 시간표 이미지

GET/POST/DELETE /api/meals       ← 급식 메뉴/사진
POST /api/upload/single          ← 이미지 1장 업로드
POST /api/upload/multiple        ← 이미지 여러 장 업로드

GET  /api/classroom/auth         ← Google OAuth 시작
POST /api/classroom/sync         ← 크롤링 + sync 수동 실행
GET  /api/admin/coverage         ← 토큰 커버리지 현황
POST /api/admin/sync-meals       ← 급식 동기화
```

## DB 테이블 (주요)
- **users**: id(PK), password, name, role(admin/teacher/leader/student)
- **subjects**: id, name, category(일반/진로)
- **classes**: id, subject_id(FK), class_code(A~G), teacher
- **enrollments**: user_id + class_id (학생 수강 매핑)
- **assignments**: id, title, content, writer, class_id, deadline(DATETIME), gclassroom_id
- **notices**: id, title, content, writer, class_id, image_urls
- **completions**: user_id + target_type(assignment/personal) + target_id
- **personal_events**: 학생 개인 일정
- **coursework**: Google Classroom에서 크롤링한 원본 과제 데이터
- **tokens**: Google OAuth 토큰 (31명, 86개 분반 완전 커버)
- **school_meals**: NEIS 급식 메뉴
- **meal_day_images**: Instagram 급식 사진

## 크롤링 파이프라인
```
3시간마다 (cron):
  1. crawler/auth.js crawlAll()
     → tokens 테이블의 31개 계정으로 Google Classroom API 호출
     → coursework 테이블에 upsert (dueTime UTC→KST 변환)
  
  2. backend/sync.js syncCourseworkToAssignments()
     → coursework → assignments 테이블로 동기화
     → course_name으로 class_id 매핑
     → 기존 과제도 deadline 항상 갱신
     → 중복 삽입 방지 (class_id + title + DATE(deadline))
```

## 사용자 역할
| 역할 | 페이지 | 권한 |
|------|--------|------|
| admin | admin.html | 전체 관리 (계정/분반/동기화) |
| teacher | teacher.html | 수행평가/공지 CRUD (전체 분반) |
| leader | leader.html | 수행평가/공지 CRUD (담당 분반만) |
| student | student.html | 수행평가 조회/완료, 개인일정, 시간표 |

## ⚠️ 핵심 주의사항

### 1. dateStrings: true (필수!)
backend/db.js와 crawler/db.js 둘 다 mysql2 풀 옵션에 `dateStrings: true`가 있어야 한다.
없으면 DATETIME이 JS Date 객체로 변환 → JSON 직렬화 시 UTC('T...Z') → 프론트에서 +9시간 표시됨.
```javascript
const pool = mysql.createPool({
  ...
  dateStrings: true,  // 이 한 줄이 없으면 시간이 9시간 밀림!
});
```

### 2. 동명이인 학생 (ID에 _숫자 suffix)
같은 이름의 학생이 여러 명 있어서 ID에 `_반번호` suffix가 붙는다.
예: 김재민_4(3-4반), 김재민_6(3-6반), 김민준_1(3-1반), 김민준_2(3-2반)

동명이인 14쌍:
김민준(_1,_2), 이준호(_1,_9), 이지섭(_1,_10), 장민성(_1,_3),
김민채(_10,_8), 김도현(_2,_3), 정승원(_2,_6), 김동현(_3,_8),
이승찬(_3,_8), 김재민(_4,_6), 박지우(_4,_7), 이준서(_4,_9),
김민규(_6,_7), 이창현(_6,_8)

시간표 매칭 시 ID suffix에서 반 번호를 추출해야 정확한 반 시간표를 보여줄 수 있다.
TT_DATA 키 형식: "이름|3-반번호" (예: "김재민|3-6")

### 3. 마감일시 (deadline/due_date)
- DB 컬럼: DATETIME (DATE 아님!)
- 저장 형식: KST 문자열 '2026-03-30 14:00:00'
- 크롤러(auth.js)에서 Google Classroom dueTime(UTC)을 KST로 변환
- sync.js에서 기존 과제도 deadline을 항상 갱신해야 함
- 프론트 parseDueLocal()은 ISO('T'포함), 공백 구분, 날짜만 — 3가지 형식 모두 처리

### 4. 시간대
- 서버: Railway (UTC)
- DB 저장: KST 문자열 (dateStrings: true 덕분에 변환 없이 전달)
- 프론트: 브라우저 로컬 시간 (한국 = KST)
- Google Classroom API: UTC (dueTime.hours/minutes)

### 5. 배포
git push origin main → Railway 자동 배포.
배포 후 서버가 재시작되면서 runPipeline() 자동 실행 (크롤링+sync).

## 환경변수 (Railway Variables)
```
DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALLBACK_URL
CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
NEIS_API_KEY, NEIS_ATPT_CODE, NEIS_SCHOOL_CODE
SESSION_SECRET
PORT
```

## 코딩 컨벤션
- 한국어 주석 사용
- 변수명은 camelCase
- DB 컬럼명은 snake_case
- 프론트엔드는 바닐라 JS (프레임워크/번들러 없음)
- CSS 변수 사용 (--surface, --text, --border 등)
- 에러 표시: showToast(msg, 'error'|'success'|'info')

## 자주 발생하는 문제
1. **시간이 9시간 밀림** → db.js에 dateStrings: true 빠짐
2. **과제 시간이 전부 23:59** → auth.js에서 dueTime 파싱 안 됨 또는 sync.js에서 기존 과제 deadline 미갱신
3. **과제 중복 등록** → 같은 과제가 다른 Google Classroom 섹션에 게시됨 (sync.js 중복 체크 필요)
4. **동명이인 시간표 오류** → Object.keys(TT_DATA).find() 폴백이 첫 번째 키 반환
5. **캘린더 드래그 목록에 완료 과제 표시** → completed 필터가 문자열 "0"을 truthy로 판단