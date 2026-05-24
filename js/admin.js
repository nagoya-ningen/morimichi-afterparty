/* ===================================================================
   森道 After party — モデレーション管理画面
   運営者専用。ログイン → 承認待ち / 通報 の処理、全投稿バックアップ。
=================================================================== */

import {
  FIREBASE_READY,
  adminSignIn,
  adminSignOut,
  onAdminChanged,
  fetchPending,
  fetchReports,
  getPost,
  approvePost,
  hidePost,
  unhidePost,
  fetchAllPostsForExport,
  fetchPublishedForAdmin,
  fetchPinnedForAdmin,
  setPostPinned
} from './firebase.js';

const MAX_PINS = 3;

/* ---------- 短縮ヘルパ ---------- */
const $ = (id) => document.getElementById(id);

/* 対象種別の日本語ラベル */
const TARGET_LABEL = {
  artist:     'アーティスト',
  shop:       '出店',
  shop_brand: '出店', // 旧データ互換（移行期間中の表示用）
  area:       'エリア',
  festival:   '森道市場',
  staff:      '運営への感謝'
};

/* 曜日（day）の日本語ラベル */
const DAY_LABEL = {
  d1: '1日目',
  d2: '2日目',
  d3: '3日目'
};

/* ---------- トースト通知 ---------- */
let toastTimer = null;
function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', !!isError);
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- 日付整形（Firestore Timestamp 対応） ---------- */
function formatDate(createdAt) {
  if (!createdAt || typeof createdAt.toDate !== 'function') return '日時未確定';
  let d;
  try { d = createdAt.toDate(); } catch (e) { return '日時未確定'; }
  if (!d || isNaN(d.getTime())) return '日時未確定';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 安全なDOM生成ヘルパ ---------- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;     // textContent でXSS対策
  return node;
}

/* 画像サムネイル（タップで拡大）。imageUrl が空なら null を返す */
function buildThumb(imageUrl) {
  if (!imageUrl) return null;
  const wrap = el('div', 'thumb');
  const img = document.createElement('img');
  img.src = imageUrl;                              // 画像URL自体は src 属性に直接
  img.alt = '投稿画像';
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox(imageUrl));
  wrap.appendChild(img);
  return wrap;
}

/* ---------- 画像ライトボックス ---------- */
function openLightbox(url) {
  $('lightbox-img').src = url;
  $('lightbox').classList.add('show');
}
function closeLightbox() {
  $('lightbox').classList.remove('show');
  $('lightbox-img').src = '';
}

/* ===================================================================
   ログイン
=================================================================== */
function initLogin() {
  const form = $('login-form');
  const errBox = $('login-error');

  if (!FIREBASE_READY) {
    $('login-firebase-ng').classList.remove('hidden');
    $('login-submit').disabled = true;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!FIREBASE_READY) return;

    const email = $('login-email').value.trim();
    const password = $('login-password').value;
    const btn = $('login-submit');

    errBox.classList.add('hidden');
    errBox.textContent = '';

    if (!email || !password) {
      errBox.textContent = 'メールアドレスとパスワードを入力してください。';
      errBox.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'ログイン中…';
    try {
      await adminSignIn(email, password);
      // 成功時は onAdminChanged が画面を切り替える
    } catch (err) {
      errBox.textContent = loginErrorMessage(err);
      errBox.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'ログイン';
    }
  });
}

/* Firebase Auth のエラーを日本語に変換 */
function loginErrorMessage(err) {
  const code = (err && err.code) ? err.code : '';
  switch (code) {
    case 'auth/invalid-email':
      return 'メールアドレスの形式が正しくありません。';
    case 'auth/user-disabled':
      return 'このアカウントは無効化されています。';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'メールアドレスまたはパスワードが正しくありません。';
    case 'auth/too-many-requests':
      return '試行回数が多すぎます。しばらく待ってから再度お試しください。';
    case 'auth/network-request-failed':
      return 'ネットワークエラーです。接続を確認してください。';
    default:
      return 'ログインに失敗しました。時間をおいて再度お試しください。';
  }
}

