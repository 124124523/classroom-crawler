// users 컬렉션에서 더 이상 필요 없는 필드 제거
//   - password (평문이라 보안 위험)
//   - google_id (구 시스템 잔재)
// + firebase_uid, email 필드를 명시적으로 null 로 초기화

const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  const snap = await db.collection('users').get();
  console.log(`총 ${snap.size}개 사용자 문서 정리 시작...`);

  const BATCH_SIZE = 400;
  const docs = snap.docs;
  let processed = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + BATCH_SIZE);

    for (const doc of chunk) {
      batch.update(doc.ref, {
        password: admin.firestore.FieldValue.delete(),
        google_id: admin.firestore.FieldValue.delete(),
        firebase_uid: null,
        email: null,
      });
    }

    await batch.commit();
    processed += chunk.length;
    process.stdout.write(`\r  처리: ${processed}/${docs.length}`);
  }

  console.log(`\n✓ 완료: ${processed}개 문서 정리됨`);
  process.exit(0);
}

main().catch(err => {
  console.error('오류:', err);
  process.exit(1);
});
