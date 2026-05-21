/* ===================================================================
   森道 After party — 誹謗中傷フィルタ（NGワード辞書）

   方針：
   ・hard … 明白な攻撃語・差別語。検出したら投稿をブロックする。
   ・soft … 文脈次第でグレーな語。投稿は通すが clientFlags に記録し、
            運営があとで確認できるようにする。
   ・このファイルはクライアントに配信される＝辞書は閲覧可能。
     ローマ字化・同音異字・画像内テキスト・文脈依存の中傷は
     原理的に防げない。最終的な担保は「通報」＋「運営による非表示」。
   ・運用しながら hard / soft に語を追記して育てる前提。
=================================================================== */

const NG_WORDS = {
  /* 明白な攻撃・脅迫・侮蔑・差別語（検出＝ブロック）。
     感想（店・人・イベントへの賞賛/批評）で正当に使われることが
     ほぼ無い語に限定し、過剰ブロックを避ける。 */
  hard: [
    'しね', 'ころす', 'ころすぞ', 'きえろ', 'しねよ',
    'くたばれ', 'ぶっころす', 'ぶっ殺',
    'きちがい', 'きょうじん', 'めくら', 'つんぼ', 'おし', 'いざり',
    'かたわ', 'びっこ', 'ちょん', 'こじき',
    'ぶさいく', 'ブサイク', 'きもちわるい',
    'のうなし', '役立たず', 'やくたたず',
    '死ね', '殺す', '消えろ'
  ],
  /* 文脈次第でグレー（投稿は通す・フラグのみ）。
     「ばか旨い」「あほみたいに並んだ」など肯定的用法もあるため。 */
  soft: [
    'ばか', 'あほ', 'ぼけ', 'くず', 'ごみ', 'まぬけ',
    'うざい', 'うざ', 'きもい', 'きしょい', 'きしょ',
    'ぶす', 'でぶ', 'はげ', 'ちび',
    'さいてい', 'さいあく', '最低', '最悪',
    'むのう', 'むかつく', 'うんこ', 'くそ', 'クソ'
  ]
};

/* 判定用の正規化：
   ・NFKC（全角英数→半角、半角カナ→全角カナ 等）
   ・カタカナ→ひらがな（辞書はひらがな基準）
   ・空白・区切り記号・伏字記号を除去（「し ね」「し.ね」「し○ね」対策）
   ・英字は小文字化 */
function ngNormalize(text) {
  let t;
  try { t = String(text).normalize('NFKC'); }
  catch (e) { t = String(text); }
  return t.toLowerCase()
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　・･.,，、。\-‐-―ー~〜＆*＊#＃○●◯◎□■△▲×✕…_＿\/／|｜]/g, '');
}

/* text を検査して { blocked, soft, hardHits, softHits } を返す。 */
function ngCheck(text) {
  const norm = ngNormalize(text);
  const hardHits = [];
  for (const w of NG_WORDS.hard) {
    const nw = ngNormalize(w);
    if (nw && norm.indexOf(nw) !== -1) hardHits.push(w);
  }
  const softHits = [];
  for (const w of NG_WORDS.soft) {
    const nw = ngNormalize(w);
    if (nw && norm.indexOf(nw) !== -1) softHits.push(w);
  }
  return {
    blocked: hardHits.length > 0,
    soft: softHits.length > 0,
    hardHits: hardHits,
    softHits: softHits
  };
}

/* 本文中の個人情報らしき文字列（電話番号・メールアドレス）を検出。
   投稿はブロックしないが、投稿者に警告を出すために使う。 */
function piiCheck(text) {
  const s = String(text);
  const phone = /0\d{1,4}[-(\s]?\d{1,4}[-)\s]?\d{3,4}/.test(s);
  const email = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/.test(s);
  return { phone: phone, email: email, hit: phone || email };
}
