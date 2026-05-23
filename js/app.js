/* ============================================================
   森道 After party — アプリ本体（ESM）
   data.js / ngwords.js のグローバルと firebase.js を使う。
============================================================ */
import {
  FIREBASE_READY, createPost, fetchFeed, fetchByTarget,
  countByTarget, reportPost
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

  /* 感想の対象タイプ。pick:true は対象（個別の名前）の選択が必要。 */
  const TARGET_TYPES = [
    { type: 'artist',     icon: '🎤', label: 'アーティスト', pick: true },
    { type: 'shop',       icon: '🍜', label: '店舗',         pick: true },
    { type: 'shop_brand', icon: '🛍️', label: 'ショップ',     pick: true },
    { type: 'area',       icon: '📍', label: 'エリア',       pick: true },
    { type: 'festival',   icon: '🎪', label: '森道自体',     pick: false },
    { type: 'staff',      icon: '🙏', label: '運営への感謝', pick: false }
  ];
  const TT_BY_TYPE = {};
  TARGET_TYPES.forEach(t => TT_BY_TYPE[t.type] = t);

  const BODY_MIN = 30, BODY_MAX = 5000, NAME_MAX = 40;
  const COOLDOWN_MS = 30 * 1000;

  /* 削除依頼の窓口フォームURL（手動で設定する。READMEを参照） */
  const TAKEDOWN_FORM_URL = 'REPLACE_WITH_TAKEDOWN_FORM_URL';

  /* ---------- 状態 ---------- */
  const state = {
    view: 'feed',
    night: initNight(),
    feed: { posts: [], lastDoc: null, hasMore: false, loading: false, loaded: false, error: '' },
    form: {
      name: '', day: '', snsUrl: '', body: '',
      targetType: '', targetId: null, targetName: '',
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
  /* SNS URLのホスト名から表示用の {icon,label} を返す */
  function snsMeta(url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return { icon: '🔗', label: 'リンク' }; }
    if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com')
      return { icon: '𝕏', label: 'X' };
    if (host === 'instagram.com') return { icon: '📷', label: 'Instagram' };
    if (host === 'tiktok.com' || host === 'vt.tiktok.com')
      return { icon: '🎵', label: 'TikTok' };
    if (host === 'threads.net' || host === 'threads.com')
      return { icon: '@', label: 'Threads' };
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com')
      return { icon: '▶', label: 'YouTube' };
    if (host === 'facebook.com' || host === 'fb.com')
      return { icon: 'f', label: 'Facebook' };
    if (host === 'note.com') return { icon: '📝', label: 'note' };
    return { icon: '🔗', label: 'リンク' };
  }

  /* ---------- ナイトモード ---------- */
  function applyNight() {
    document.body.classList.toggle('night', state.night);
    const b = $('#nightBtn');
    if (b) b.textContent = state.night ? '☀️' : '🌙';
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', state.night ? '#20232f' : '#fffdf9');
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
     フィード
  ============================================================ */
  function renderFeed() {
    const root = $('#view-feed');
    root.innerHTML = '';
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

    const f = state.feed;
    if (f.loading && !f.posts.length) {
      root.appendChild(el('div', 'loading', '読み込んでいます…'));
      return;
    }
    if (f.error) {
      root.appendChild(el('div', 'errbox', esc(f.error)));
    }
    if (!f.posts.length && f.loaded) {
      const e = el('div', 'empty',
        'まだ感想がありません。<br>最初のひとことを残してみませんか。');
      root.appendChild(e);
      const b = el('button', 'btn btn--primary', '✍️ 感想を書く');
      b.style.margin = '12px auto 0';
      b.style.display = 'block';
      b.onclick = () => switchView('post');
      root.appendChild(b);
      return;
    }
    f.posts.forEach(p => root.appendChild(postCard(p)));
    if (f.hasMore) {
      const more = el('button', 'btn btn--ghost more-btn',
        f.loading ? '読み込み中…' : 'もっと見る');
      more.disabled = f.loading;
      more.onclick = () => loadFeed(false);
      root.appendChild(more);
    }
  }

  function postCard(p) {
    const tt = TT_BY_TYPE[p.targetType] || { icon: '•', label: '' };
    const card = el('div', 'post-card');
    let html = '<span class="post-target">' + tt.icon +
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
      '<span class="post-day">' + esc(dayLabel(p.day)) + '</span>';
    if (p.snsUrl) {
      const sm = snsMeta(p.snsUrl);
      meta += '<a class="post-sns" href="' + esc(p.snsUrl) +
        '" target="_blank" rel="noopener">' +
        '<span class="post-sns__ico">' + esc(sm.icon) + '</span>' +
        esc(sm.label) + '</a>';
    }
    meta += '<span class="post-time">' + esc(timeAgo(p.createdAt)) + '</span>';
    meta += '</div>';
    card.appendChild(el('div', '', meta).firstChild);

    const rep = el('button', 'post-report', '⚐ 通報');
    rep.style.marginTop = '8px';
    rep.onclick = () => openReport(p.id);
    card.appendChild(rep);
    return card;
  }

  async function loadFeed(reset) {
    if (!FIREBASE_READY) return;
    const f = state.feed;
    if (f.loading) return;
    f.loading = true;
    f.error = '';
    if (reset) { f.posts = []; f.lastDoc = null; f.hasMore = false; }
    if (state.view === 'feed') renderFeed();
    try {
      const res = await fetchFeed(reset ? null : f.lastDoc);
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

    /* 曜日 */
    const dayBox = el('div', 'day-pick');
    FESTIVAL.days.forEach(d => {
      const lab = el('label', fm.day === d.id ? 'sel' : '',
        '<b class="en">' + d.label + '</b><span>' + d.dow + '</span>');
      lab.onclick = () => { fm.day = d.id; renderPost(); };
      dayBox.appendChild(lab);
    });
    const dayField = fieldWrap('行った曜日', true, '', '');
    dayField.querySelector('.field__body').appendChild(dayBox);
    form.appendChild(dayField);

    /* SNSのURL */
    form.appendChild(fieldWrap('SNSのURL', false,
      '<input class="input" id="fSns" placeholder="https://… X・Instagram・TikTokなど（任意）" value="' +
      esc(fm.snsUrl) + '">',
      '投稿するとフィードにSNSリンクとして表示されます。不要なら空欄で。'));

    /* 対象タイプ */
    const tgrid = el('div', 'target-grid');
    TARGET_TYPES.forEach(t => {
      const tile = el('button', 'target-tile' + (fm.targetType === t.type ? ' sel' : ''),
        '<span class="ti">' + t.icon + '</span><span class="tl">' + esc(t.label) + '</span>');
      tile.onclick = () => {
        fm.targetType = t.type;
        fm.targetId = null;
        fm.targetName = t.pick ? '' : t.label;
        renderPost();
      };
      tgrid.appendChild(tile);
    });
    const ttField = fieldWrap('感想の対象', true, '', '何についての感想ですか');
    ttField.querySelector('.field__body').appendChild(tgrid);
    form.appendChild(ttField);

    /* 対象の具体選択（pick:true のときだけ） */
    if (fm.targetType && TT_BY_TYPE[fm.targetType].pick) {
      const chosen = el('div', 'target-chosen');
      chosen.innerHTML = fm.targetName
        ? '<span class="tc-name">' + esc(fm.targetName) + '</span>'
        : '<span class="tc-empty">未選択</span>';
      const pickBtn = el('button', 'btn btn--ghost', fm.targetName ? '変更' : '選ぶ');
      pickBtn.style.padding = '7px 12px';
      pickBtn.onclick = () => openTargetPicker();
      chosen.appendChild(pickBtn);
      const cf = fieldWrap(TT_BY_TYPE[fm.targetType].label + 'を選択', true, '', '');
      cf.querySelector('.field__body').appendChild(chosen);
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
        '削除します。画像つきの投稿は、運営の確認後に公開されます。');
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
          '<span class="image-pick__ico">＋</span>' +
          '<span class="image-pick__txt">写真を選ぶ</span>');
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

    /* 送信 */
    const submit = el('button', 'btn btn--primary btn--block btn--lg',
      fm.submitting ? '投稿中…' : '感想を投稿する');
    submit.disabled = fm.submitting;
    submit.onclick = submitPost;
    form.appendChild(submit);

    root.appendChild(form);

    /* --- 入力イベントの結線 --- */
    const nameI = $('#fName'), snsI = $('#fSns'), bodyI = $('#fBody');
    if (nameI) nameI.oninput = () => { fm.name = nameI.value; };
    if (snsI) snsI.oninput = () => { fm.snsUrl = snsI.value; };
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
      items = SHOPS.filter(s => s.targetType === 'shop')
        .map(s => ({ id: s.id, name: s.name, sub: s.catLabel + '・' + s.zoneName }));
    } else if (tt === 'shop_brand') {
      items = SHOPS.filter(s => s.targetType === 'shop_brand')
        .map(s => ({ id: s.id, name: s.name, sub: s.catLabel + '・' + s.zoneName }));
    } else if (tt === 'area') {
      items = AREAS.map(a => ({ id: a.id, name: a.name, sub: '' }));
    } else { return; }
    items.forEach(it => it.nk = normKey(it.name));

    const wrap = el('div', '');
    wrap.innerHTML = '<div class="modal__handle"></div>' +
      '<div class="modal__title">' + esc(TT_BY_TYPE[tt].label) + 'をさがす</div>';
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
          '<span class="rr-ico">' + TT_BY_TYPE[tt].icon + '</span>' +
          '<span class="rr-main"><span class="rr-name">' + esc(it.name) + '</span>' +
          (it.sub ? '<span class="rr-sub">' + esc(it.sub) + '</span>' : '') + '</span>');
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
    if (!fm.day) err.push('行った曜日を選んでください');
    if (!fm.targetType) err.push('感想の対象を選んでください');
    else if (TT_BY_TYPE[fm.targetType].pick && !fm.targetId)
      err.push(TT_BY_TYPE[fm.targetType].label + 'を選択してください');
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
    const ng = ngCheck(name + '\n' + body);
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
      await createPost({
        name: name,
        day: fm.day,
        snsUrl: normSnsUrl(fm.snsUrl),
        body: body,
        targetType: fm.targetType,
        targetId: tt.pick ? fm.targetId : null,
        targetName: fm.targetName || tt.label,
        imageUrl: imageUrl,
        imagePublicId: imagePublicId,
        clientFlags: ng.soft ? ['ng_soft'] : []
      });

      save('mma_lastpost', Date.now());
      /* フォームをリセット（画像系stateも解放） */
      clearFormImage();
      state.form = {
        name: name, day: '', snsUrl: '', body: '',
        targetType: '', targetId: null, targetName: '',
        image: null, imageName: '', imagePreviewUrl: '',
        imageConsent: false, imageBusy: false, imageError: '',
        errors: [], submitting: false, piiOk: false
      };
      toast(hasImage
        ? '画像つきの投稿は、運営の確認後に表示されます。ありがとうございます'
        : '感想を投稿しました。ありがとうございます');
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
    { kind: 'artist',     label: 'アーティスト' },
    { kind: 'shop',       label: '店舗' },
    { kind: 'shop_brand', label: 'ショップ' },
    { kind: 'area',       label: 'エリア' }
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
    const icon = (TT_BY_TYPE[kind] || { icon: '•' }).icon;
    hit.forEach(it => {
      const row = el('button', 'result-row',
        '<span class="rr-ico">' + icon + '</span>' +
        '<span class="rr-main"><span class="rr-name">' + esc(it.name) + '</span>' +
        (it.sub ? '<span class="rr-sub">' + esc(it.sub) + '</span>' : '') + '</span>' +
        '<span class="rr-count">感想を見る ›</span>');
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
          const b = el('button', 'btn btn--primary', '✍️ この対象の感想を書く');
          b.style.margin = '12px auto 0';
          b.style.display = 'block';
          b.onclick = () => {
            state.form.targetType = targetType;
            state.form.targetId = targetId;
            state.form.targetName = targetName;
            closeModal();
            switchView('post');
          };
          box.appendChild(b);
          return;
        }
        res.posts.forEach(p => box.appendChild(postCard(p)));
      } catch (e) {
        if (box) box.innerHTML =
          '<div class="errbox">読み込みに失敗しました。索引（複合インデックス）が' +
          '未作成の可能性があります。READMEを確認してください。</div>';
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
      '・写真つきの投稿は、運営が内容を確認してから公開されます' +
      '（即時公開ではありません）。<br>' +
      '・アップロード時に、写真の位置情報（EXIF）は自動で削除されます。' +
      '</p>'));

    root.appendChild(secTitle('投稿のルール', 'RULES'));
    root.appendChild(el('div', 'card',
      '<p class="field__hint">' +
      '・誹謗中傷にあたる表現が含まれる投稿はできません。<br>' +
      '・事実に基づかない断定的な中傷や、営業妨害にあたる表現は投稿できません。<br>' +
      '・投稿の編集・削除はできません。書く前に内容を確認してください。<br>' +
      '・不適切な投稿を見つけたら、各投稿の「⚐ 通報」から知らせてください。' +
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
        : '<span class="takedown-pending">（受付窓口は準備中です）</span>') +
      '</p>'));

    root.appendChild(secTitle('データの出典', 'SOURCE'));
    const src = el('div', 'card', '');
    let sh = '<p class="field__hint">アーティスト・店舗・エリアの一覧は、' +
      '感想の対象を選ぶための参考データです。出典は以下のとおりです。</p>';
    ['artists', 'shops', 'zones'].forEach(k => {
      const s = DATA_SOURCES[k];
      if (!s) return;
      sh += '<p class="field__hint" style="margin-top:8px">▶ ' + esc(s.name) +
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
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();

})();
