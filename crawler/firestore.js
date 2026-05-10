// Firestore Admin SDK 초기화 (서비스 계정 인증)
// GitHub Actions 환경에서는 FIREBASE_SERVICE_ACCOUNT secret 을 JSON 문자열로 받음.
// 로컬 실행 시에는 ../serviceAccountKey.json 사용.

const admin = require('firebase-admin');

let credential;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // GitHub Actions: secret 에서 JSON 문자열로 받음
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  credential = admin.credential.cert(sa);
} else {
  // 로컬 실행
  const sa = require('../serviceAccountKey.json');
  credential = admin.credential.cert(sa);
}

if (!admin.apps.length) {
  admin.initializeApp({ credential });
}

const db = admin.firestore();
module.exports = { admin, db };
