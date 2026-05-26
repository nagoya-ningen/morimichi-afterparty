/* ===================================================================
   森道 After party — Firebase接続（事後モデレーション制）

   ・公開フィード型SNSをサーバコードなしで実現（クライアントSDKのみ）。
   ・公開ページ(index.html)：匿名認証。UIDはレート制限・通報用の内部IDで、
     ユーザーには表示しない。
   ・管理ページ(admin.html)：メール＋パスワードでログイン（運営者専用）。
   ・すべての投稿は status:'published' で即時公開される（事後モデレーション）。
     不適切な内容は通報経由で運営が hidden=true に切り替えて即時非表示にする。
   ・投稿の非表示・削除はクライアントの一般ユーザーからは不可
     （Security Rules で運営のみに制限）。
   ・App Check（reCAPTCHA v3）：Botによる直接書き込みを遮断。必須。

   ▼ セットアップ：firebaseConfig と RECAPTCHA_SITE_KEY を
     自分のFirebaseプロジェクトの値に置き換える（手順は README 参照）。
=================================================================== */

/* ===== セットアップ：ここを自分のプロジェクトの値に置き換える ===== */
const firebaseConfig = {
  apiKey:            'AIzaSyBfgFnnvUlE46vb9qdZtMhr5O7diJJggd8',
  authDomain:        'nagoya-ningen.firebaseapp.com',
  projectId:         'nagoya-ningen',
  storageBucket:     'nagoya-ningen.firebasestorage.app',
  messagingSenderId: '300784700896',
  appId:             '1:300784700896:web:daf20ee549b0903f66af85'
};
/* reCAPTCHA v3 のサイトキー（App Check用） */
const RECAPTCHA_SITE_KEY = '6LdE6fgsAAAAANH3mCTuXmtBzoSr02trtPs-JthY';
/* ================================================================ */

const SDK_VER = 'https://www.gstatic.com/firebasejs/10.14.1/';
const FEED_PAGE = 20;

/* 設定済みかどうか（app.js / admin.js から参照） */
export const FIREBASE_READY = firebaseConfig.apiKey.indexOf('REPLACE') === -1;

/* ---------- コア初期化（SDKロード・App Check。サインインは含まない） ---------- */
let corePromise = null;
function core() {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    if (!FIREBASE_READY) return null;
    const [appM, acM, authM, fsM] = await Promise.all([
      import(SDK_VER + 'firebase-app.js'),
      import(SDK_VER + 'firebase-app-check.js'),
      import(SDK_VER + 'firebase-auth.js'),
      import(SDK_VER + 'firebase-firestore.js')
    ]);
    const app = appM.initializeApp(firebaseConfig);
    try {
      acM.initializeAppCheck(app, {
        provider: new acM.ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
        isTokenAutoRefreshEnabled: true
      });
    } catch (e) {
      /* App Check 初期化失敗でもアプリは継続するが、運用監視のため警告を残す。
         本番で reCAPTCHA Site Key が誤っているなどの原因をログから検知する。 */
      console.warn('App Check init failed:', e);
    }
    return {
      app,
      auth: authM.getAuth(app),
      db: fsM.getFirestore(app),
      authM,
      fs: fsM
    };
  })();
  return corePromise;
}

