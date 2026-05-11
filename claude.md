# SchoolBoard — 대전대신고등학교 학사관리 웹앱

## 프로젝트 개요
3학년 학생 333명의 수행평가, 공지, 시간표, 급식을 관리하는 웹 애플리케이션.
Google Classroom 에서 과제를 자동 크롤링하여 학생별 수강 분반에 맞게 표시.
**Phase 2 부터는 학생이 직접 Classroom 동의 시, 본인 토큰으로 본인 코스만 크롤링됨.**

## 기술 스택 (Firebase 마이그레이션 후)
- **호스팅**: Firebase Hosting (https://crawler-10edc.web.app)
- **데이터베이스**: Cloud Firestore
- **인증**: Firebase Auth (이메일/비밀번호, @dshs.kr 도메인 강제)
- **프론트엔드**: 바닐라 HTML/CSS/JS + Firebase Web SDK (CDN ES Module)
- **백엔드 라우트**: 없음 — 프론트가 Firestore SDK 로 직접 호출, 기존 `/api/*` 코드는 shim 으로 가로채서 Firestore 호출로 변환
- **크롤러**: Node.js + Firebase Admin SDK + googleapis (GitHub Actions 에서 실행)
- **이미지 업로드**: Cloudinary 클라이언트 직접 업로드 (unsigned preset)
- **자동화**: GitHub Actions (5분 / 1시간 / 매일 cron)

## 프로젝트 구조
```
.
├── crawler/                  ← GitHub Actions 가 실행
│   ├── firestore.js          ← Firebase Admin SDK 초기화
│   ├── auth.js               ← Google Classroom OAuth + 크롤러 + 학생 제출 추적
│   ├── sync.js               ← coursework → assignments 동기화 (admin 토큰용)
│   ├── exchangeTokens.js     ← pendingTokens 의 OAuth 코드 → 토큰 교환 + 즉시 크롤
│   ├── syncNeisSchedule.js   ← NEIS API → school_schedule 동기화
│   └── run.js                ← 통합 진입점 (exchange → crawl → sync)
│
├── frontend/                 ← Firebase Hosting 이 서빙
│   ├── js/
│   │   ├── firebase-init.js  ← Firebase 초기화 + OAuth/Cloudinary 설정
│   │   ├── auth.js           ← 로그인/가입/매칭/Classroom 동의 헬퍼
│   │   ├── pre-shim.js       ← inline script 보다 먼저 fetch 가로채기 큐 설정
│   │   └── api-shim.js       ← /api/* fetch 호출을 Firestore SDK 호출로 변환
│   ├── index.html            ← / 접속 시 login.html 리다이렉트
│   ├── login.html, register.html, profile-link.html
│   ├── classroom-consent.html, oauth-callback.html
│   ├── student.html, leader.html, teacher.html, admin.html
│   └── style.css
│
├── .github/workflows/
│   └── schoolboard.yml       ← 통합 워크플로우 (3개 cron + 수동 task 선택)
│
├── firebase.json             ← Hosting + Firestore 설정
├── .firebaserc               ← Firebase 프로젝트 ID (crawler-10edc)
├── firestore.rules, firestore.indexes.json
├── serviceAccountKey.json    ← Admin SDK 키 (.gitignore 됨)
└── package.json              ← 크롤러 전용: dotenv, firebase-admin, googleapis
```

## Firestore 컬렉션
- **users**: id(docId), name, role, class_num, firebase_uid, email
- **userMappings**: {firebase_uid}(docId), legacyId, name, role, classNum
- **subjects, classes, enrollments**: 과목/분반/수강
- **assignments**: 수동 등록 + admin 크롤 sync 결과 (legacy 호환)
- **notices**: 공지
- **assignment_comments, notice_comments**: 댓글
- **comment_reads, notice_reads**: 읽음 표시
- **completions**: 본인 완료 표시
  - `target_type='assignment'`: 수동 토글 (target_id = assignments.id)
  - `target_type='coursework'`: Classroom 자동 추적 (target_id = Google courseWorkId)
- **personal_events**: 학생 개인 일정
- **timetables**: 학생 시간표 이미지
- **coursework**: Classroom 크롤링 원본 (fetched_by 별 분리)
- **tokens**: OAuth 토큰
- **pendingTokens**: OAuth 코드 임시 보관 (5분 내 교환 후 삭제)
- **meal_day_images**: 급식 사진 (date 가 docId)
- **school_schedule**: NEIS 학사일정

## 데이터 흐름 (Phase 2)
```
[새 학생 가입 → 동의]
회원가입 → 이메일 인증 → 로그인 → 프로필 매칭(이름+반)
                              ↓
                  classroom-consent.html → Google OAuth → oauth-callback.html
                              ↓
                  pendingTokens/{legacyId} 저장
                              ↓ (5분 cron)
                  exchangeTokens.js:
                    1. 토큰 교환 → tokens 저장
                    2. 신규 학생만 즉시 crawlForUser → coursework + completions
                              ↓
                  학생 페이지: 본인 coursework 만 표시
                              (마감일 있고, 미제출, 3일 이내)

[1시간 정기 크롤] tokens 의 모든 토큰 일괄 크롤 + sync
[매일 NEIS 동기화] school_schedule 갱신
```

## 사용자 역할
| 역할 | 페이지 | 권한 |
|------|--------|------|
| admin | admin.html | 전체 관리 |
| teacher | teacher.html | 공지 CRUD (전체) |
| leader | leader.html | 공지 CRUD (담당 분반) |
| student | student.html | 본인 데이터 조회/관리 |

## 학생 과제 표시 로직
```
if (학생 + Classroom 동의):
  본인 coursework (fetched_by=본인) 중 미제출 + 3일 이내 마감
else:
  assignments 중 본인 enrollments class_id 일치 + 3일 이내 + 미완료
```

## ⚠️ 핵심 주의사항

### 1. DATETIME 형식
Firestore 의 모든 시각은 `'YYYY-MM-DD HH:MM:SS'` KST 문자열.

### 2. 동명이인 (legacyId 의 _숫자 suffix)
김재민_4, 김재민_6 처럼 ID 에 반 번호 suffix.
profile-link 매칭 시 이름 + class_num 으로 정확히 1명만 일치해야 함.

### 3. OAuth state 는 ASCII 만
한글 legacyId 를 state 로 보내면 Google 이 500.
sessionStorage 에 random nonce 보관 + 콜백에서 확인.

### 4. completions 의 target_type 두 가지
- 'assignment' (수동), 'coursework' (Classroom 자동)
- 동의된 학생은 'coursework' 만 사용

### 5. shim 의 fetch 가로채기
`fetch('/api/...')` → pre-shim.js (sync) 가 큐에 담음 → api-shim.js (module) 가 로드된 후 Firestore SDK 호출로 변환.

## 환경변수 (GitHub Secrets)
```
FIREBASE_SERVICE_ACCOUNT     ← Admin SDK 키 JSON 전체
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALLBACK_URL
NEIS_API_KEY, NEIS_ATPT_CODE, NEIS_SCHOOL_CODE
```

## 자주 발생하는 문제
1. **OAuth 코드 만료 (invalid_grant)** → 10분 안에 exchange 안 됐을 때. 재동의.
2. **학사일정 안 보임** → /api/schedule 응답 `{ events: [...] }` 형식 + name/classYn 필드명.
3. **동의 후에도 과제 안 사라짐** → 다음 1시간 cron 또는 task=crawl 수동 트리거 대기.
4. **이미지 업로드 실패** → Cloudinary unsigned preset 활성 여부 + cloud name 확인.