/* ===================================================================
   承認待ちタブ
=================================================================== */
const pendingState = { cursor: null, hasMore: false, loading: false, started: false };

async function loadPending(reset) {
  if (pendingState.loading) return;
  pendingState.loading = true;

  const list = $('list-pending');
  const moreBox = $('more-pending');
  const moreBtn = moreBox.querySelector('button');

  if (reset) {
    list.innerHTML = '';
    pendingState.cursor = null;
    pendingState.hasMore = false;
  }
  if (moreBtn) moreBtn.disabled = true;

  // ローディング表示
  const loadingEl = el('div', 'loading', '読み込み中…');
  list.appendChild(loadingEl);

  try {
    const res = await fetchPending(pendingState.cursor);
    loadingEl.remove();

    const posts = (res && res.posts) || [];
    posts.forEach((post) => list.appendChild(buildPendingCard(post)));

    pendingState.cursor = (res && res.lastDoc) || null;
    pendingState.hasMore = !!(res && res.hasMore);
    pendingState.started = true;

    refreshPendingEmpty();
    moreBox.classList.toggle('hidden', !pendingState.hasMore);
  } catch (err) {
    console.error('fetchPending failed:', err);
    loadingEl.remove();
    toast('承認待ちの読み込みに失敗しました', true);
  } finally {
    if (moreBtn) moreBtn.disabled = false;
    pendingState.loading = false;
    updateCounts();
  }
}

/* 承認待ちに残っているカード数で空表示を出し分け */
function refreshPendingEmpty() {
  const list = $('list-pending');
  const hasCards = list.querySelector('.card');
  let emptyEl = list.querySelector('.empty');
  if (!hasCards && !pendingState.hasMore) {
    if (!emptyEl) {
      emptyEl = el('div', 'empty', '承認待ちの投稿はありません。');
      list.appendChild(emptyEl);
    }
  } else if (emptyEl) {
    emptyEl.remove();
  }
}

function buildPendingCard(post) {
  const card = el('div', 'card');
  card.dataset.postId = post.id;

  // 対象名・種別
  card.appendChild(el('div', 'target', post.targetName || '（対象名なし）'));
  const typeLabel = TARGET_LABEL[post.targetType] || post.targetType || '種別不明';
  card.appendChild(el('div', 'ttype', typeLabel));

  // バッジ（要注意ワード）
  const flags = Array.isArray(post.clientFlags) ? post.clientFlags : [];
  if (flags.indexOf('ng_soft') !== -1) {
    const badges = el('div', 'badges');
    badges.appendChild(el('span', 'badge badge-warn', '要注意ワード'));
    card.appendChild(badges);
  }

  // 画像
  const thumb = buildThumb(post.imageUrl);
  if (thumb) card.appendChild(thumb);

  // 本文
  card.appendChild(el('div', 'body', post.body || ''));

  // 投稿者・曜日・時刻（days配列に対応。旧day単一フィールドにもフォールバック）
  let dayLabel = '';
  if (Array.isArray(post.days) && post.days.length) {
    dayLabel = post.days.map(d => DAY_LABEL[d] || d).join('・');
  } else if (post.day) {
    dayLabel = DAY_LABEL[post.day] || post.day;
  }
  const author = el('div', 'author');
  author.textContent =
    `投稿者：${post.name || '名無し'}` +
    (dayLabel ? `／${dayLabel}` : '') +
    `／${formatDate(post.createdAt)}`;
  card.appendChild(author);

  // 操作ボタン
  const actions = el('div', 'card-actions');
  const approveBtn = el('button', 'btn btn-ok btn-sm', '承認して公開');
  const rejectBtn = el('button', 'btn btn-danger btn-sm', '非表示（却下）');

  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    try {
      await approvePost(post.id);
      toast('承認しました');
      card.remove();
      refreshPendingEmpty();
      updateCounts();
    } catch (err) {
      toast('承認に失敗しました', true);
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
  });

  rejectBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    try {
      await hidePost(post.id);
      toast('非表示（却下）にしました');
      card.remove();
      refreshPendingEmpty();
      updateCounts();
    } catch (err) {
      toast('却下に失敗しました', true);
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
  });

  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);

  return card;
}

