/* ============================================================
   森道 After party — アプリ本体（ESM）
   data.js / ngwords.js / exif.js のグローバルと firebase.js を使う。
============================================================ */
import {
  FIREBASE_READY, authReady, createPost, fetchFeed, fetchByTarget,
  getPhotoURL, reportPost
} from './firebase.js';

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

  /* ---------- 状態 ---------- */
  const state = {
    view: 'feed',
    night: initNight(),
    feed: { posts: [], lastDoc: null, hasMore: false, loading: false, loaded: false, error: '' },
    form: {
      name: '', day: '', instagram: '', body: '',
      targetType: '', targetId: null, targetName: '',
      photo: null,          // { blob, width, height, url }
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
  /* Instagram入力をURL/＠付き/素handleのいずれからも @handle へ正規化 */
  function normInstagram(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    const m = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
    if (m) s = m[1];
    s = s.replace(/^@/, '').replace(/[\/?].*$/, '');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(s)) return null;
    return '@' + s;
  }

  /* ---------- ナイトモード ---------- */
  function applyNight() {
    document.body.classList.toggle('night', state.night);
    const b = $('#nightBtn');
    if (b) b.textContent = state.night ? '☀️' : '🌙';
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', state.night ? '#15171c' : '#de1815');
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
    hydratePhotos(root);
  }

  function postCard(p) {
    const tt = TT_BY_TYPE[p.targetType] || { icon: '•', label: '' };
    const card = el('div', 'post-card');
    let html = '<span class="post-target">' + tt.icon +
      '<span class="pt-name">' + esc(p.targetName || tt.label) + '</span></span>';
    html += '<div class="post-body">' + esc(p.body) + '</div>';
    if (p.photoPath) {
      html += '<div class="post-photo" data-photo="' + esc(p.photoPath) + '"></div>';
    }
    html += '<div class="post-meta">' +
      '<span class="post-name">' + esc(p.name) + '</span>' +
      '<span class="post-day">' + esc(dayLabel(p.day)) + '</span>';
    if (p.instagram) {
      const h = String(p.instagram).replace(/^@/, '');
      html += '<a class="post-ig" href="https://instagram.com/' + encodeURIComponent(h) +
        '" target="_blank" rel="noopener">' + esc(p.instagram) + '</a>';
    }
    html += '<span class="post-time">' + esc(timeAgo(p.createdAt)) + '</span>';
    html += '</div>';
    card.innerHTML = html;
    const rep = el('button', 'post-report', '⚐ 通報');
    rep.style.marginTop = '8px';
    rep.onclick = () => openReport(p.id);
    card.appendChild(rep);
    return card;
  }

  /* 写真プレースホルダを順次URL解決して埋める */
  function hydratePhotos(root) {
    $$('.post-photo[data-photo]', root || document).forEach(box => {
      const path = box.getAttribute('data-photo');
      box.removeAttribute('data-photo');
      getPhotoURL(path).then(url => {
        if (!url) return;
        const img = new Image();
        img.loading = 'lazy';
        img.alt = '投稿写真';
        img.src = url;
        box.appendChild(img);
      }).catch(() => {});
    });
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

    /* Instagram */
    form.appendChild(fieldWrap('Instagram', false,
      '<input class="input" id="fIg" placeholder="@account または URL（任意）" value="' +
      esc(fm.instagram) + '">',
      '入力するとフィードに表示され、リンクされます。不要なら空欄のままで。'));

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

    /* 写真 */
    const photoField = fieldWrap('写真', false, '', '');
    const pbody = photoField.querySelector('.field__body');
    if (fm.photo) {
      const pv = el('div', 'photo-preview');
      const img = new Image();
      img.src = fm.photo.url;
      img.alt = '添付写真プレビュー';
      pv.appendChild(img);
      const rm = el('button', 'photo-remove', '✕');
      rm.onclick = () => {
        if (fm.photo && fm.photo.url) { try { URL.revokeObjectURL(fm.photo.url); } catch (e) {} }
        fm.photo = null; renderPost();
      };
      pv.appendChild(rm);
      pbody.appendChild(pv);
      pbody.appendChild(el('div', 'photo-note',
        '位置情報などの撮影データは自動で削除され、リサイズして投稿されます。'));
    } else {
      const drop = el('label', 'photo-drop',
        '📷 タップして写真を選ぶ（任意）<br>' +
        '<span style="font-size:11px">位置情報は自動で除去されます</span>' +
        '<input type="file" accept="image/*" id="fPhoto" style="display:none">');
      pbody.appendChild(drop);
    }
    form.appendChild(photoField);

    /* 送信 */
    const submit = el('button', 'btn btn--primary btn--block btn--lg',
      fm.submitting ? '投稿中…' : '感想を投稿する');
    submit.disabled = fm.submitting;
    submit.onclick = submitPost;
    form.appendChild(submit);

    root.appendChild(form);

    /* --- 入力イベントの結線 --- */
    const nameI = $('#fName'), igI = $('#fIg'), bodyI = $('#fBody'), photoI = $('#fPhoto');
    if (nameI) nameI.oninput = () => { fm.name = nameI.value; };
    if (igI) igI.oninput = () => { fm.instagram = igI.value; };
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
    if (photoI) photoI.onchange = () => onPhotoPick(photoI);
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

  async function onPhotoPick(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    toast('写真を処理しています…');
    try {
      const res = await stripExifAndResize(file);
      const url = URL.createObjectURL(res.blob);
      if (state.form.photo && state.form.photo.url) {
        try { URL.revokeObjectURL(state.form.photo.url); } catch (e) {}
      }
      state.form.photo = { blob: res.blob, width: res.width, height: res.height, url: url };
      renderPost();
    } catch (e) {
      toast('この写真は使えませんでした。別の写真を選んでください。');
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

    fm.submitting = true;
    renderPost();
    try {
      const tt = TT_BY_TYPE[fm.targetType];
      await createPost({
        name: name,
        day: fm.day,
        instagram: normInstagram(fm.instagram),
        body: body,
        targetType: fm.targetType,
        targetId: tt.pick ? fm.targetId : null,
        targetName: fm.targetName || tt.label,
        clientFlags: ng.soft ? ['ng_soft'] : []
      }, fm.photo);

      save('mma_lastpost', Date.now());
      /* フォームをリセット */
      if (fm.photo && fm.photo.url) { try { URL.revokeObjectURL(fm.photo.url); } catch (e) {} }
      state.form = {
        name: name, day: '', instagram: '', body: '',
        targetType: '', targetId: null, targetName: '',
        photo: null, errors: [], submitting: false, piiOk: false
      };
      toast('感想を投稿しました。ありがとうございます');
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
    const wrap = el('div', '');
    wrap.innerHTML = '<div class="modal__handle"></div>' +
      '<div class="modal__title">' + esc(targetName) + ' への感想</div>' +
      '<div id="tpList"><div class="loading">読み込んでいます…</div></div>';
    openModal(wrap);
    if (!FIREBASE_READY) {
      $('#tpList').innerHTML =
        '<div class="empty">接続設定が未完了のため表示できません。</div>';
      return;
    }
    try {
      const res = await fetchByTarget(targetType, targetId, null);
      const box = $('#tpList');
      if (!box) return;
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
      hydratePhotos(box);
    } catch (e) {
      const box = $('#tpList');
      if (box) box.innerHTML =
        '<div class="errbox">読み込みに失敗しました。索引（複合インデックス）が' +
        '未作成の可能性があります。READMEを確認してください。</div>';
    }
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
      '・投稿に含まれるのは、あなたが自分で入力した情報（名前・曜日・Instagram・' +
      '感想・写真）だけです。<br>' +
      '・写真は投稿前に、位置情報などの撮影データ（Exif）を自動で削除します。<br>' +
      '・名前はニックネームで構いません。個人が特定できる情報は書かないでください。' +
      '</p>'));

    root.appendChild(secTitle('投稿のルール', 'RULES'));
    root.appendChild(el('div', 'card',
      '<p class="field__hint">' +
      '・誹謗中傷にあたる表現が含まれる投稿はできません。<br>' +
      '・投稿の編集・削除はできません。書く前に内容を確認してください。<br>' +
      '・不適切な投稿を見つけたら、各投稿の「⚐ 通報」から知らせてください。' +
      '運営が確認し、必要に応じて非表示にします。' +
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
