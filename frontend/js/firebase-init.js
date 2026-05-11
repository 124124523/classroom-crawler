// Firebase 초기화 + 모든 페이지에서 공통 사용하는 인스턴스 export
// CDN에서 직접 ES 모듈을 import 하므로 빌드 도구 불필요

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAtJQRPsY6IYNHKzDmv3y5rgIN-0om0cb8',
  authDomain: 'crawler-10edc.firebaseapp.com',
  projectId: 'crawler-10edc',
  storageBucket: 'crawler-10edc.firebasestorage.app',
  messagingSenderId: '821442833620',
  appId: '1:821442833620:web:478cb5082a0e454da49f41',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// 학교 이메일 도메인 검증 (보안 규칙과 동일하게 강제)
export const SCHOOL_DOMAIN = '@dshs.kr';
export function isSchoolEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith(SCHOOL_DOMAIN);
}

// Cloudinary 클라이언트 직접 업로드 설정
// (cloudName 은 공개 가능, uploadPreset 은 unsigned 모드로 생성한 preset 이름)
export const CLOUDINARY = {
  cloudName: 'dkmistqkh',
  uploadPreset: 'schoolboard_unsigned',
};

// Google OAuth (Classroom 동의용) - Phase 2
// client_id 는 공개 가능한 값. client_secret 은 GitHub Actions 에만 보관.
export const GOOGLE_OAUTH = {
  clientId: '524858649664-1ipu9bksc884989tgrlob83t324mslq7.apps.googleusercontent.com',
  redirectUri: 'https://crawler-10edc.web.app/oauth-callback.html',
  scopes: [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me',
  ],
  // Cloudflare Worker 토큰 교환 프록시 URL.
  // 미설정 시 (빈 문자열) 자동으로 기존 흐름 (pendingTokens → 5분 cron) 으로 fallback.
  proxyUrl: '',  // 예: 'https://oauth-proxy.your-name.workers.dev'
};