/* ===================================================================
   通報タブ
=================================================================== */
const reportState = { cursor: null, hasMore: false, loading: false, started: false };

async function loadReports(reset) {
  if (reportState.loading) return;
  reportState.loading = true;

  const list = $('list-reports');
  const moreBox = $('more-reports');
  const moreBtn = moreBox.querySelector('button');

  if (reset) {
    list.innerHTML = '';
    reportState.cursor = null;
    reportState.hasMore = false;
  }
  if (moreBtn) moreBtn.disabled = true;

  const loadingEl = el('div', 'loading', '読み込み中…');
  list.appendChild(loadingEl);

  try {
    const res = await fetchReports(reportState.cursor);
    loadingEl.remove();

    const reports = (res && res.reports) || [];
    reports.forEach((report) => list.appendChild(buildReportCard(report)));

    reportState.cursor = (res && res.lastDoc) || null;
    reportState.hasMore = !!(res && res.hasMore);
    reportState.started = true;

    refreshReportsEmpty();
    moreBox.classList.toggle('hidden', !reportState.hasMore);
  } catch (err) {
    loadingEl.remove();
    toast('通報一覧の読み込みに失敗しました', true);
  } finally {
    if (moreBtn) moreBtn.disabled = false;
    reportState.loading = false;
    updateCounts();
  }
}

function refreshReportsEmpty() {
  const list = $('list-reports');
  const hasCards = list.querySelector('.card');
  let emptyEl = list.querySelector('.empty');
  if (!hasCards && !reportState.hasMore) {
    if (!emptyEl) {
      emptyEl = el('div', 'empty', '通報はありません。');
      list.appendChild(emptyEl);
    }
  } else if (emptyEl) {
    emptyEl.remove();
  }
}

function buildReportCard(report) {
  const card = el('div', 'card');

  // 通報理由
  const reasonText = (report.reason && String(report.reason).trim())
    ? report.reason
    : '（理由の記載なし）';
  const reason = el('div', 'body');
  reason.textContent = '通報理由：' + reasonText;
  card.appendChild(reason);

  // 通報時刻
  card.appendChild(el('div', 'meta', '通報日時：' + formatDate(report.createdAt)));

  // 投稿確認ボタン＋展開先
  const checkBtn = el('button', 'btn btn-ghost btn-sm', '投稿を確認');
  const embed = el('div', 'embed hidden');

  checkBtn.addEventListener('click', async () => {
    // 一度展開済みなら表示トグル
    if (embed.dataset.loaded === '1') {
      embed.classList.toggle('hidden');
      return;
    }
    checkBtn.disabled = true;
    checkBtn.textContent = '読み込み中…';
    try {
      const post = await getPost(report.postId);
      embed.innerHTML = '';
      if (!post) {
        embed.appendChild(el('div', 'meta', '投稿が見つかりません（削除済み）。'));
      } else {
        renderEmbeddedPost(embed, post);
      }
      embed.dataset.loaded = '1';
      embed.classList.remove('hidden');
      checkBtn.textContent = '投稿の表示／非表示';
      checkBtn.disabled = false;
    } catch (err) {
      toast('投稿の取得に失敗しました', true);
      checkBtn.textContent = '投稿を確認';
      checkBtn.disabled = false;
    }
  });

  card.appendChild(checkBtn);
  card.appendChild(embed);
  return card;
}