/* ---------- 公開ページ用：匿名サインインを保証 ---------- */
let anonPromise = null;
function ensureAnon() {
  if (anonPromise) return anonPromise;
  anonPromise = (async () => {
    const c = await core();
    if (!c) return null;
    if (!c.auth.currentUser) {
      try { await c.authM.signInAnonymously(c.auth); }
      catch (e) { /* 失敗時は currentUser=null のまま */ }
    }
    return c;
  })();
  return anonPromise;
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

/* ===================================================================
   公開ページ用 API（index.html / app.js）
=================================================================== */

/* ---------- 投稿の作成 ----------
   fields: { name, days, snsUrl, body, targetType, targetId, targetName,
             clientFlags, imageUrl, imagePublicId }
   事後モデレーション制：すべての投稿は status='published' で即時公開。
   不適切なものは通報経由で運営が hidden=true で即時非表示にする。
   days: 行った曜日の配列（複数選択可） ['d1','d2','d3'] のサブセット。 */
export async function createPost(fields) {
  const c = await ensureAnon();
  if (!c) throw new Error('not-configured');
  const user = c.auth.currentUser;
  if (!user) throw new Error('auth-failed');
  const { collection, addDoc, serverTimestamp } = c.fs;
  const hasImage = !!fields.imageUrl;
  const days = Array.isArray(fields.days) ? fields.days : [];

  const ref = await addDoc(collection(c.db, 'posts'), {
    name:          fields.name,
    days:          days,
    snsUrl:        fields.snsUrl || null,
    body:          fields.body,
    targetType:    fields.targetType,
    targetId:      fields.targetId || null,
    targetName:    fields.targetName,
    imageUrl:      fields.imageUrl || null,
    imagePublicId: fields.imagePublicId || null,
    imageConsent:  hasImage,
    status:        'published',
    createdAt:     serverTimestamp(),
    authorUid:     user.uid,
    hidden:        false,
    reportCount:   0,
    clientFlags:   fields.clientFlags || []
  });
  return ref.id;
}

/* ---------- フィード取得（公開・新着順・ページネーション） ---------- */
export async function fetchFeed(cursor) {
  const c = await ensureAnon();
  if (!c) return { posts: [], lastDoc: null, hasMore: false };
  const { collection, query, where, orderBy, limit, startAfter, getDocs } = c.fs;
  const parts = [
    collection(c.db, 'posts'),
    where('hidden', '==', false),
    where('status', '==', 'published'),
    orderBy('createdAt', 'desc')
  ];
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(FEED_PAGE));
  const snap = await getDocs(query.apply(null, parts));
  return packResult(snap);
}

/* ---------- フィードのリアルタイム購読 ----------
   先頭ページ（FEED_PAGE件）の新着差分を onSnapshot で配信する。
   投稿直後にホーム画面で即時反映するために使用。
   戻り値は unsubscribe 関数。 */
export async function subscribeFeed(onChange, onError) {
  const c = await ensureAnon();
  if (!c) return function () {};
  const { collection, query, where, orderBy, limit, onSnapshot } = c.fs;
  const q = query(
    collection(c.db, 'posts'),
    where('hidden', '==', false),
    where('status', '==', 'published'),
    orderBy('createdAt', 'desc'),
    limit(FEED_PAGE)
  );
  return onSnapshot(q, function (snap) {
    const posts = [];
    snap.forEach(function (d) { const o = d.data(); o.id = d.id; posts.push(o); });
    if (onChange) onChange({
      posts: posts,
      lastDoc: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
      hasMore: snap.docs.length === FEED_PAGE
    });
  }, function (err) {
    if (onError) onError(err);
  });
}

/* ---------- 対象別の投稿取得（公開）----------
   order: 'desc'（新着順・既定）/ 'asc'（古い順）
   複合インデックスが必要（README参照）。 */
export async function fetchByTarget(targetType, targetId, cursor, order) {
  const c = await ensureAnon();
  if (!c) return { posts: [], lastDoc: null, hasMore: false };
  const { collection, query, where, orderBy, limit, startAfter, getDocs } = c.fs;
  const parts = [
    collection(c.db, 'posts'),
    where('hidden', '==', false),
    where('status', '==', 'published'),
    where('targetType', '==', targetType)
  ];
  if (targetId) parts.push(where('targetId', '==', targetId));
  parts.push(orderBy('createdAt', order === 'asc' ? 'asc' : 'desc'));
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(FEED_PAGE));
  const snap = await getDocs(query.apply(null, parts));
  return packResult(snap);
}

/* ---------- 対象別の感想件数（公開・集計クエリ） ---------- */
export async function countByTarget(targetType, targetId) {
  const c = await ensureAnon();
  if (!c) return 0;
  const { collection, query, where, getCountFromServer } = c.fs;
  const parts = [
    collection(c.db, 'posts'),
    where('hidden', '==', false),
    where('status', '==', 'published'),
    where('targetType', '==', targetType)
  ];
  if (targetId) parts.push(where('targetId', '==', targetId));
  try {
    const snap = await getCountFromServer(query.apply(null, parts));
    return snap.data().count;
  } catch (e) { return 0; }
}

/* ---------- ピン留めされた投稿の取得（最大3件・新しい順） ----------
   「今日のひとこと」セクションのフィード上部表示用。
   pinned==true の投稿のみ取得。 */
export async function fetchPinned() {
  const c = await ensureAnon();
  if (!c) return [];
  const { collection, query, where, orderBy, limit, getDocs } = c.fs;
  try {
    const snap = await getDocs(query(
      collection(c.db, 'posts'),
      where('hidden', '==', false),
      where('status', '==', 'published'),
      where('pinned', '==', true),
      orderBy('pinnedAt', 'desc'),
      limit(3)
    ));
    const posts = [];
    snap.forEach(d => { const o = d.data(); o.id = d.id; posts.push(o); });
    return posts;
  } catch (e) {
    /* インデックス未作成や 0件 で失敗した場合は空配列を返す（UI を壊さない） */
    return [];
  }
}

