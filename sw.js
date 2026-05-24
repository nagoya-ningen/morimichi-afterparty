/* 森道 After party — Service Worker
   コード（html/css/js）はネットワーク優先＝常に最新を表示。
   アイコン画像はキャッシュ優先。
   Firebase / Google Fonts 等の外部オリジンは素通し（介入しない）。 */
const CACHE = 'mma-v8';

/* 起動に最低限必要なファイル。1つでも失敗すると addAll は全体失敗するため
   個別に add し、失敗してもインストールを止めない。
   管理画面ファイルもプリキャッシュ対象に含める（古い admin.js が
   フォールバック返却される事故を防ぐため）。 */
const CORE = [
  './',
  './index.html',
  './admin.html',
  './manifest.json',
  './css/style.css',
  './js/data.js',
  './js/ngwords.js',
  './js/image.js',
  './js/firebase.js',
  './js/app.js',
  './js/admin.js',
  './img/icon-192.png',
  './img/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(CORE.map(u => c.add(u).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isCode(url) {
  return /\.(html|css|js|json)(\?|$)/.test(url) || url.endsWith('/');
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;

  /* 同一オリジン以外（Firebase / Firestore / Google Fonts /
     reCAPTCHA 等）は一切介入せず素通し。SWがAPI通信を壊さないため。 */
  if (url.indexOf(self.location.origin) !== 0) return;

  if (isCode(url)) {
    /* コード：ネットワーク優先。オンラインなら常に最新、オフラインはキャッシュ。
       正常応答(2xx)のみ保存。多段フォールバックで最低限アプリシェルを返す。 */
    e.respondWith(
      fetch(e.request, { cache: 'reload' }).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() =>
        caches.match(e.request)
          .then(hit => hit || caches.match('./index.html'))
          .then(hit => hit || caches.match('./'))
          .then(hit => hit || new Response(
            'オフラインです。電波の良い場所で再度お試しください。',
            { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
      )
    );
  } else {
    /* アイコン等：キャッシュ優先。 */
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached || fetch(e.request).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        }).catch(() =>
          cached || new Response('', { status: 503, statusText: 'offline' })
        )
      )
    );
  }
});