/* 通報カード内に投稿内容を展開描画（再描画可能） */
function renderEmbeddedPost(container, post) {
  container.innerHTML = '';

  // 対象名・種別
  container.appendChild(el('div', 'target', post.targetName || '（対象名なし）'));
  const typeLabel = TARGET_LABEL[post.targetType] || post.targetType || '種別不明';
  container.appendChild(el('div', 'ttype', typeLabel));

  // 状態バッジ（status / hidden）
  const badges = el('div', 'badges');
  if (post.status === 'pending') {
    badges.appendChild(el('span', 'badge badge-status', '承認待ち'));
  } else {
    badges.appendChild(el('span', 'badge badge-pub', '公開済み'));
  }
  if (post.hidden) {
    badges.appendChild(el('span', 'badge badge-hidden', '非表示中'));
  } else {
    badges.appendChild(el('span', 'badge badge-status', '表示中'));
  }
  container.appendChild(badges);

  // 画像
  const thumb = buildThumb(post.imageUrl);
  if (thumb) container.appendChild(thumb);

  // 本文
  container.appendChild(el('div', 'body', post.body || ''));

  // 投稿者・時刻
  const author = el('div', 'author');
  author.textContent =
    `投稿者：${post.name || '名無し'}／${formatDate(post.createdAt)}`;
  container.appendChild(author);

  // 操作ボタン（非表示 / 再表示）
  const actions = el('div', 'card-actions');
  const hideBtn = el('button', 'btn btn-danger btn-sm', '非表示にする');
  const showBtn = el('button', 'btn btn-ok btn-sm', '再表示する');

  // 現在の状態に応じてボタンを出し分け
  hideBtn.disabled = !!post.hidden;
  showBtn.disabled = !post.hidden;

  hideBtn.addEventListener('click', async () => {
    hideBtn.disabled = true;
    showBtn.disabled = true;
    try {
      await hidePost(post.id);
      toast('非表示にしました');
      post.hidden = true;
      renderEmbeddedPost(container, post);
    } catch (err) {
      toast('非表示に失敗しました', true);
      hideBtn.disabled = !!post.hidden;
      showBtn.disabled = !post.hidden;
    }
  });

  showBtn.addEventListener('click', async () => {
    hideBtn.disabled = true;
    showBtn.disabled = true;
    try {
      await unhidePost(post.id);
      toast('再表示しました');
      post.hidden = false;
      renderEmbeddedPost(container, post);
    } catch (err) {
      toast('再表示に失敗しました', true);
      hideBtn.disabled = !!post.hidden;
      showBtn.disabled = !post.hidden;
    }
  });

  actions.appendChild(hideBtn);
  actions.appendChild(showBtn);
  container.appendChild(actions);
}

/* ===================================================================
   ピン留めタブ
=================================================================== */
const pinnedState = {
  cursor: null, hasMore: false, loading: false, started: false,
  pinnedIds: new Set()
};

async function loadPinned(reset) {
  if (pinnedState.loading) return;
  pinnedState.loading = true;

  const list = $('list-pinned');
  const cur = $('list-pinned-current');
  const moreBox = $('more-pinned');
  const moreBtn = moreBox.querySelector('button');

  if (reset) {
    list.innerHTML = '';
    cur.innerHTML = '';
    pinnedState.cursor = null;
    pinnedState.hasMore = false;
    pinnedState.pinnedIds = new Set();
  }
  if (moreBtn) moreBtn.disabled = true;

  const loadingEl = el('div', 'loading', '読み込み中…');
  list.appendChild(loadingEl);

  try {
    /* 現在ピン留め中の投稿を上部に固めて表示 */
    if (reset) {
      const pins = await fetchPinnedForAdmin();
      pinnedState.pinnedIds = new Set(pins.map(p => p.id));
      if (pins.length) {
        const head = el('div', 'pinned-head',
          `現在ピン留め中：${pins.length} / ${MAX_PINS}`);
        head.style.cssText =
          'font-family:var(--font-en);font-size:11px;letter-spacing:.14em;' +
          'text-transform:uppercase;color:var(--muted);font-weight:700;margin:8px 0 6px;';
        cur.appendChild(head);
        pins.forEach(p => cur.appendChild(buildPinnableCard(p)));
      } else {
        const empty = el('div', 'empty', '現在ピン留めされている投稿はありません。');
        empty.style.padding = '20px 0';
        cur.appendChild(empty);
      }
    }

    /* 公開投稿の一覧（ピン留め候補） */
    const res = await fetchPublishedForAdmin(pinnedState.cursor);
    loadingEl.remove();
    const posts = (res && res.posts) || [];
    posts.forEach((post) => {
      /* 既にピン留め済みのものは「現在ピン留め中」セクションに出ているので、ここでは出さない */
      if (pinnedState.pinnedIds.has(post.id)) return;
      list.appendChild(buildPinnableCard(post));
    });

    pinnedState.cursor = (res && res.lastDoc) || null;
    pinnedState.hasMore = !!(res && res.hasMore);
    pinnedState.started = true;

    moreBox.classList.toggle('hidden', !pinnedState.hasMore);
    updateCounts();
  } catch (err) {
    console.error('loadPinned failed:', err);
    loadingEl.remove();
    toast('公開投稿の読み込みに失敗しました', true);
  } finally {
    if (moreBtn) moreBtn.disabled = false;
    pinnedState.loading = false;
  }
}