/* ---------- ピン留め投稿のリアルタイム購読 ---------- */
export async function subscribePinned(onChange, onError) {
  const c = await ensureAnon();
  if (!c) return function () {};
  const { collection, query, where, orderBy, limit, onSnapshot } = c.fs;
  const q = query(
    collection(c.db, 'posts'),
    where('hidden', '==', false),
    where('status', '==', 'published'),
    where('pinned', '==', true),
    orderBy('pinnedAt', 'desc'),
    limit(3)
  );
  return onSnapshot(q, function (snap) {
    const posts = [];
    snap.forEach(function (d) { const o = d.data(); o.id = d.id; posts.push(o); });
    if (onChange) onChange(posts);
  }, function (err) {
    if (onError) onError(err);
  });
}

/* ---------- リアクションの増減（+1 / -1） ----------
   key: 'wakaru' | 'sameba' | 'ikitakatta' | 'hozon'
   delta: +1 または -1
   サーバ側で increment を使い、競合に強い加算を行う。
   既存ドキュメントに reactions フィールドが無くても dot-path 更新で生成される。 */
const REACTION_KEYS = ['wakaru', 'sameba', 'ikitakatta', 'hozon'];
export async function reactToPost(postId, key, delta) {
  if (REACTION_KEYS.indexOf(key) === -1) throw new Error('invalid-key');
  if (delta !== 1 && delta !== -1) throw new Error('invalid-delta');
  const c = await ensureAnon();
  if (!c) throw new Error('not-configured');
  if (!c.auth.currentUser) throw new Error('auth-failed');
  const { doc, updateDoc, increment } = c.fs;
  const patch = {};
  patch['reactions.' + key] = increment(delta);
  await updateDoc(doc(c.db, 'posts', postId), patch);
}

/* ---------- 通報 ---------- */
export async function reportPost(postId, reason) {
  const c = await ensureAnon();
  if (!c) throw new Error('not-configured');
  if (!c.auth.currentUser) throw new Error('auth-failed');
  const { collection, addDoc, serverTimestamp } = c.fs;
  await addDoc(collection(c.db, 'reports'), {
    postId:      postId,
    reason:      reason || '',
    reporterUid: c.auth.currentUser.uid,
    createdAt:   serverTimestamp()
  });
}

/* ===================================================================
   管理ページ用 API（admin.html / admin.js）
   ※ これらは運営者が email/password でログインしている前提。
=================================================================== */

/* ---------- 管理者ログイン / ログアウト / 状態監視 ---------- */
export async function adminSignIn(email, password) {
  const c = await core();
  if (!c) throw new Error('not-configured');
  const cred = await c.authM.signInWithEmailAndPassword(c.auth, email, password);
  return cred.user;
}
export async function adminSignOut() {
  const c = await core();
  if (c) await c.authM.signOut(c.auth);
}
/* cb(user|null) を認証状態が変わるたびに呼ぶ。 */
export async function onAdminChanged(cb) {
  const c = await core();
  if (!c) { cb(null); return; }
  c.authM.onAuthStateChanged(c.auth, (u) => cb(u));
}

/* ---------- 承認待ち（画像つき pending）投稿の取得 ---------- */
export async function fetchPending(cursor) {
  const c = await core();
  if (!c) return { posts: [], lastDoc: null, hasMore: false };
  const { collection, query, where, orderBy, limit, startAfter, getDocs } = c.fs;
  const parts = [
    collection(c.db, 'posts'),
    where('status', '==', 'pending'),
    where('hidden', '==', false),
    orderBy('createdAt', 'desc')
  ];
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(FEED_PAGE));
  const snap = await getDocs(query.apply(null, parts));
  return packResult(snap);
}

/* ---------- 通報一覧の取得 ---------- */
export async function fetchReports(cursor) {
  const c = await core();
  if (!c) return { reports: [], lastDoc: null, hasMore: false };
  const { collection, query, orderBy, limit, startAfter, getDocs } = c.fs;
  const parts = [collection(c.db, 'reports'), orderBy('createdAt', 'desc')];
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(FEED_PAGE));
  const snap = await getDocs(query.apply(null, parts));
  const reports = [];
  snap.forEach(d => { const o = d.data(); o.id = d.id; reports.push(o); });
  return {
    reports: reports,
    lastDoc: snap.docs.length ? snap.docs[snap.docs.length - 1] : null,
    hasMore: snap.docs.length === FEED_PAGE
  };
}

