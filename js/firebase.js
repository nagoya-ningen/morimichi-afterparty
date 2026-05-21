/* ===================================================================
   森道 After party — Firebase接続

   ・公開フィード型SNSをサーバコードなしで実現（クライアントSDKのみ）。
   ・匿名認証：起動時に signInAnonymously。UIDはレート制限・モデレーション
     用の内部IDで、ユーザーには表示しない。
   ・App Check（reCAPTCHA v3）：Botによる直接書き込みを遮断。必須。
   ・投稿の編集・削除はクライアントから不可（Security Rulesで禁止）。
   ・Firebase SDK は動的import。未設定（REPLACE_のまま）の場合は
     外部リクエストを一切行わず、アプリは閲覧不可・投稿不可で起動する。

   ▼ セットアップ：下の firebaseConfig と RECAPTCHA_SITE_KEY を
     自分のFirebaseプロジェクトの値に置き換える（手順は README 参照）。
=================================================================== */

/* ===== セットアップ：ここを自分のプロジェクトの値に置き換える ===== */
const firebaseConfig = {
  apiKey:            'REPLACE_WITH_YOUR_API_KEY',
  authDomain:        'REPLACE_PROJECT.firebaseapp.com',
  projectId:         'REPLACE_PROJECT',
  storageBucket:     'REPLACE_PROJECT.appspot.com',
  messagingSenderId: 'REPLACE_SENDER_ID',
  appId:             'REPLACE_APP_ID'
};
/* reCAPTCHA v3 のサイトキー（App Check用） */
const RECAPTCHA_SITE_KEY = 'REPLACE_WITH_RECAPTCHA_V3_SITE_KEY';
/* ================================================================ */

const SDK_VER = 'https://www.gstatic.com/firebasejs/10.14.1/';
const FEED_PAGE = 20;

function isConfigured() {
  return firebaseConfig.apiKey.indexOf('REPLACE') === -1;
}
/* 設定済みかどうかを app.js から確認するためのフラグ */
export const FIREBASE_READY = isConfigured();

/* SDKの動的ロード・初期化・匿名認証をまとめた Promise。
   未設定なら一切importせず null を返す（外部アクセスなし）。 */
const initPromise = (async () => {
  if (!FIREBASE_READY) return null;
  const [appM, acM, authM, fsM, stM] = await Promise.all([
    import(SDK_VER + 'firebase-app.js'),
    import(SDK_VER + 'firebase-app-check.js'),
    import(SDK_VER + 'firebase-auth.js'),
    import(SDK_VER + 'firebase-firestore.js'),
    import(SDK_VER + 'firebase-storage.js')
  ]);
  const app = appM.initializeApp(firebaseConfig);
  try {
    acM.initializeAppCheck(app, {
      provider: new acM.ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    });
  } catch (e) { /* App Check 初期化失敗でもアプリは継続 */ }

  const auth = authM.getAuth(app);
  const db = fsM.getFirestore(app);
  const storage = stM.getStorage(app);

  /* 匿名認証 */
  const user = await new Promise((resolve) => {
    authM.onAuthStateChanged(auth, (u) => { if (u) resolve(u); });
    authM.signInAnonymously(auth).catch(() => resolve(null));
  });

  return { app, auth, db, storage, fs: fsM, st: stM, user };
})();

/* 匿名認証の完了（user か null）を待つ Promise。 */
export const authReady = initPromise.then(c => c ? c.user : null);

/* ---------- 投稿の作成 ----------
   photo は { blob, width, height } または null。
   写真がある場合は先にIDを確保→Storageへ→setDocで一括書き込み
   （update を使わない＝Security Rules を create限定にできる）。 */
export async function createPost(fields, photo) {
  const c = await initPromise;
  if (!c) throw new Error('not-configured');
  if (!c.user) throw new Error('auth-failed');
  const { collection, doc, setDoc, serverTimestamp } = c.fs;
  const { ref: storageRef, uploadBytes } = c.st;

  const postRef = doc(collection(c.db, 'posts'));   // ID先行確保
  let photoPath = null, photoW = null, photoH = null;

  if (photo && photo.blob) {
    photoPath = 'posts/' + postRef.id + '/photo.jpg';
    await uploadBytes(storageRef(c.storage, photoPath), photo.blob,
      { contentType: 'image/jpeg' });
    photoW = photo.width || null;
    photoH = photo.height || null;
  }

  await setDoc(postRef, {
    name:        fields.name,
    day:         fields.day,
    instagram:   fields.instagram || null,
    body:        fields.body,
    targetType:  fields.targetType,
    targetId:    fields.targetId || null,
    targetName:  fields.targetName,
    photoPath:   photoPath,
    photoW:      photoW,
    photoH:      photoH,
    createdAt:   serverTimestamp(),
    authorUid:   c.user.uid,
    hidden:      false,
    reportCount: 0,
    clientFlags: fields.clientFlags || []
  });
  return postRef.id;
}

function packResult(snap) {
  const posts = [];
  snap.forEach(d => { const o = d.data(); o.id = d.id; posts.push(o); });
  return {
    posts: posts,
    lastDoc: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
    hasMore: snap.docs.length === FEED_PAGE
  };
}

/* ---------- フィード取得（新着順・ページネーション） ---------- */
export async function fetchFeed(cursor) {
  const c = await initPromise;
  if (!c) return { posts: [], lastDoc: null, hasMore: false };
  const { collection, query, where, orderBy, limit, startAfter, getDocs } = c.fs;
  const parts = [
    collection(c.db, 'posts'),
    where('hidden', '==', false),
    orderBy('createdAt', 'desc')
  ];
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(FEED_PAGE));
  const snap = await getDocs(query.apply(null, parts));
  return packResult(snap);
}

/* ---------- 対象別の投稿取得 ----------
   複合インデックスが必要（README参照）。 */
export async function fetchByTarget(targetType, targetId, cursor) {
  const c = await initPromise;
  if (!c) return { posts: [], lastDoc: null, hasMore: false };
  const { collection, query, where, orderBy, limit, startAfter, getDocs } = c.fs;
  const parts = [
    collection(c.db, 'posts'),
    where('hidden', '==', false),
    where('targetType', '==', targetType)
  ];
  if (targetId) parts.push(where('targetId', '==', targetId));
  parts.push(orderBy('createdAt', 'desc'));
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(FEED_PAGE));
  const snap = await getDocs(query.apply(null, parts));
  return packResult(snap);
}

/* ---------- 写真URLの取得 ---------- */
export async function getPhotoURL(path) {
  const c = await initPromise;
  if (!c || !path) return null;
  try {
    return await c.st.getDownloadURL(c.st.ref(c.storage, path));
  } catch (e) {
    return null;
  }
}

/* ---------- 通報 ---------- */
export async function reportPost(postId, reason) {
  const c = await initPromise;
  if (!c) throw new Error('not-configured');
  if (!c.user) throw new Error('auth-failed');
  const { collection, addDoc, serverTimestamp } = c.fs;
  await addDoc(collection(c.db, 'reports'), {
    postId:      postId,
    reason:      reason || '',
    reporterUid: c.user.uid,
    createdAt:   serverTimestamp()
  });
}