/* ピン留め切り替えボタン付きのカード */
function buildPinnableCard(post) {
  const card = el('div', 'card');
  card.dataset.postId = post.id;

  card.appendChild(el('div', 'target', post.targetName || '（対象名なし）'));
  const typeLabel = TARGET_LABEL[post.targetType] || post.targetType || '種別不明';
  card.appendChild(el('div', 'ttype', typeLabel));

  /* 状態バッジ */
  const badges = el('div', 'badges');
  if (post.pinned) {
    badges.appendChild(el('span', 'badge badge-pub', 'ピン留め中'));
  }
  if (post.hidden) {
    badges.appendChild(el('span', 'badge badge-hidden', '非表示中'));
  }
  if (badges.children.length) card.appendChild(badges);

  const thumb = buildThumb(post.imageUrl);
  if (thumb) card.appendChild(thumb);

  card.appendChild(el('div', 'body', post.body || ''));

  let dayLabel = '';
  if (Array.isArray(post.days) && post.days.length) {
    dayLabel = post.days.map(d => DAY_LABEL[d] || d).join('・');
  } else if (post.day) {
    dayLabel = DAY_LABEL[post.day] || post.day;
  }
  const author = el('div', 'author');
  author.textContent =
    `投稿者：${post.name || '名無し'}` +
    (dayLabel ? `／${dayLabel}` : '') +
    `／${formatDate(post.createdAt)}`;
  card.appendChild(author);

  /* ピン留め / 解除ボタン */
  const actions = el('div', 'card-actions');
  const isPinned = !!post.pinned;
  const pinBtn = el('button',
    'btn btn-sm ' + (isPinned ? 'btn-danger' : 'btn-ok'),
    isPinned ? '📌 ピン留めを解除' : '📌 ピン留め');
  pinBtn.setAttribute('aria-label',
    isPinned ? 'この投稿のピン留めを解除する' : 'この投稿をピン留めする');
  pinBtn.addEventListener('click', async () => {
    pinBtn.disabled = true;
    const original = pinBtn.textContent;
    pinBtn.textContent = isPinned ? '解除中…' : 'ピン留め中…';
    try {
      await setPostPinned(post.id, !isPinned);
      toast(isPinned ? 'ピン留めを解除しました' : 'ピン留めしました');
      /* 状態をリロードして反映 */
      loadPinned(true);
    } catch (err) {
      console.error('setPostPinned failed:', err);
      toast(isPinned ? '解除に失敗しました' : 'ピン留めに失敗しました', true);
      pinBtn.disabled = false;
      pinBtn.textContent = original;
    }
  });
  actions.appendChild(pinBtn);
  card.appendChild(actions);

  return card;
}

/* ===================================================================
   タブ切り替え
=================================================================== */
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  $('panel-pending').classList.toggle('hidden', name !== 'pending');
  $('panel-reports').classList.toggle('hidden', name !== 'reports');
  $('panel-pinned').classList.toggle('hidden', name !== 'pinned');

  // 初回表示時にロード
  if (name === 'pending' && !pendingState.started) loadPending(true);
  if (name === 'reports' && !reportState.started) loadReports(true);
  if (name === 'pinned' && !pinnedState.started) loadPinned(true);
}