/* ---------- 投稿1件の取得（通報された投稿の確認用） ---------- */
export async function getPost(postId) {
  const c = await core();
  if (!c) return null;
  const { doc, getDoc } = c.fs;
  const d = await getDoc(doc(c.db, 'posts', postId));
  if (!d.exists()) return null;
  const o = d.data(); o.id = d.id;
  return o;
}

/* ---------- 承認（pending → published） ---------- */
export async function approvePost(postId) {
  const c = await core();
  if (!c) throw new Error('not-configured');
  const { doc, updateDoc } = c.fs;
  await updateDoc(doc(c.db, 'posts', postId), { status: 'published' });
}

/* ---------- 非表示 / 再表示 ---------- */
export async function hidePost(postId) {
  const c = await core();
  if (!c) throw new Error('not-configured');
  const { doc, updateDoc } = c.fs;
  await updateDoc(doc(c.db, 'posts', postId), { hidden: true });
}
export async function unhidePost(postId) {
  const c = await core();
  if (!c) throw new Error('not-configured');
  const { doc, updateDoc } = c.fs;
  await updateDoc(doc(c.db, 'posts', postId), { hidden: false });
}

/* ---------- 公開済み投稿の取得（管理画面のピン留め管理タブ用） ----------
   新着順。hidden は両方含める（運営は全件閲覧可）。 */
export async function fetchPublishedForAdmin(cursor) {
  const c = await core();
  if (!c) return { posts: [], lastDoc: null, hasMore: false };
  const { collection, query, where, orderBy, limit, startAfter, getDocs } = c.fs;
  const parts = [
    collection(c.db, 'posts'),
    where('status', '==', 'published'),
    orderBy('createdAt', 'desc')
  ];
  if (cursor) parts.push(startAfter(cursor));
  parts.push(limit(FEED_PAGE));
  const snap = await getDocs(query.apply(null, parts));
  return packResult(snap);
}

/* ---------- 現在のピン留め投稿（管理画面用・運営権限で全件可視） ----------
   公開ページ側の fetchPinned と同じクエリだが、運営権限で確実に読める。 */
export async function fetchPinnedForAdmin() {
  const c = await core();
  if (!c) return [];
  const { collection, query, where, orderBy, getDocs } = c.fs;
  try {
    const snap = await getDocs(query(
      collection(c.db, 'posts'),
      where('pinned', '==', true),
      orderBy('pinnedAt', 'desc')
    ));
    const posts = [];
    snap.forEach(d => { const o = d.data(); o.id = d.id; posts.push(o); });
    return posts;
  } catch (e) {
    return [];
  }
}

/* ---------- ピン留め / 解除（管理者専用） ----------
   pin=true のときは pinnedAt をサーバ時刻で更新する。
   ピン留めは同時最大3件まで。4件目をピン留めする場合は
   一番古い（pinnedAt が最も古い）ものを自動で解除する。 */
const MAX_PINS = 3;
export async function setPostPinned(postId, pin) {
  const c = await core();
  if (!c) throw new Error('not-configured');
  const { doc, updateDoc, serverTimestamp } = c.fs;
  if (pin) {
    /* 既存のピン留めを取得し、上限を超える場合は最古を外す */
    const current = await fetchPinnedForAdmin();
    const others = current.filter(p => p.id !== postId);
    if (others.length >= MAX_PINS) {
      /* 最古（配列末尾）を外す。複数オーバーフローしても1件ずつ外す（通常は1件のはず） */
      const overflow = others.slice(MAX_PINS - 1);
      for (const op of overflow) {
        await updateDoc(doc(c.db, 'posts', op.id),
          { pinned: false, pinnedAt: null });
      }
    }
    await updateDoc(doc(c.db, 'posts', postId),
      { pinned: true, pinnedAt: serverTimestamp() });
  } else {
    await updateDoc(doc(c.db, 'posts', postId),
      { pinned: false, pinnedAt: null });
  }
}

/* ---------- 全投稿のエクスポート（バックアップ用） ---------- */
export async function fetchAllPostsForExport() {
  const c = await core();
  if (!c) return [];
  const { collection, query, orderBy, getDocs } = c.fs;
  const snap = await getDocs(
    query(collection(c.db, 'posts'), orderBy('createdAt', 'desc'))
  );
  const posts = [];
  snap.forEach(d => { const o = d.data(); o.id = d.id; posts.push(o); });
  return posts;
}
