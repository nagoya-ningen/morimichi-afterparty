/* ============================================================
   森道 After party — アプリ本体（ESM）
   data.js / ngwords.js のグローバルと firebase.js を使う。
============================================================ */
import {
  FIREBASE_READY, createPost, fetchFeed, fetchByTarget,
  countByTarget, reportPost, subscribeFeed,
  fetchPinned, subscribePinned, reactToPost
} from './firebase.js';
import {
  IMAGE_READY, ACCEPTED_TYPES, MAX_SOURCE_BYTES,
  compressImage, uploadImage
} from './image.js';

(function () {
  'use strict';

  /* ---------- データ ---------- */
  const D = window.MMA_DATA;
  const FESTIVAL = D.FESTIVAL, DATA_SOURCES = D.DATA_SOURCES;
  const ARTISTS = D.ARTISTS, SHOPS = D.SHOPS, AREAS = D.AREAS;

  /* 感想の対象タイプ。pick:true は対象（個別の名前）の選択が必要。
     iconはCSS側で `.target-tile[data-tt="…"]` を使って細い線画/タイポで描画する。
     ロジックからは「ラベル」のみを参照する設計とし、JS文字列に絵文字は持たない。 */
  const TARGET_TYPES = [
    { type: 'artist',     label: 'アーティスト', pick: true },
    { type: 'shop',       label: '出店',         pick: true },
    { type: 'area',       label: 'エリア',       pick: true },
    { type: 'festival',   label: '森道市場',     pick: false },
    { type: 'staff',      label: '運営への感謝', pick: false }
  ];
  const TT_BY_TYPE = {};
  TARGET_TYPES.forEach(t => TT_BY_TYPE[t.type] = t);

  const BODY_MIN = 5, BODY_MAX = 5000, NAME_MAX = 40;
  const COOLDOWN_MS = 30 * 1000;

  /* 削除依頼の窓口フォームURL（手動で設定する。READMEを参照） */
  const TAKEDOWN_FORM_URL = 'REPLACE_WITH_TAKEDOWN_FORM_URL';

  /* ---------- 状態 ---------- */
  const state = {
    view: 'feed',
    night: initNight(),
    feed: {
      posts: [], lastDoc: null, hasMore: false,
      loading: false, loaded: false, error: '',
      /* 絞り込み：filterType = '' は全件、'artist'|'shop'|'area'|'festival'|'staff'
         filterTarget = { id, name } を指定すると、その対象に紐づく投稿のみ */
      filterType: '',
      filterTarget: null,
      /* リアルタイム購読中の unsubscribe 関数 */
      unsub: null
    },
    /* ピン留め投稿（「今日のひとこと」セクション） */
    pinned: { posts: [], loaded: false, unsub: null },
    /* リアクション：ユーザーが押した履歴を localStorage と同期 */
    reactions: load('mma_reactions', {}),
    /* 連打防止：postId+key単位で in-flight 中をマーク */
    reactionInflight: {},
    /* ホーム画面のクイック投稿（インライン） */
    quick: {
      open: false, submitting: false, body: '', name: '',
      days: [], targetType: '', targetId: null, targetName: '',
      errors: []
    },
    form: {
      name: '', days: [], snsUrl: '', body: '',
      targetType: '', targetId: null, targetName: '', targetMode: 'pick',
      image: null, imageName: '', imagePreviewUrl: '',
      imageConsent: false, imageBusy: false, imageError: '',
      errors: [], submitting: false, piiOk: false
    },
    search: { kind: 'artist', query: '', result: null, resultTarget: null }
  };

  /* ---------- localStorage ---------- */
  function load(k, def) {
    try { const r = JSON.parse(localStorage.getItem(k)); return r == null ? def : r; }
    catch (e) { return def; }
  }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function initNight() {
    try {
      const v = localStorage.getItem('mma_night');
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) {}
    try { return window.matchMedia('(prefers-color-scheme:dark)').matches; }
    catch (e) { return false; }
  }

  /* ---------- DOMヘルパ ---------- */
  const $ = s => document.querySelector(s);
  const $$ = (s, root) => [].slice.call((root || document).querySelectorAll(s));
  function el(t, c, h) {
    const e = document.createElement(t);
    if (c) e.className = c;
    if (h != null) e.innerHTML = h;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  let toastT;
  function toast(m) {
    let t = $('#toast');
    if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = m; t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function secTitle(jp, en) {
    return el('div', 'section-title',
      '<span>' + esc(jp) + '</span><span class="en">' + esc(en) + '</span>');
  }
  function normKey(s) {
    let t;
    try { t = String(s).normalize('NFKC'); } catch (e) { t = String(s); }
    return t.toLowerCase()
      .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[　\s・･.,，、。\-‐-―ー~〜＆]/g, '');
  }
  function debounce(fn, ms) {
    let t;
    return function () {
      const a = arguments, c = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(c, a), ms);
    };
  }
  function chars(s) { return [...String(s == null ? '' : s)].length; }
  function dayLabel(id) {
    const d = FESTIVAL.days.find(x => x.id === id);
    return d ? d.label + ' ' + d.dow : id;
  }
  /* 投稿の day/days 両対応：配列なら結合して返す（例: "5/22 FRI／5/24 SUN"） */
  function daysLabel(post) {
    if (Array.isArray(post.days) && post.days.length) {
      return post.days.map(dayLabel).join('／');
    }
    if (post.day) return dayLabel(post.day);
    return '';
  }
  function timeAgo(ts) {
    if (!ts) return '';
    let d;
    try { d = ts.toDate ? ts.toDate() : new Date(ts); } catch (e) { return ''; }
    const diff = Date.now() - d.getTime();
    if (diff < 0) return 'たった今';
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'たった今';
    if (m < 60) return m + '分前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '時間前';
    const dd = Math.floor(h / 24);
    if (dd < 7) return dd + '日前';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  /* SNSのURLを正規化。任意のhttp(s) URLを受け付け、妥当なら返す（不正ならnull） */
  function normSnsUrl(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (s.length > 300) return null;
    if (!/^https?:\/\//i.test(s)) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return s;
    } catch (e) { return null; }
  }
  /* SNS URLのホスト名から表示用の {key,label} を返す。
     key は CSS の `.post-sns[data-sns="…"]` でアイコン表記を切り替えるために使う。
     文字列としては英字短縮ラベル（X, IG, TT, TH, YT, FB, NT, LK）に統一し、絵文字は使わない。 */
  function snsMeta(url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return { key: 'link', short: 'LK', label: 'リンク' }; }
    if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com')
      return { key: 'x', short: 'X', label: 'X' };
    if (host === 'instagram.com')
      return { key: 'instagram', short: 'IG', label: 'Instagram' };
    if (host === 'tiktok.com' || host === 'vt.tiktok.com')
      return { key: 'tiktok', short: 'TT', label: 'TikTok' };
    if (host === 'threads.net' || host === 'threads.com')
      return { key: 'threads', short: 'TH', label: 'Threads' };
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com')
      return { key: 'youtube', short: 'YT', label: 'YouTube' };
    if (host === 'facebook.com' || host === 'fb.com')
      return { key: 'facebook', short: 'FB', label: 'Facebook' };
    if (host === 'note.com')
      return { key: 'note', short: 'NT', label: 'note' };
    return { key: 'link', short: 'LK', label: 'リンク' };
  }

  /* ---------- ナイトモード ----------
     ボタンの表記は文字（"夜" / "朝"）。アイコン的な見せ方はCSS側で整える。 */
  function applyNight() {
    document.body.classList.toggle('night', state.night);
    const b = $('#nightBtn');
    if (b) {
      const lbl = b.querySelector('[data-night-label]') || b;
      lbl.textContent = state.night ? '朝' : '夜';
      b.setAttribute('aria-pressed', state.night ? 'true' : 'false');
      b.setAttribute('aria-label', state.night ? '昼の表示に切り替え' : '夜の表示に切り替え');
    }
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', state.night ? '#11131a' : '#fbf6ec');
  }

  /* ---------- ビュー切替 ---------- */
  function switchView(v) {
    state.view = v;
    $$('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
    $$('.tabbar button').forEach(b =>
      b.classList.toggle('active', b.dataset.view === v));
    window.scrollTo(0, 0);
    rerender();
  }
  function rerender() {
    if (state.view === 'feed') renderFeed();
    else if (state.view === 'post') renderPost();
    else if (state.view === 'search') renderSearch();
    else if (state.view === 'about') renderAbout();
  }

  /* ============================================================
     フィード（ホーム画面の中核）
     ・上端：簡易投稿カード（インライン展開）
     ・中段：絞り込みチップ（種別＋対象別）
     ・下段：投稿カード一覧（リアルタイム反映）
  ============================================================ */

  /* 共感リアクションの定義（4種固定）。
     emoji は控えめな絵文字。文字ラベルが主役で絵文字はサブ。 */
  const REACTIONS = [
    { key: 'wakaru',     label: 'わかる',         emoji: '🫶' },
    { key: 'sameba',     label: '同じ場所にいた', emoji: '📍' },
    { key: 'ikitakatta', label: '行きたかった',   emoji: '🎟️' },
    { key: 'hozon',      label: '保存',           emoji: '🔖' }
  ];
  const REACTION_KEYS = REACTIONS.map(r => r.key);

  /* localStorage に押下履歴を保存（postId → [key, ...]） */
  function getUserReactions(postId) {
    const r = state.reactions[postId];
    return Array.isArray(r) ? r : [];
  }
  function hasUserReacted(postId, key) {
    return getUserReactions(postId).indexOf(key) !== -1;
  }
  function setUserReacted(postId, key, on) {
    const cur = getUserReactions(postId).slice();
    const i = cur.indexOf(key);
    if (on && i === -1) cur.push(key);
    if (!on && i !== -1) cur.splice(i, 1);
    if (cur.length) state.reactions[postId] = cur;
    else delete state.reactions[postId];
    save('mma_reactions', state.reactions);
  }
  /* ローカルの楽観的更新用：state.feed.posts と state.pinned.posts の
     該当 post.reactions[key] を ±1 する（undefined ガード） */
  function bumpLocalReaction(postId, key, delta) {
    const apply = (p) => {
      if (!p || p.id !== postId) return;
      if (!p.reactions || typeof p.reactions !== 'object') p.reactions = {};
      const v = (typeof p.reactions[key] === 'number') ? p.reactions[key] : 0;
      p.reactions[key] = Math.max(0, v + delta);
    };
    (state.feed.posts || []).forEach(apply);
    (state.pinned.posts || []).forEach(apply);
  }

  /* リアクションのバーを生成（postCard から呼ばれる） */
  function reactionsBar(post) {
    const wrap = el('div', 'post-reactions');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', '共感リアクション');
    const counts = (post.reactions && typeof post.reactions === 'object')
      ? post.reactions : {};
    REACTIONS.forEach(r => {
      const n = (typeof counts[r.key] === 'number' && counts[r.key] > 0)
        ? counts[r.key] : 0;
      const active = hasUserReacted(post.id, r.key);
      const btn = el('button',
        'rx-btn' + (active ? ' rx-btn--active' : ''),
        '<span class="rx-emoji" aria-hidden="true">' + esc(r.emoji) + '</span>' +
        '<span class="rx-lbl">' + esc(r.label) + '</span>' +
        (n > 0 ? '<span class="rx-cnt">' + n + '</span>' : ''));
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.setAttribute('aria-label',
        r.label + '（' + (active ? '解除' : '反応する') + '・現在 ' + n + ' 件）');
      btn.onclick = () => onReactionClick(post.id, r.key, btn);
      wrap.appendChild(btn);
    });
    /* 合計件数のサマリ */
    const total = REACTION_KEYS.reduce((s, k) =>
      s + (typeof counts[k] === 'number' ? counts[k] : 0), 0);
    if (total > 0) {
      const sum = el('span', 'rx-sum', total + '人が反応');
      wrap.appendChild(sum);
    }
    return wrap;
  }

  /* リアクションのクリック処理（楽観的更新→Firestore 反映→失敗ロールバック） */
  async function onReactionClick(postId, key, btnEl) {
    if (!FIREBASE_READY) { toast('接続設定が未完了です'); return; }
    const inflightKey = postId + ':' + key;
    if (state.reactionInflight[inflightKey]) return;  /* 連打防止 */
    state.reactionInflight[inflightKey] = true;
    const wasActive = hasUserReacted(postId, key);
    const delta = wasActive ? -1 : 1;
    /* 楽観的に UI と localStorage を更新 */
    setUserReacted(postId, key, !wasActive);
    bumpLocalReaction(postId, key, delta);
    /* 差分描画：該当カードのリアクションバーだけ作り直す */
    redrawCardReactions(postId);
    try {
      await reactToPost(postId, key, delta);
    } catch (e) {
      /* 失敗：ロールバック */
      setUserReacted(postId, key, wasActive);
      bumpLocalReaction(postId, key, -delta);
      redrawCardReactions(postId);
      toast('リアクションの送信に失敗しました');
    } finally {
      delete state.reactionInflight[inflightKey];
    }
  }

  /* 該当 postId のカード（フィード／ピン留めの両方）のリアクションバーを再描画 */
  function redrawCardReactions(postId) {
    const cards = $$('.post-card[data-post-id="' + postId + '"]');
    cards.forEach(card => {
      const p = (state.feed.posts || []).find(x => x.id === postId)
             || (state.pinned.posts || []).find(x => x.id === postId);
      if (!p) return;
      const old = card.querySelector('.post-reactions');
      const fresh = reactionsBar(p);
      if (old) old.replaceWith(fresh);
      else card.appendChild(fresh);
    });
  }

  /* フィードに表示する種別フィルタ（絞り込みチップの並び） */
  const FEED_FILTERS = [
    { type: '',         label: 'すべて' },
    { type: 'artist',   label: 'アーティスト' },
    { type: 'shop',     label: '出店' },
    { type: 'area',     label: 'エリア' },
    { type: 'festival', label: '森道市場' },
    { type: 'staff',    label: '運営への感謝' }
  ];

  /* ============================================================
     「今日のひとこと」セクション（ピン留め投稿）
     ・運営が選んだ投稿（最大3件）を、通常フィードとは別デザインで提示
     ・0件のときはセクションごと出さない（DOM ノイズを減らす）
  ============================================================ */
  function renderPinnedSection() {
    const posts = state.pinned.posts || [];
    if (!posts.length) return null;
    const sec = el('section', 'pinned-section');
    sec.setAttribute('aria-label', 'ナゴヤ人間が選んだ今日のひとこと');
    const head = el('div', 'pinned-section__head',
      '<span class="pinned-section__mark" aria-hidden="true">📌</span>' +
      '<span class="pinned-section__ttl">ナゴヤ人間が選んだ今日のひとこと</span>' +
      '<span class="pinned-section__en">TODAY’S PICKS</span>');
    sec.appendChild(head);
    const list = el('div', 'pinned-section__list');
    posts.forEach(p => list.appendChild(postCard(p, { pinned: true })));
    sec.appendChild(list);
    return sec;
  }

  /* ピン留め投稿のリアルタイム購読 */
  function restartPinnedSubscribe() {
    const pn = state.pinned;
    if (pn.unsub) { try { pn.unsub(); } catch (e) {} pn.unsub = null; }
    if (!FIREBASE_READY) return;
    subscribePinned((posts) => {
      pn.posts = posts || [];
      pn.loaded = true;
      if (state.view === 'feed') renderFeed();
    }, (err) => {
      console.error('pinned subscribe failed:', err);
    }).then((un) => { pn.unsub = un; }).catch(() => {});
  }

  function renderFeed() {
    const root = $('#view-feed');
    root.innerHTML = '';

    /* 見出し＋免責（コンパクトに） */
    root.appendChild(secTitle('みんなの感想', 'FEED'));
    root.appendChild(el('div', 'disclaimer',
      'これは森、道、市場の<b>非公式ファンアプリ</b>です。主催・運営とは関係ありません。' +
      '投稿は参加者が自由に書いたもので、内容の正確性は保証されません。'));

    if (!FIREBASE_READY) {
      root.appendChild(el('div', 'card',
        '<b>接続設定が未完了です</b><p class="field__hint">' +
        'js/firebase.js にFirebaseのプロジェクトIDなどを設定すると、' +
        '投稿の保存・表示が有効になります。設定方法はREADMEを参照してください。</p>'));
      return;
    }

    /* ▼ ホーム上端：簡易投稿カード（インライン） */
    root.appendChild(renderQuickCompose());

    /* ▼ 「今日のひとこと」セクション（ピン留め投稿。0件のときは非表示） */
    const pinSec = renderPinnedSection();
    if (pinSec) root.appendChild(pinSec);

    /* ▼ 絞り込みバー（種別チップ＋対象選択） */
    root.appendChild(renderFeedFilters());

    /* ▼ フィード本体 */
    const f = state.feed;
    const list = el('div', 'feed-list');
    list.id = 'feedList';
    root.appendChild(list);

    drawFeedList();

    if (f.hasMore && !f.filterTarget) {
      const more = el('button', 'btn btn--ghost more-btn',
        f.loading ? '読み込み中…' : 'もっと見る');
      more.id = 'feedMoreBtn';
      more.disabled = f.loading;
      more.onclick = () => loadFeed(false);
      root.appendChild(more);
    }
  }

  /* フィード本体の差分描画（チップ切替時にこれだけ呼べる） */
  function drawFeedList() {
    const list = $('#feedList');
    if (!list) return;
    const f = state.feed;
    list.innerHTML = '';

    if (f.loading && !f.posts.length) {
      list.appendChild(el('div', 'loading', '読み込んでいます…'));
      return;
    }
    if (f.error) {
      list.appendChild(el('div', 'errbox', esc(f.error)));
    }

    /* クライアント側フィルタ：filterType と filterTarget が両方反映される
       （filterTarget があるときは別エンドポイントで取得済み。filterType は通常 client filter） */
    const filtered = f.filterTarget
      ? f.posts
      : (f.filterType
          ? f.posts.filter(p => p.targetType === f.filterType)
          : f.posts);

    if (!filtered.length && f.loaded) {
      const what = f.filterTarget
        ? '「' + f.filterTarget.name + '」'
        : (f.filterType ? FEED_FILTERS.find(x => x.type === f.filterType).label : '');
      const msg = what
        ? what + ' への感想はまだありません。<br>最初の感想を残してみませんか。'
        : 'まだ感想がありません。<br>最初のひとことを残してみませんか。';
      list.appendChild(el('div', 'empty', msg));
      const b = el('button', 'btn btn--primary', '感想を残す');
      b.style.margin = '12px auto 0';
      b.style.display = 'block';
      b.onclick = () => openQuickCompose();
      list.appendChild(b);
      return;
    }
    filtered.forEach(p => list.appendChild(postCard(p)));
  }

  /* 絞り込みチップバー：種別＋（対象別） */
  function renderFeedFilters() {
    const wrap = el('div', 'feed-filters');
    /* 種別チップ */
    const chips = el('div', 'chips feed-filters__kind');
    FEED_FILTERS.forEach(f => {
      const c = el('button',
        'chip' + (state.feed.filterType === f.type && !state.feed.filterTarget ? ' active' : ''),
        esc(f.label));
      c.onclick = () => {
        if (state.feed.filterTarget) {
          /* 対象別フィルタが効いているときに種別を変えたら、対象別を解除する */
          state.feed.filterTarget = null;
          loadFeed(true, { type: f.type, target: null });
        } else if (state.feed.filterType !== f.type) {
          state.feed.filterType = f.type;
          drawFeedList();
          updateFilterChips();
        }
      };
      chips.appendChild(c);
    });
    wrap.appendChild(chips);

    /* 対象別の絞り込み（任意） */
    const tgtRow = el('div', 'feed-filters__target');
    if (state.feed.filterTarget) {
      const pill = el('span', 'feed-filters__pill',
        '<span class="ff-label">対象：</span>' +
        '<span class="ff-name">' + esc(state.feed.filterTarget.name) + '</span>');
      tgtRow.appendChild(pill);
      const clear = el('button', 'feed-filters__clear', '解除');
      clear.onclick = () => {
        state.feed.filterTarget = null;
        state.feed.filterType = '';
        loadFeed(true, { type: '', target: null });
      };
      tgtRow.appendChild(clear);
    } else {
      const pick = el('button', 'feed-filters__pick',
        '<span class="en">＋</span> 対象で絞る（出店・アーティスト・エリア）');
      pick.onclick = () => openFeedTargetPicker();
      tgtRow.appendChild(pick);
    }
    wrap.appendChild(tgtRow);
    return wrap;
  }

  function updateFilterChips() {
    /* チップだけ active クラスを差し替え。再レンダリングは避ける */
    const chips = $$('.feed-filters__kind .chip');
    chips.forEach((c, i) => {
      const t = FEED_FILTERS[i].type;
      c.classList.toggle('active',
        state.feed.filterType === t && !state.feed.filterTarget);
    });
  }

  /* 対象別フィルタのピッカー（種別→対象名で1段目／2段目） */
  function openFeedTargetPicker() {
    const wrap = el('div', '');
    let kind = 'artist';
    let queryStr = '';

    function draw() {
      wrap.innerHTML = '';
      wrap.appendChild(el('div', 'modal__handle', ''));
      wrap.appendChild(el('div', 'modal__title', '対象で絞り込み'));

      const kinds = [
        { k: 'artist', label: 'アーティスト' },
        { k: 'shop',   label: '出店' },
        { k: 'area',   label: 'エリア' }
      ];
      const kindChips = el('div', 'chips');
      kindChips.style.margin = '8px 0 12px';
      kinds.forEach(kk => {
        const c = el('button',
          'chip' + (kind === kk.k ? ' active' : ''), kk.label);
        c.onclick = () => { kind = kk.k; queryStr = ''; draw(); };
        kindChips.appendChild(c);
      });
      wrap.appendChild(kindChips);

      const sb = el('div', 'searchbar');
      sb.style.position = 'static';
      sb.innerHTML = '<input class="input" id="ffPickQ" placeholder="名前で検索" value="' +
        esc(queryStr) + '">';
      wrap.appendChild(sb);

      const list = el('div', 'result-list');
      wrap.appendChild(list);

      let items;
      if (kind === 'artist') items = ARTISTS.map(a => ({ id: a.id, name: a.name, sub: '' }));
      else if (kind === 'shop')  items = SHOPS.map(s => ({ id: s.id, name: s.name, sub: s.catLabel + '・' + s.zoneName }));
      else items = AREAS.map(a => ({ id: a.id, name: a.name, sub: '' }));
      items.forEach(it => it.nk = normKey(it.name));

      const nk = normKey(queryStr || '');
      const hit = (nk ? items.filter(i => i.nk.indexOf(nk) !== -1) : items).slice(0, 60);
      if (!hit.length) {
        list.appendChild(el('div', 'empty', '該当なし'));
      } else {
        hit.forEach(it => {
          const row = el('button', 'result-row',
            '<span class="rr-main"><span class="rr-name">' + esc(it.name) + '</span>' +
            (it.sub ? '<span class="rr-sub">' + esc(it.sub) + '</span>' : '') + '</span>' +
            '<span class="rr-chev" aria-hidden="true">›</span>');
          row.onclick = () => {
            closeModal();
            state.feed.filterType = kind;
            state.feed.filterTarget = { id: it.id, name: it.name };
            loadFeed(true, { type: kind, target: { id: it.id, name: it.name } });
          };
          list.appendChild(row);
        });
      }

      const qi = wrap.querySelector('#ffPickQ');
      if (qi) qi.oninput = debounce(() => { queryStr = qi.value; draw(); }, 120);
    }
    draw();
    openModal(wrap);
  }

  function postCard(p, opts) {
    const tt = TT_BY_TYPE[p.targetType] || { label: '' };
    const isPinned = !!(opts && opts.pinned);
    const card = el('div', 'post-card' + (isPinned ? ' post-card--pinned' : ''));
    if (p && p.id) card.setAttribute('data-post-id', p.id);
    /* 対象ラベル：「種別 ／ 対象名」を文字のみで構成。視覚的な区切りはCSS側 */
    const targetKind = tt.label ? tt.label : '';
    let html = '<span class="post-target" data-tt="' + esc(p.targetType || '') + '">' +
      (targetKind ? '<span class="pt-kind">' + esc(targetKind) + '</span>' : '') +
      '<span class="pt-name">' + esc(p.targetName || tt.label) + '</span></span>';
    html += '<div class="post-body">' + esc(p.body) + '</div>';
    card.innerHTML = html;

    /* 画像（あれば本文の下にサムネイル。クリックでライトボックス） */
    if (p.imageUrl) {
      const thumb = el('button', 'post-image-wrap');
      thumb.innerHTML = '<img class="post-image" src="' + esc(p.imageUrl) +
        '" alt="投稿された写真" loading="lazy">';
      thumb.onclick = () => openLightbox(p.imageUrl);
      card.appendChild(thumb);
    }

    let meta = '<div class="post-meta">' +
      '<span class="post-name">' + esc(p.name) + '</span>' +
      '<span class="post-day">' + esc(daysLabel(p)) + '</span>';
    if (p.snsUrl) {
      const sm = snsMeta(p.snsUrl);
      meta += '<a class="post-sns" data-sns="' + esc(sm.key) + '" href="' +
        esc(p.snsUrl) + '" target="_blank" rel="noopener">' +
        '<span class="post-sns__ico" aria-hidden="true">' + esc(sm.short) + '</span>' +
        '<span class="post-sns__lbl">' + esc(sm.label) + '</span></a>';
    }
    meta += '<span class="post-time">' + esc(timeAgo(p.createdAt)) + '</span>';
    meta += '</div>';
    card.appendChild(el('div', '', meta).firstChild);

    /* 共感リアクション（4種・タップで±1） */
    card.appendChild(reactionsBar(p));

    const rep = el('button', 'post-report', '運営に知らせる');
    rep.setAttribute('aria-label', 'この投稿を運営に通報する');
    rep.style.marginTop = '8px';
    rep.onclick = () => openReport(p.id);
    card.appendChild(rep);
    return card;
  }

  /* ============================================================
     クイック投稿（ホーム画面のインラインコンポーザー）
     簡素化方針：
     ・必須は「本文」のみ。名前未入力時は「名無しの参加者」。
     ・行った曜日は「指定なし→今日（フェス期間外なら d3）」を自動補完。
       ※ Firestore Rules は days を 1〜3 件必須にしているので、空配列は不可。
     ・対象は任意（チップで森道市場／運営／その他＝詳細フォームへ）。
     ・もっと詳しく書きたいときは「詳しく書く」で従来の /post に遷移。
  ============================================================ */
  function renderQuickCompose() {
    const q = state.quick;
    const card = el('div', 'qc-card' + (q.open ? ' qc-card--open' : ''));

    if (!q.open) {
      /* 折りたたみ：プロンプトのみ */
      const prompt = el('button', 'qc-prompt',
        '<span class="qc-prompt__dot" aria-hidden="true"></span>' +
        '<span class="qc-prompt__txt">今日の森道、ひとこと残しませんか</span>');
      prompt.onclick = () => openQuickCompose();
      card.appendChild(prompt);
      return card;
    }

    /* 展開済み */
    if (q.errors.length) {
      card.appendChild(el('div', 'errbox',
        '<ul><li>' + q.errors.map(esc).join('</li><li>') + '</li></ul>'));
    }

    /* 本文 */
    const ta = el('textarea', 'textarea qc-body');
    ta.id = 'qcBody';
    ta.maxLength = BODY_MAX;
    ta.placeholder = '感想を自由に書いてください（30文字以上ですと読み応えが出ます）';
    ta.value = q.body;
    ta.oninput = () => { q.body = ta.value; updateQcCounter(); };
    card.appendChild(ta);

    /* 行：対象チップ＋曜日チップ */
    const meta = el('div', 'qc-meta');

    /* 対象タイプの素早い選択（最大3つ＋詳しく入力） */
    const tBox = el('div', 'qc-meta__row');
    tBox.appendChild(el('span', 'qc-meta__label', '対象'));
    const tChips = el('div', 'chips qc-chips');
    [
      { type: 'festival', label: '森道市場' },
      { type: 'staff',    label: '運営への感謝' }
    ].forEach(t => {
      const c = el('button', 'chip' + (q.targetType === t.type ? ' active' : ''), t.label);
      c.onclick = () => {
        q.targetType = t.type; q.targetId = null; q.targetName = t.label;
        renderFeed();
      };
      tChips.appendChild(c);
    });
    /* アーティスト・出店・エリアは1タップでピッカーを開く */
    const pickC = el('button',
      'chip' + (q.targetType && q.targetType !== 'festival' && q.targetType !== 'staff' ? ' active' : ''),
      q.targetName && q.targetType !== 'festival' && q.targetType !== 'staff'
        ? esc(q.targetName)
        : 'アーティスト・出店・エリアを選ぶ');
    pickC.onclick = () => openQuickTargetPicker();
    tChips.appendChild(pickC);
    tBox.appendChild(tChips);
    meta.appendChild(tBox);

    /* 曜日 */
    const dBox = el('div', 'qc-meta__row');
    dBox.appendChild(el('span', 'qc-meta__label', '行った日'));
    const dChips = el('div', 'chips qc-chips');
    FESTIVAL.days.forEach(d => {
      const c = el('button',
        'chip' + (q.days.indexOf(d.id) >= 0 ? ' active' : ''),
        d.label + ' ' + d.dow);
      c.onclick = () => {
        const i = q.days.indexOf(d.id);
        if (i >= 0) q.days.splice(i, 1); else q.days.push(d.id);
        renderFeed();
      };
      dChips.appendChild(c);
    });
    dBox.appendChild(dChips);
    meta.appendChild(dBox);

    /* 名前（任意） */
    const nBox = el('div', 'qc-meta__row');
    nBox.appendChild(el('span', 'qc-meta__label', '名前'));
    const nWrap = el('div', 'qc-name-wrap');
    const ni = el('input', 'input qc-name');
    ni.id = 'qcName';
    ni.maxLength = NAME_MAX;
    ni.placeholder = '空欄なら「名無しの参加者」';
    ni.value = q.name;
    ni.oninput = () => { q.name = ni.value; };
    nWrap.appendChild(ni);
    nBox.appendChild(nWrap);
    meta.appendChild(nBox);

    card.appendChild(meta);

    /* 操作行 */
    const ops = el('div', 'qc-ops');
    const counter = el('span', 'qc-counter');
    counter.id = 'qcCounter';
    ops.appendChild(counter);

    const detail = el('button', 'qc-detail', '詳しく書く ›');
    detail.onclick = () => {
      /* クイック投稿の入力内容を /post に引き継ぐ */
      state.form.name = q.name;
      state.form.body = q.body;
      state.form.days = q.days.slice();
      state.form.targetType = q.targetType;
      state.form.targetId = q.targetId;
      state.form.targetName = q.targetName;
      state.form.targetMode = (q.targetType === 'festival' || q.targetType === 'staff') ? 'pick' : 'pick';
      switchView('post');
    };
    ops.appendChild(detail);

    const cancel = el('button', 'btn btn--ghost qc-cancel', 'やめる');
    cancel.onclick = () => closeQuickCompose();
    ops.appendChild(cancel);

    const submit = el('button', 'btn btn--primary qc-submit',
      q.submitting ? '投稿中…' : '投稿する');
    submit.disabled = q.submitting;
    submit.onclick = submitQuick;
    ops.appendChild(submit);

    card.appendChild(ops);

    /* counter初期表示 */
    setTimeout(updateQcCounter, 0);
    /* 開いたらテキストエリアに自動フォーカス */
    setTimeout(() => { try { ta.focus(); } catch (e) {} }, 30);

    return card;
  }

  function updateQcCounter() {
    const c = $('#qcCounter');
    if (!c) return;
    const n = chars(state.quick.body.trim());
    c.textContent = n + ' 文字';
    c.className = 'qc-counter ' + (n >= BODY_MIN ? 'ok' : (n > 0 ? 'short' : ''));
  }

  function openQuickCompose() {
    state.quick.open = true;
    state.quick.errors = [];
    /* 既存フィルタの対象を初期値として引き継ぐと、文脈に沿った投稿になる */
    if (state.feed.filterTarget && !state.quick.targetType) {
      state.quick.targetType = state.feed.filterType;
      state.quick.targetId = state.feed.filterTarget.id;
      state.quick.targetName = state.feed.filterTarget.name;
    }
    renderFeed();
  }
  function closeQuickCompose() {
    state.quick = {
      open: false, submitting: false, body: '', name: state.quick.name || '',
      days: [], targetType: '', targetId: null, targetName: '', errors: []
    };
    renderFeed();
  }

  function openQuickTargetPicker() {
    const wrap = el('div', '');
    let kind = 'artist';
    let queryStr = '';

    function draw() {
      wrap.innerHTML = '';
      wrap.appendChild(el('div', 'modal__handle', ''));
      wrap.appendChild(el('div', 'modal__title', '対象を選ぶ'));

      const kinds = [
        { k: 'artist', label: 'アーティスト' },
        { k: 'shop',   label: '出店' },
        { k: 'area',   label: 'エリア' }
      ];
      const kindChips = el('div', 'chips');
      kindChips.style.margin = '8px 0 12px';
      kinds.forEach(kk => {
        const c = el('button',
          'chip' + (kind === kk.k ? ' active' : ''), kk.label);
        c.onclick = () => { kind = kk.k; queryStr = ''; draw(); };
        kindChips.appendChild(c);
      });
      wrap.appendChild(kindChips);

      const sb = el('div', 'searchbar');
      sb.style.position = 'static';
      sb.innerHTML = '<input class="input" id="qcPickQ" placeholder="名前で検索" value="' +
        esc(queryStr) + '">';
      wrap.appendChild(sb);

      const list = el('div', 'result-list');
      wrap.appendChild(list);

      let items;
      if (kind === 'artist') items = ARTISTS.map(a => ({ id: a.id, name: a.name, sub: '' }));
      else if (kind === 'shop')  items = SHOPS.map(s => ({ id: s.id, name: s.name, sub: s.catLabel + '・' + s.zoneName }));
      else items = AREAS.map(a => ({ id: a.id, name: a.name, sub: '' }));
      items.forEach(it => it.nk = normKey(it.name));

      const nk = normKey(queryStr || '');
      const hit = (nk ? items.filter(i => i.nk.indexOf(nk) !== -1) : items).slice(0, 60);
      if (!hit.length) {
        list.appendChild(el('div', 'empty', '該当なし'));
      } else {
        hit.forEach(it => {
          const row = el('button', 'result-row',
            '<span class="rr-main"><span class="rr-name">' + esc(it.name) + '</span>' +
            (it.sub ? '<span class="rr-sub">' + esc(it.sub) + '</span>' : '') + '</span>' +
            '<span class="rr-chev" aria-hidden="true">›</span>');
          row.onclick = () => {
            state.quick.targetType = kind;
            state.quick.targetId = it.id;
            state.quick.targetName = it.name;
            closeModal();
            renderFeed();
          };
          list.appendChild(row);
        });
      }

      const qi = wrap.querySelector('#qcPickQ');
      if (qi) qi.oninput = debounce(() => { queryStr = qi.value; draw(); }, 120);
    }
    draw();
    openModal(wrap);
  }

  async function submitQuick() {
    const q = state.quick;
    if (q.submitting) return;

    const err = [];
    const body = (q.body || '').trim();
    if (chars(body) < BODY_MIN) err.push('感想は' + BODY_MIN + '文字以上で入力してください');
    if (chars(body) > BODY_MAX) err.push('感想は' + BODY_MAX + '文字以内にしてください');
    /* 名前は任意。空なら「名無しの参加者」 */
    const name = (q.name || '').trim() || '名無しの参加者';
    if (chars(name) > NAME_MAX) err.push('名前は' + NAME_MAX + '文字以内にしてください');

    /* 曜日：未選択ならフェス期間中なら今日、期間外なら d3 を補完 */
    let days = q.days.slice();
    if (!days.length) {
      const today = new Date();
      const ymd = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
      if      (ymd === 20260522) days = ['d1'];
      else if (ymd === 20260523) days = ['d2'];
      else if (ymd === 20260524) days = ['d3'];
      else days = ['d3'];  /* 期間外は最終日に紐付け（暫定） */
    }

    /* 対象：未選択なら festival（森道市場全般） */
    let targetType = q.targetType || 'festival';
    let targetId   = q.targetId || null;
    let targetName = (q.targetName || '').trim();
    if (!targetName) {
      const tt = TT_BY_TYPE[targetType];
      targetName = tt ? tt.label : '森道市場';
    }
    /* アーティスト・出店・エリアの場合は targetId が必須相当（picker未選択ならエラー） */
    if ((targetType === 'artist' || targetType === 'shop' || targetType === 'area') && !targetId) {
      err.push('対象（' + TT_BY_TYPE[targetType].label + '）を選んでください');
    }

    if (err.length) { q.errors = err; renderFeed(); return; }

    /* 誹謗中傷フィルタ */
    const ng = ngCheck(name + '\n' + body);
    if (ng.blocked) {
      q.errors = ['不適切な表現が含まれている可能性があります。表現を見直してください。'];
      renderFeed();
      return;
    }

    /* 連投クールダウン */
    const last = load('mma_lastpost', 0);
    if (Date.now() - last < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
      toast('投稿の間隔をあけてください（あと約' + wait + '秒）');
      return;
    }

    q.submitting = true;
    q.errors = [];
    renderFeed();

    try {
      await createPost({
        name: name,
        days: days,
        snsUrl: null,
        body: body,
        targetType: targetType,
        targetId: targetId,
        targetName: targetName,
        imageUrl: null,
        imagePublicId: null,
        clientFlags: ng.soft ? ['ng_soft'] : []
      });
      save('mma_lastpost', Date.now());
      state.quick = {
        open: false, submitting: false, body: '', name: name,
        days: [], targetType: '', targetId: null, targetName: '', errors: []
      };
      toast('感想をフィードに流しました。ありがとう。');
      /* リアルタイム購読中なら数百ms以内に反映される。明示的にも一度同期 */
      loadFeed(true);
    } catch (e) {
      q.submitting = false;
      q.errors = ['投稿に失敗しました。通信環境を確認して、もう一度お試しください。'];
      renderFeed();
    }
  }

  /* ============================================================
     フィードのロード（フィルタ／対象別の切替に対応）
  ============================================================ */
  async function loadFeed(reset, opts) {
    if (!FIREBASE_READY) return;
    const f = state.feed;
    if (opts) {
      if (typeof opts.type === 'string') f.filterType = opts.type;
      if (opts.target !== undefined)     f.filterTarget = opts.target;
    }
    if (f.loading) return;
    f.loading = true;
    f.error = '';
    if (reset) { f.posts = []; f.lastDoc = null; f.hasMore = false; }
    if (state.view === 'feed') renderFeed();

    try {
      let res;
      if (f.filterTarget) {
        /* 対象別フィルタ：サーバ側でクエリして取得 */
        res = await fetchByTarget(f.filterType, f.filterTarget.id,
          reset ? null : f.lastDoc, 'desc');
      } else {
        res = await fetchFeed(reset ? null : f.lastDoc);
      }
      f.posts = f.posts.concat(res.posts);
      f.lastDoc = res.lastDoc;
      f.hasMore = res.hasMore;
    } catch (e) {
      console.error('feed load failed:', e);
      f.error = 'フィードの読み込みに失敗しました。通信環境を確認してください。';
    }
    f.loading = false;
    f.loaded = true;
    if (state.view === 'feed') renderFeed();
    /* 対象別フィルタを外したときはリアルタイム購読を再起動 */
    if (!f.filterTarget) restartFeedSubscribe();
  }

  /* リアルタイム購読の起動・停止（filterTarget が無いときだけ起動） */
  function restartFeedSubscribe() {
    const f = state.feed;
    if (f.unsub) { try { f.unsub(); } catch (e) {} f.unsub = null; }
    if (!FIREBASE_READY) return;
    if (f.filterTarget) return;  /* 対象別フィルタ時は購読しない */
    subscribeFeed((res) => {
      /* 先頭ページのみ差し替える。既に下にスクロールして読み込んだ過去分は維持 */
      const existing = f.posts.slice(res.posts.length); /* 先頭分を新着で置換 */
      /* 単純化：先頭ページ分だけは新着優先 */
      const ids = new Set(res.posts.map(p => p.id));
      const rest = f.posts.filter(p => !ids.has(p.id));
      f.posts = res.posts.concat(rest);
      if (!f.lastDoc) f.lastDoc = res.lastDoc;
      if (!f.loaded) f.hasMore = res.hasMore;
      f.loaded = true;
      f.loading = false;
      if (state.view === 'feed') drawFeedList();
    }, (err) => {
      console.error('feed subscribe failed:', err);
    }).then((un) => { f.unsub = un; }).catch(() => {});
  }

  /* ============================================================
     投稿フォーム
  ============================================================ */
  function renderPost() {
    const root = $('#view-post');
    root.innerHTML = '';
    root.appendChild(secTitle('感想を書く', 'POST'));

    if (!FIREBASE_READY) {
      root.appendChild(el('div', 'card',
        '<b>接続設定が未完了のため投稿できません</b>' +
        '<p class="field__hint">READMEのFirebaseセットアップを完了してください。</p>'));
      return;
    }

    root.appendChild(el('div', 'disclaimer',
      '投稿は<b>公開フィードに表示され、誰でも読めます</b>。' +
      'フルネーム・電話番号・住所など、個人が特定できる情報は書かないでください。'));

    const fm = state.form;
    if (fm.errors.length) {
      root.appendChild(el('div', 'errbox',
        '<ul><li>' + fm.errors.map(esc).join('</li><li>') + '</li></ul>'));
    }

    const form = el('div', '');

    /* 名前 */
    form.appendChild(fieldWrap('名前', true,
      '<input class="input" id="fName" maxlength="' + NAME_MAX +
      '" placeholder="ニックネームでOK" value="' + esc(fm.name) + '">',
      'ニックネームで構いません。本名でなくて大丈夫です。'));

    /* 曜日（複数選択可） */
    const dayBox = el('div', 'day-pick');
    FESTIVAL.days.forEach(d => {
      const lab = el('label', fm.days.indexOf(d.id) >= 0 ? 'sel' : '',
        '<b class="en">' + d.label + '</b><span>' + d.dow + '</span>');
      lab.onclick = () => {
        const idx = fm.days.indexOf(d.id);
        if (idx >= 0) fm.days.splice(idx, 1);
        else fm.days.push(d.id);
        renderPost();
      };
      dayBox.appendChild(lab);
    });
    const dayField = fieldWrap('行った曜日', true, '',
      '行った日をすべて選んでください（複数選択可）。');
    dayField.querySelector('.field__body').appendChild(dayBox);
    form.appendChild(dayField);

    /* SNSのURL */
    form.appendChild(fieldWrap('SNSのURL', false,
      '<input class="input" id="fSns" placeholder="https://… X・Instagram・TikTokなど（任意）" value="' +
      esc(fm.snsUrl) + '">',
      '投稿するとフィードにSNSリンクとして表示されます。不要なら空欄で。'));

    /* 対象タイプ — アイコンは廃止し、ラベル（文字）のみで構成。
       選択状態のときだけ、CSSで上端にヘアラインを引いて誌面のチェック印に。 */
    const tgrid = el('div', 'target-grid');
    TARGET_TYPES.forEach(t => {
      const tile = el('button',
        'target-tile' + (fm.targetType === t.type ? ' sel' : ''),
        '<span class="tl">' + esc(t.label) + '</span>');
      tile.setAttribute('data-tt', t.type);
      tile.setAttribute('aria-pressed', fm.targetType === t.type ? 'true' : 'false');
      tile.onclick = () => {
        fm.targetType = t.type;
        fm.targetId = null;
        fm.targetName = t.pick ? '' : t.label;
        fm.targetMode = 'pick';
        renderPost();
      };
      tgrid.appendChild(tile);
    });
    const ttField = fieldWrap('感想の対象', true, '', '何についての感想ですか');
    ttField.querySelector('.field__body').appendChild(tgrid);
    form.appendChild(ttField);

    /* 対象の具体選択（pick:true のときだけ）
       「リストから選ぶ／自分で入力」の2モードをトグル切替。 */
    if (fm.targetType && TT_BY_TYPE[fm.targetType].pick) {
      const ttObj = TT_BY_TYPE[fm.targetType];
      const cf = fieldWrap(ttObj.label + 'を選択', true, '', '');
      const cfBody = cf.querySelector('.field__body');

      /* モード切替トグル */
      const modeBox = el('div', 'target-mode');
      const modes = [
        { k: 'pick', label: 'リストから選ぶ' },
        { k: 'free', label: '自分で入力' }
      ];
      modes.forEach(m => {
        const c = el('button',
          'chip target-mode__chip' + (fm.targetMode === m.k ? ' active' : ''),
          m.label);
        c.setAttribute('aria-pressed', fm.targetMode === m.k ? 'true' : 'false');
        c.onclick = () => {
          if (fm.targetMode === m.k) return;
          fm.targetMode = m.k;
          /* モード切替時に他モードの入力はクリア */
          fm.targetId = null;
          fm.targetName = '';
          renderPost();
        };
        modeBox.appendChild(c);
      });
      cfBody.appendChild(modeBox);

      if (fm.targetMode === 'pick') {
        /* リスト選択モード（従来通り） */
        const chosen = el('div', 'target-chosen');
        chosen.innerHTML = fm.targetName
          ? '<span class="tc-name">' + esc(fm.targetName) + '</span>'
          : '<span class="tc-empty">未選択</span>';
        const pickLabel = (ttObj.type === 'shop' ? '店舗' : ttObj.label) + 'を選ぶ';
        const pickBtn = el('button', 'btn btn--ghost', fm.targetName ? '変更' : pickLabel);
        pickBtn.style.padding = '7px 12px';
        pickBtn.onclick = () => openTargetPicker();
        chosen.appendChild(pickBtn);
        cfBody.appendChild(chosen);
      } else {
        /* 自分で入力モード */
        const freeWrap = el('div', 'target-free');
        const placeholder = (ttObj.type === 'shop' ? '店舗名' : ttObj.label + '名') +
          'を入力（60文字以内）';
        freeWrap.innerHTML =
          '<input class="input" id="fTargetFree" maxlength="60" placeholder="' +
          esc(placeholder) + '" value="' + esc(fm.targetName) + '">';
        const hint = el('div', 'field__hint target-free__hint',
          'リストにない場合や、自分の言葉で対象を書きたいときに。');
        cfBody.appendChild(freeWrap);
        cfBody.appendChild(hint);
      }

      form.appendChild(cf);
    }

    /* 本文 */
    const bodyField = fieldWrap('感想', true,
      '<textarea class="textarea" id="fBody" maxlength="' + BODY_MAX +
      '" placeholder="30文字以上で、自由に書いてください">' + esc(fm.body) + '</textarea>',
      '');
    const counter = el('div', 'counter');
    bodyField.querySelector('.field__body').appendChild(counter);
    form.appendChild(bodyField);

    /* 写真（IMAGE_READY のときだけ） */
    if (IMAGE_READY) {
      const imgField = fieldWrap('写真', false, '',
        '写真は1枚まで。アップロード前に自動で圧縮し、位置情報（EXIF）を' +
        '削除します。不適切な投稿は通報経由で運営が即時非表示にします。');
      const imgBody = imgField.querySelector('.field__body');
      const imgBox = el('div', 'image-field');

      if (fm.imageError) {
        imgBox.appendChild(el('div', 'image-error', esc(fm.imageError)));
      }

      if (fm.image && fm.imagePreviewUrl) {
        const prev = el('div', 'image-preview');
        prev.innerHTML =
          '<img class="image-preview__thumb" src="' + esc(fm.imagePreviewUrl) +
          '" alt="選択した写真のプレビュー">';
        const rm = el('button', 'btn btn--ghost image-remove', '削除');
        rm.onclick = () => {
          clearFormImage();
          renderPost();
        };
        prev.appendChild(rm);
        imgBox.appendChild(prev);
      } else if (fm.imageBusy) {
        imgBox.appendChild(el('div', 'image-busy', '画像を処理しています…'));
      } else {
        const pick = el('label', 'image-pick',
          '<span class="image-pick__ico" aria-hidden="true">＋</span>' +
          '<span class="image-pick__txt">写真を添える</span>');
        pick.appendChild(el('input', 'image-input', ''));
        const fileI = pick.querySelector('.image-input');
        fileI.type = 'file';
        fileI.accept = 'image/*';
        fileI.onchange = () => handleImagePick(fileI.files && fileI.files[0]);
        imgBox.appendChild(pick);
      }
      imgBody.appendChild(imgBox);

      /* 画像が選択されているときだけ、必須の同意チェック */
      if (fm.image) {
        const consent = el('label', 'image-consent');
        const cb = el('input', 'image-consent__cb', '');
        cb.type = 'checkbox';
        cb.checked = !!fm.imageConsent;
        cb.onchange = () => { fm.imageConsent = cb.checked; };
        consent.appendChild(cb);
        consent.appendChild(el('span', 'image-consent__txt',
          'この写真は自分で撮影したものです。公式画像・他人の作品・他人の' +
          'SNS投稿の転載ではありません。人物が写っている場合は、本人の同意を' +
          '得ています（または個人を特定できません）。'));
        imgField.appendChild(consent);
      }

      form.appendChild(imgField);
    }

    /* 送信前リマインド：投稿後の編集・削除は不可 */
    form.appendChild(el('p', 'submit-reminder',
      '投稿すると <b>編集・削除はできません</b>。送信前に内容をご確認ください。'));

    /* 送信 */
    const submit = el('button', 'btn btn--primary btn--block btn--lg',
      fm.submitting ? '投稿中…' : 'この感想を残す');
    submit.disabled = fm.submitting;
    submit.onclick = submitPost;
    form.appendChild(submit);

    root.appendChild(form);

    /* --- 入力イベントの結線 --- */
    const nameI = $('#fName'), snsI = $('#fSns'), bodyI = $('#fBody');
    const tgtFreeI = $('#fTargetFree');
    if (nameI) nameI.oninput = () => { fm.name = nameI.value; };
    if (snsI) snsI.oninput = () => { fm.snsUrl = snsI.value; };
    if (tgtFreeI) tgtFreeI.oninput = () => { fm.targetName = tgtFreeI.value; };
    if (bodyI) {
      const upd = () => {
        fm.body = bodyI.value;
        const n = chars(bodyI.value.trim());
        counter.textContent = n + ' 文字（30文字以上）';
        counter.className = 'counter ' + (n >= BODY_MIN ? 'ok' : (n > 0 ? 'short' : ''));
      };
      bodyI.oninput = upd;
      upd();
    }
  }

  function fieldWrap(label, required, innerHtml, hint) {
    const f = el('div', 'field');
    const lab = el('div', 'field__label',
      '<span>' + esc(label) + '</span>' +
      (required ? '<span class="field__req">必須</span>'
                : '<span class="field__opt">任意</span>'));
    f.appendChild(lab);
    const body = el('div', 'field__body', innerHtml || '');
    f.appendChild(body);
    if (hint) f.appendChild(el('div', 'field__hint', esc(hint)));
    return f;
  }

  /* 画像系stateのクリア（プレビューURLは解放する） */
  function clearFormImage() {
    const fm = state.form;
    if (fm.imagePreviewUrl) {
      try { URL.revokeObjectURL(fm.imagePreviewUrl); } catch (e) {}
    }
    fm.image = null;
    fm.imageName = '';
    fm.imagePreviewUrl = '';
    fm.imageConsent = false;
    fm.imageBusy = false;
    fm.imageError = '';
  }

  /* ファイル選択時：型・サイズ検証→圧縮→プレビュー生成 */
  async function handleImagePick(file) {
    const fm = state.form;
    if (!file) return;
    clearFormImage();
    if (ACCEPTED_TYPES.indexOf(file.type) === -1) {
      fm.imageError = '対応していない画像形式です。JPEG・PNG・WebPを選んでください。';
      renderPost();
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      fm.imageError = '画像のサイズが大きすぎます（20MBまで）。';
      renderPost();
      return;
    }
    fm.imageBusy = true;
    fm.imageError = '';
    renderPost();
    try {
      const blob = await compressImage(file);
      fm.image = blob;
      fm.imageName = file.name || 'image';
      fm.imagePreviewUrl = URL.createObjectURL(blob);
      fm.imageBusy = false;
      renderPost();
    } catch (e) {
      fm.imageBusy = false;
      fm.image = null;
      fm.imageError = '画像の処理に失敗しました。別の写真でお試しください。';
      renderPost();
    }
  }

  /* 対象ピッカー（モーダル） */
  function openTargetPicker() {
    const tt = state.form.targetType;
    let items = [];
    if (tt === 'artist') {
      items = ARTISTS.map(a => ({ id: a.id, name: a.name, sub: '' }));
    } else if (tt === 'shop') {
      /* すべての出店（旧 shop / shop_brand を統合） */
      items = SHOPS.map(s => ({
        id: s.id, name: s.name, sub: s.catLabel + '・' + s.zoneName
      }));
    } else if (tt === 'area') {
      items = AREAS.map(a => ({ id: a.id, name: a.name, sub: '' }));
    } else { return; }
    items.forEach(it => it.nk = normKey(it.name));

    const wrap = el('div', '');
    const pickerLabel = tt === 'shop' ? '店舗' : TT_BY_TYPE[tt].label;
    wrap.innerHTML = '<div class="modal__handle"></div>' +
      '<div class="modal__title">' + esc(pickerLabel) + 'をさがす</div>';
    const sb = el('div', 'searchbar');
    sb.style.position = 'static';
    sb.innerHTML = '<input class="input" id="pickQ" placeholder="名前で検索">';
    wrap.appendChild(sb);
    const list = el('div', 'result-list');
    list.id = 'pickList';
    wrap.appendChild(list);

    function draw(qs) {
      const nk = normKey(qs || '');
      const hit = (nk ? items.filter(i => i.nk.indexOf(nk) !== -1) : items).slice(0, 60);
      list.innerHTML = '';
      if (!hit.length) {
        list.appendChild(el('div', 'empty', '該当なし'));
        return;
      }
      hit.forEach(it => {
        const row = el('button', 'result-row',
          '<span class="rr-main"><span class="rr-name">' + esc(it.name) + '</span>' +
          (it.sub ? '<span class="rr-sub">' + esc(it.sub) + '</span>' : '') + '</span>' +
          '<span class="rr-chev" aria-hidden="true">›</span>');
        row.onclick = () => {
          state.form.targetId = it.id;
          state.form.targetName = it.name;
          closeModal();
          renderPost();
        };
        list.appendChild(row);
      });
    }
    draw('');
    openModal(wrap);
    const qi = $('#pickQ');
    if (qi) qi.oninput = debounce(() => draw(qi.value), 120);
  }

  function validatePost() {
    const fm = state.form, err = [];
    const name = fm.name.trim();
    if (!name) err.push('名前を入力してください');
    else if (chars(name) > NAME_MAX) err.push('名前は' + NAME_MAX + '文字以内にしてください');
    if (!fm.days.length) err.push('行った曜日を選んでください（複数選択可）');
    if (!fm.targetType) err.push('感想の対象を選んでください');
    else if (TT_BY_TYPE[fm.targetType].pick) {
      const ttLabel = fm.targetType === 'shop' ? '店舗' : TT_BY_TYPE[fm.targetType].label;
      if (fm.targetMode === 'free') {
        const tname = (fm.targetName || '').trim();
        if (!tname) err.push(ttLabel + '名を入力してください');
        else if (chars(tname) > 60)
          err.push(ttLabel + '名は60文字以内にしてください');
      } else {
        if (!fm.targetId) err.push(ttLabel + 'を選択してください');
      }
    }
    const body = fm.body.trim();
    if (chars(body) < BODY_MIN) err.push('感想は' + BODY_MIN + '文字以上で入力してください');
    if (chars(body) > BODY_MAX) err.push('感想は' + BODY_MAX + '文字以内にしてください');
    if (fm.image && !fm.imageConsent)
      err.push('写真の確認事項にチェックを入れてください');
    return err;
  }

  async function submitPost() {
    const fm = state.form;
    if (fm.submitting) return;
    fm.errors = validatePost();
    if (fm.errors.length) { renderPost(); window.scrollTo(0, 0); return; }

    const name = fm.name.trim(), body = fm.body.trim();

    /* 誹謗中傷フィルタ（hard＝ブロック） */
    /* 自由入力モードの targetName も検査対象に含める */
    const ngTarget = (fm.targetMode === 'free') ? (fm.targetName || '') : '';
    const ng = ngCheck(name + '\n' + body + '\n' + ngTarget);
    if (ng.blocked) {
      fm.errors = ['不適切な表現が含まれている可能性があります。表現を見直してください。'];
      renderPost(); window.scrollTo(0, 0); return;
    }

    /* 個人情報らしき文字列の警告（ブロックはしない） */
    if (!fm.piiOk) {
      const pii = piiCheck(body);
      if (pii.hit) {
        const msg = (pii.phone ? '電話番号' : '') +
          (pii.phone && pii.email ? '・' : '') +
          (pii.email ? 'メールアドレス' : '') +
          'のような文字列が含まれています。公開フィードに表示されますが、このまま投稿しますか？';
        if (!window.confirm(msg)) { return; }
        fm.piiOk = true;
      }
    }

    /* 連投クールダウン */
    const last = load('mma_lastpost', 0);
    if (Date.now() - last < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
      toast('投稿の間隔をあけてください（あと約' + wait + '秒）');
      return;
    }

    const hasImage = !!fm.image;
    fm.submitting = true;
    renderPost();
    try {
      let imageUrl = null, imagePublicId = null;
      if (hasImage) {
        try {
          const up = await uploadImage(fm.image);
          imageUrl = up.url;
          imagePublicId = up.publicId;
        } catch (e) {
          fm.submitting = false;
          fm.errors = ['写真のアップロードに失敗しました。' +
            '通信環境を確認して、もう一度お試しください。'];
          renderPost(); window.scrollTo(0, 0);
          return;
        }
      }

      const tt = TT_BY_TYPE[fm.targetType];
      /* free モードは targetId=null・targetName=入力テキスト（trim 済み）。
         pick モードは従来通り、id と name が紐づく。 */
      const isFree = tt.pick && fm.targetMode === 'free';
      const targetIdToSave = tt.pick ? (isFree ? null : fm.targetId) : null;
      const targetNameToSave = tt.pick
        ? (isFree ? (fm.targetName || '').trim() : fm.targetName)
        : (fm.targetName || tt.label);
      await createPost({
        name: name,
        days: fm.days.slice(),
        snsUrl: normSnsUrl(fm.snsUrl),
        body: body,
        targetType: fm.targetType,
        targetId: targetIdToSave,
        targetName: targetNameToSave,
        imageUrl: imageUrl,
        imagePublicId: imagePublicId,
        clientFlags: ng.soft ? ['ng_soft'] : []
      });

      save('mma_lastpost', Date.now());
      /* フォームをリセット（画像系stateも解放） */
      clearFormImage();
      state.form = {
        name: name, days: [], snsUrl: '', body: '',
        targetType: '', targetId: null, targetName: '', targetMode: 'pick',
        image: null, imageName: '', imagePreviewUrl: '',
        imageConsent: false, imageBusy: false, imageError: '',
        errors: [], submitting: false, piiOk: false
      };
      toast('感想をフィードに流しました。ありがとう。');
      loadFeed(true);
      switchView('feed');
    } catch (e) {
      fm.submitting = false;
      fm.errors = ['投稿に失敗しました。通信環境を確認して、もう一度お試しください。'];
      renderPost(); window.scrollTo(0, 0);
    }
  }

  /* ============================================================
     さがす
  ============================================================ */
  const SEARCH_KINDS = [
    { kind: 'artist', label: 'アーティスト' },
    { kind: 'shop',   label: '出店' },
    { kind: 'area',   label: 'エリア' }
  ];

  function renderSearch() {
    const root = $('#view-search');
    root.innerHTML = '';
    root.appendChild(secTitle('対象からさがす', 'SEARCH'));
    root.appendChild(el('div', 'field__hint',
      'アーティストや店舗を選ぶと、それについての感想を読めます。'));

    const chips = el('div', 'chips');
    chips.style.margin = '10px 0';
    SEARCH_KINDS.forEach(k => {
      const c = el('button', 'chip' + (state.search.kind === k.kind ? ' active' : ''), k.label);
      c.onclick = () => {
        state.search.kind = k.kind;
        state.search.query = '';
        renderSearch();
      };
      chips.appendChild(c);
    });
    root.appendChild(chips);

    const sb = el('div', 'searchbar');
    sb.innerHTML = '<input class="input" id="searchQ" placeholder="名前で検索" value="' +
      esc(state.search.query) + '">';
    root.appendChild(sb);

    const list = el('div', 'result-list');
    list.id = 'searchList';
    root.appendChild(list);

    drawSearchList();
    const qi = $('#searchQ');
    if (qi) qi.oninput = debounce(() => {
      state.search.query = qi.value;
      drawSearchList();
    }, 120);
  }

  function searchItems(kind) {
    if (kind === 'artist')
      return ARTISTS.map(a => ({ id: a.id, name: a.name, sub: '' }));
    if (kind === 'area')
      return AREAS.map(a => ({ id: a.id, name: a.name, sub: a.type }));
    return SHOPS.filter(s => s.targetType === kind)
      .map(s => ({ id: s.id, name: s.name, sub: s.catLabel + '・' + s.zoneName }));
  }

  function drawSearchList() {
    const list = $('#searchList');
    if (!list) return;
    const kind = state.search.kind;
    const items = searchItems(kind);
    const nk = normKey(state.search.query || '');
    const hit = (nk
      ? items.filter(i => normKey(i.name).indexOf(nk) !== -1)
      : items).slice(0, 80);
    list.innerHTML = '';
    if (!hit.length) {
      list.appendChild(el('div', 'empty', '該当する対象がありません'));
      return;
    }
    hit.forEach(it => {
      const row = el('button', 'result-row',
        '<span class="rr-main"><span class="rr-name">' + esc(it.name) + '</span>' +
        (it.sub ? '<span class="rr-sub">' + esc(it.sub) + '</span>' : '') + '</span>' +
        '<span class="rr-count">感想を読む<span class="rr-chev" aria-hidden="true">›</span></span>');
      row.onclick = () => openTargetPosts(kind, it.id, it.name);
      list.appendChild(row);
    });
  }

  async function openTargetPosts(targetType, targetId, targetName) {
    let order = 'desc';

    const wrap = el('div', '');
    wrap.innerHTML = '<div class="modal__handle"></div>' +
      '<div class="modal__title">' + esc(targetName) + ' への感想</div>' +
      '<div class="tp-count" id="tpCount"></div>' +
      '<div class="tp-sort" id="tpSort"></div>' +
      '<div id="tpList"><div class="loading">読み込んでいます…</div></div>';
    openModal(wrap);

    if (!FIREBASE_READY) {
      $('#tpList').innerHTML =
        '<div class="empty">接続設定が未完了のため表示できません。</div>';
      return;
    }

    /* 並び替えトグル */
    function drawSort() {
      const sortBox = $('#tpSort');
      if (!sortBox) return;
      sortBox.innerHTML = '';
      [{ k: 'desc', label: '新着順' }, { k: 'asc', label: '古い順' }].forEach(o => {
        const c = el('button', 'chip tp-sort__chip' +
          (order === o.k ? ' active' : ''), o.label);
        c.onclick = () => {
          if (order === o.k) return;
          order = o.k;
          drawSort();
          loadList();
        };
        sortBox.appendChild(c);
      });
    }
    drawSort();

    /* 件数表示 */
    countByTarget(targetType, targetId).then(n => {
      const c = $('#tpCount');
      if (c) c.textContent = '感想 ' + n + '件';
    }).catch(() => {});

    async function loadList() {
      const box = $('#tpList');
      if (!box) return;
      box.innerHTML = '<div class="loading">読み込んでいます…</div>';
      try {
        const res = await fetchByTarget(targetType, targetId, null, order);
        if (!$('#tpList')) return;
        box.innerHTML = '';
        if (!res.posts.length) {
          box.appendChild(el('div', 'empty',
            'まだ感想がありません。<br>最初の感想を書いてみませんか。'));
          const b = el('button', 'btn btn--primary', 'この対象の感想を残す');
          b.style.margin = '12px auto 0';
          b.style.display = 'block';
          b.onclick = () => {
            state.form.targetType = targetType;
            state.form.targetId = targetId;
            state.form.targetName = targetName;
            state.form.targetMode = 'pick';
            closeModal();
            switchView('post');
          };
          box.appendChild(b);
          return;
        }
        res.posts.forEach(p => box.appendChild(postCard(p)));
      } catch (e) {
        console.error('fetchByTarget failed:', e);
        if (box) box.innerHTML =
          '<div class="errbox">感想を読み込めませんでした。少し時間をおいて、' +
          'もう一度お試しください。</div>';
      }
    }
    loadList();
  }

  /* ============================================================
     について
  ============================================================ */
  function renderAbout() {
    const root = $('#view-about');
    root.innerHTML = '';
    root.appendChild(secTitle('このアプリについて', 'ABOUT'));

    root.appendChild(el('div', 'card',
      '<b>森道 After party</b>' +
      '<p class="field__hint">森、道、市場2026の感想・思い出を残し、参加者どうしで' +
      '共有するための非公式ファンアプリです。主催・運営とは一切関係ありません。</p>'));

    root.appendChild(secTitle('プライバシーについて', 'PRIVACY'));
    root.appendChild(el('div', 'card',
      '<p class="field__hint">' +
      '・このアプリは位置情報・端末情報・アクセス解析を取得しません。<br>' +
      '・投稿に含まれるのは、あなたが自分で入力した情報（名前・曜日・SNSのURL・' +
      '感想・写真）だけです。<br>' +
      '・名前はニックネームで構いません。個人が特定できる情報は書かないでください。<br>' +
      '・写真をアップロードする際、位置情報（EXIF）は自動で削除されます。' +
      '</p>'));

    root.appendChild(secTitle('写真投稿について', 'PHOTOS'));
    root.appendChild(el('div', 'card',
      '<p class="field__hint">' +
      '・写真は自分で撮影したものだけを投稿してください。公式ビジュアル、' +
      '出演者のステージ写真、他人の作品・SNS投稿の転載はできません。<br>' +
      '・他人が写っている写真は、本人の同意を得てから投稿してください。<br>' +
      '・写真つき投稿も即時公開されます。不適切な内容は、運営が通報経由で' +
      '即時非表示にします。<br>' +
      '・アップロード時に、写真の位置情報（EXIF）は自動で削除されます。' +
      '</p>'));

    root.appendChild(secTitle('投稿のルール', 'RULES'));
    root.appendChild(el('div', 'card',
      '<p class="field__hint">' +
      '・誹謗中傷にあたる表現が含まれる投稿はできません。<br>' +
      '・事実に基づかない断定的な中傷や、営業妨害にあたる表現は投稿できません。<br>' +
      '・投稿の編集・削除はできません。書く前に内容を確認してください。<br>' +
      '・不適切な投稿を見つけたら、各投稿の「運営に知らせる」から通報してください。' +
      '運営が確認し、必要に応じて非表示にします。' +
      '</p>'));

    root.appendChild(secTitle('削除依頼の窓口', 'TAKEDOWN'));
    const takedownHasUrl = TAKEDOWN_FORM_URL.indexOf('REPLACE') === -1;
    root.appendChild(el('div', 'card',
      '<p class="field__hint">' +
      '掲載されている店舗・アーティスト・権利者の方で、投稿の削除をご希望の' +
      '場合は、以下の窓口からご連絡ください。内容を確認し、対応します。<br>' +
      (takedownHasUrl
        ? '<a href="' + esc(TAKEDOWN_FORM_URL) + '" target="_blank" ' +
          'rel="noopener">削除依頼フォームを開く</a>'
        : '運営：<a href="https://x.com/nagoya_ningen" target="_blank" ' +
          'rel="noopener">X（@nagoya_ningen）</a>のDMでお知らせください。' +
          '対象の投稿URL（または本文の抜粋）と、削除を求める理由をお伝えください。') +
      '</p>'));

    root.appendChild(secTitle('データの出典', 'SOURCE'));
    const src = el('div', 'card', '');
    let sh = '<p class="field__hint">アーティスト・店舗・エリアの一覧は、' +
      '感想の対象を選ぶための参考データです。出典は以下のとおりです。</p>';
    ['artists', 'shops', 'zones'].forEach(k => {
      const s = DATA_SOURCES[k];
      if (!s) return;
      sh += '<p class="field__hint source-item">' +
        '<span class="source-marker" aria-hidden="true"></span>' + esc(s.name) +
        '<br><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' +
        esc(s.url) + '</a><br>取得日：' + esc(s.retrieved) + '</p>';
    });
    src.innerHTML = sh;
    root.appendChild(src);

    root.appendChild(el('div', 'disclaimer',
      '日程・出演・出店などの最新かつ正確な情報は、必ず ' +
      '<a href="' + esc(FESTIVAL.official) + '" target="_blank" rel="noopener">' +
      '公式サイト</a> でご確認ください。'));
  }

  /* ============================================================
     通報
  ============================================================ */
  function openReport(postId) {
    const wrap = el('div', '');
    wrap.innerHTML = '<div class="modal__handle"></div>' +
      '<div class="modal__title">この投稿を通報する</div>' +
      '<p class="field__hint">不適切だと感じた理由を選んでください。' +
      '運営が確認します。</p>';
    const reasons = ['誹謗中傷・攻撃的', '個人情報が含まれる', 'スパム・無関係', 'その他'];
    reasons.forEach(r => {
      const b = el('button', 'btn btn--block', r);
      b.style.marginTop = '8px';
      b.onclick = () => doReport(postId, r);
      wrap.appendChild(b);
    });
    openModal(wrap);
  }
  async function doReport(postId, reason) {
    closeModal();
    if (!FIREBASE_READY) { toast('接続設定が未完了です'); return; }
    try {
      await reportPost(postId, reason);
      toast('通報を受け付けました。ありがとうございます');
    } catch (e) {
      toast('通報の送信に失敗しました');
    }
  }

  /* ============================================================
     モーダル（履歴連動）
  ============================================================ */
  let modalOpen = false, modalLastFocus = null;
  function openModal(node) {
    const body = $('#modalBody'), bg = $('#modalBg');
    body.innerHTML = '';
    body.appendChild(node);
    modalLastFocus = document.activeElement;
    bg.classList.add('open');
    if (!modalOpen) {
      modalOpen = true;
      try { history.pushState({ modal: 1 }, ''); } catch (e) {}
    }
    const first = body.querySelector('input, button, a');
    if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 30);
  }
  function closeModal(fromPop) {
    const bg = $('#modalBg');
    if (!bg.classList.contains('open')) return;
    bg.classList.remove('open');
    if (modalOpen && !fromPop) {
      modalOpen = false;
      try { history.back(); } catch (e) {}
    } else {
      modalOpen = false;
    }
    if (modalLastFocus && modalLastFocus.focus) {
      try { modalLastFocus.focus(); } catch (e) {}
    }
  }

  /* ============================================================
     ライトボックス（画像の拡大表示）
  ============================================================ */
  function openLightbox(url) {
    const wrap = el('div', '');
    wrap.innerHTML = '<div class="modal__handle"></div>' +
      '<div class="lightbox"><img class="lightbox-image" src="' + esc(url) +
      '" alt="投稿された写真"></div>';
    openModal(wrap);
  }

  /* ============================================================
     初期化
  ============================================================ */
  function init() {
    applyNight();
    const nb = $('#nightBtn');
    if (nb) nb.onclick = () => {
      state.night = !state.night;
      save('mma_night', state.night ? '1' : '0');
      applyNight();
    };
    $$('.tabbar button').forEach(b => {
      b.onclick = () => switchView(b.dataset.view);
    });
    $('#modalBg').addEventListener('click', e => {
      if (e.target.id === 'modalBg') closeModal();
    });
    window.addEventListener('popstate', () => {
      if ($('#modalBg').classList.contains('open')) closeModal(true);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });

    switchView('feed');
    loadFeed(true);
    /* リアルタイム購読を開始（初回フィードロードと並行） */
    restartFeedSubscribe();
    /* ピン留め投稿の購読も開始 */
    restartPinnedSubscribe();
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();

})();
