// 인증 헬퍼: 로그인/로그아웃/회원가입/현재 사용자 조회
// Firebase Auth + userMappings 컬렉션을 모두 다룬다.

import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signOut,
  onAuthStateChanged,
  updatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc,
  collection, query, where, getDocs,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

import { auth, db, isSchoolEmail, SCHOOL_DOMAIN, GOOGLE_OAUTH } from './firebase-init.js';

// 현재 로그인된 사용자의 매핑(legacyId, role 등) 캐시
let _cachedMapping = null;
let _cachedUid = null;

// auth state 변경 시 캐시 무효화
onAuthStateChanged(auth, (user) => {
  if (!user || user.uid !== _cachedUid) {
    _cachedMapping = null;
    _cachedUid = user?.uid ?? null;
  }
});

// 로그인 (이메일 + 비밀번호)
export async function login(email, password) {
  if (!isSchoolEmail(email)) {
    throw new Error(`학교 이메일(${SCHOOL_DOMAIN})만 사용할 수 있습니다.`);
  }
  const cred = await signInWithEmailAndPassword(auth, email, password);
  if (!cred.user.emailVerified) {
    await signOut(auth);
    throw new Error('이메일 인증이 필요합니다. 가입 시 받은 인증 메일을 확인하세요.');
  }
  return cred.user;
}

// 회원가입 (가입 후 자동으로 인증 메일 발송)
export async function register(email, password) {
  if (!isSchoolEmail(email)) {
    throw new Error(`학교 이메일(${SCHOOL_DOMAIN})만 사용할 수 있습니다.`);
  }
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await sendEmailVerification(cred.user);
  return cred.user;
}

// 로그아웃
export async function logout() {
  _cachedMapping = null;
  _cachedUid = null;
  await signOut(auth);
}

// 현재 로그인된 Firebase Auth 사용자 (Promise 반환)
export function getCurrentUser() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

// 현재 사용자의 userMappings 문서 (legacyId, role 포함). 매핑 없으면 null
export async function getMyMapping() {
  const user = await getCurrentUser();
  if (!user) return null;

  if (_cachedMapping && _cachedUid === user.uid) return _cachedMapping;

  const snap = await getDoc(doc(db, 'userMappings', user.uid));
  if (!snap.exists()) {
    _cachedMapping = null;
    return null;
  }
  _cachedMapping = { ...snap.data(), uid: user.uid };
  _cachedUid = user.uid;
  return _cachedMapping;
}

// 비밀번호 변경 (현재 비밀번호 재인증 후 변경)
export async function changePassword(currentPassword, newPassword) {
  const user = await getCurrentUser();
  if (!user) throw new Error('로그인 상태가 아닙니다.');
  const cred = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, cred);
  await updatePassword(user, newPassword);
}

// ─────────────────────────────────────────────────────────────
// 회원가입 후 1회: Firebase Auth UID와 기존 학생 데이터를 매핑
// (이름 + 반 번호로 users 컬렉션에서 매칭)
// ─────────────────────────────────────────────────────────────
export async function linkProfile({ name, classNum }) {
  const user = await getCurrentUser();
  if (!user) throw new Error('로그인 상태가 아닙니다.');
  if (!user.emailVerified) throw new Error('이메일 인증이 필요합니다.');

  // 이미 매핑된 경우 그대로 반환
  const existing = await getDoc(doc(db, 'userMappings', user.uid));
  if (existing.exists()) return existing.data();

  // 이름 + 반으로 학생 검색 (firebase_uid 가 비어있는 학생만)
  const usersRef = collection(db, 'users');
  const q = query(
    usersRef,
    where('name', '==', name),
    where('class_num', '==', String(classNum))
  );
  const snap = await getDocs(q);

  const candidates = snap.docs.filter(d => !d.data().firebase_uid);
  if (candidates.length === 0) {
    if (snap.size > 0) {
      throw new Error('해당 학생은 이미 회원가입되어 있습니다. 다른 이메일로 시도하셨다면 관리자에게 문의하세요.');
    }
    throw new Error('일치하는 학생이 없습니다. 이름과 반 번호를 다시 확인하세요.');
  }
  if (candidates.length > 1) {
    throw new Error('동명이인이 있습니다. 관리자에게 문의하세요.');
  }

  const userDoc = candidates[0];
  const userData = userDoc.data();

  // userMappings 문서 생성 (보안 규칙이 검증)
  await setDoc(doc(db, 'userMappings', user.uid), {
    legacyId: userDoc.id,
    name: userData.name,
    role: userData.role,
    classNum: userData.class_num ?? null,
    createdAt: new Date().toISOString(),
  });

  // users 문서에 firebase_uid + email 기록 (1회만 가능)
  await updateDoc(doc(db, 'users', userDoc.id), {
    firebase_uid: user.uid,
    email: user.email,
  });

  // 캐시 갱신
  _cachedMapping = {
    legacyId: userDoc.id,
    name: userData.name,
    role: userData.role,
    classNum: userData.class_num ?? null,
    uid: user.uid,
  };
  _cachedUid = user.uid;

  return _cachedMapping;
}

// 페이지 진입 시 인증/권한 검사. 통과 못하면 자동 리다이렉트.
//   requireAuth() — 로그인만 필요
//   requireAuth({ role: 'admin' }) — 특정 역할 필요
//   requireAuth({ role: ['admin', 'teacher'] }) — 여러 역할 중 하나
export async function requireAuth(opts = {}) {
  const user = await getCurrentUser();
  if (!user) {
    location.href = 'login.html';
    return null;
  }
  if (!user.emailVerified) {
    location.href = 'login.html?msg=verify';
    return null;
  }

  const mapping = await getMyMapping();
  if (!mapping) {
    location.href = 'profile-link.html';
    return null;
  }

  if (opts.role) {
    const roles = Array.isArray(opts.role) ? opts.role : [opts.role];
    if (!roles.includes(mapping.role)) {
      // 역할 불일치 → 본인 역할 페이지로
      const map = { admin: 'admin.html', teacher: 'teacher.html', leader: 'leader.html', student: 'student.html' };
      location.href = map[mapping.role] || 'student.html';
      return null;
    }
  }

  return { user, mapping };
}

// 역할별 기본 페이지로 리다이렉트
export function redirectToRolePage(role) {
  const map = {
    admin: 'admin.html',
    teacher: 'teacher.html',
    leader: 'leader.html',
    student: 'student.html',
  };
  location.href = map[role] || 'student.html';
}

// ─────────────────────────────────────────────────────────────
// Classroom 동의 (Phase 2)
// ─────────────────────────────────────────────────────────────

// 이미 Classroom 동의(토큰 등록)했는지 확인
export async function hasClassroomConsent() {
  const mapping = await getMyMapping();
  if (!mapping) return false;
  const q = query(collection(db, 'tokens'), where('user_id', '==', mapping.legacyId));
  const snap = await getDocs(q);
  return !snap.empty;
}

// Google OAuth 동의 화면으로 이동 — 동의 완료 시 oauth-callback.html 로 redirect
// state 는 OAuth 명세상 ASCII 만 허용되므로 한글 ID 대신 random nonce 사용 (sessionStorage 로 검증)
export function startClassroomConsent(legacyId) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem('oauth_state', nonce);
  sessionStorage.setItem('oauth_legacy_id', legacyId);
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH.clientId,
    redirect_uri: GOOGLE_OAUTH.redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: nonce,
  });
  location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