/* タブのカウントバッジを更新（現在描画中のカード数を表示） */
function updateCounts() {
  const pCount = $('list-pending').querySelectorAll('.card').length;
  const rCount = $('list-reports').querySelectorAll('.card').length;
  const pinCount = pinnedState.pinnedIds ? pinnedState.pinnedIds.size : 0;

  const pBadge = $('cnt-pending');
  const rBadge = $('cnt-reports');
  const pinBadge = $('cnt-pinned');

  if (pendingState.started && pCount > 0) {
    pBadge.textContent = pendingState.hasMore ? `${pCount}+` : String(pCount);
    pBadge.classList.remove('hidden');
  } else {
    pBadge.classList.add('hidden');
  }
  if (reportState.started && rCount > 0) {
    rBadge.textContent = reportState.hasMore ? `${rCount}+` : String(rCount);
    rBadge.classList.remove('hidden');
  } else {
    rBadge.classList.add('hidden');
  }
  if (pinnedState.started && pinCount > 0) {
    pinBadge.textContent = `${pinCount}/${MAX_PINS}`;
    pinBadge.classList.remove('hidden');
  } else {
    pinBadge.classList.add('hidden');
  }
}

/* ===================================================================
   バックアップ（全投稿 JSON ダウンロード）
=================================================================== */
function initBackup() {
  const btn = $('backup-btn');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'バックアップ作成中…';
    try {
      const posts = await fetchAllPostsForExport();

      // Firestore Timestamp は JSON.stringify でうまく出ないため整形
      const safe = (posts || []).map((p) => {
        const out = {};
        for (const key in p) {
          if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
          const val = p[key];
          if (val && typeof val.toDate === 'function') {
            try { out[key] = val.toDate().toISOString(); }
            catch (e) { out[key] = null; }
          } else {
            out[key] = val;
          }
        }
        return out;
      });

      const now = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const dateStr =
        `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;

      const payload = {
        exportedAt: now.toISOString(),
        count: safe.length,
        posts: safe
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)],
        { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `morimichi-afterparty-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      toast(`${safe.length}件をバックアップしました`);
    } catch (err) {
      toast('バックアップに失敗しました', true);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

/* ===================================================================
   ログイン状態の監視 → 画面切り替え
=================================================================== */
function showLoginView() {
  $('view-login').classList.remove('hidden');
  $('view-admin').classList.add('hidden');
}

function showAdminView(user) {
  $('view-login').classList.add('hidden');
  $('view-admin').classList.remove('hidden');
  $('admin-email').textContent = (user && user.email) ? user.email : '';

  // ログインボタンを初期状態に戻す
  const lb = $('login-submit');
  if (lb && FIREBASE_READY) { lb.disabled = false; lb.textContent = 'ログイン'; }

  // 通報タブを初期表示としてロード（未ロード時のみ）
  // 事後モデレーション制のため、承認待ち（pending）は原則発生しない。
  if (!reportState.started) loadReports(true);
}

/* ===================================================================
   起動
=================================================================== */
function init() {
  initLogin();
  initTabs();
  initBackup();

  // ログアウト
  $('logout-btn').addEventListener('click', async () => {
    const btn = $('logout-btn');
    btn.disabled = true;
    try {
      await adminSignOut();
    } catch (e) {
      toast('ログアウトに失敗しました', true);
    } finally {
      btn.disabled = false;
    }
  });

  // ライトボックス閉じる
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => {
    if (e.target === $('lightbox')) closeLightbox();
  });

  // 認証状態の監視
  onAdminChanged((user) => {
    if (user) {
      showAdminView(user);
    } else {
      // ログアウト時は状態をリセットして次回ログインで再取得
      pendingState.cursor = null;
      pendingState.started = false;
      pendingState.hasMore = false;
      reportState.cursor = null;
      reportState.started = false;
      reportState.hasMore = false;
      pinnedState.cursor = null;
      pinnedState.started = false;
      pinnedState.hasMore = false;
      pinnedState.pinnedIds = new Set();
      $('list-pending').innerHTML = '';
      $('list-reports').innerHTML = '';
      $('list-pinned').innerHTML = '';
      $('list-pinned-current').innerHTML = '';
      showLoginView();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
