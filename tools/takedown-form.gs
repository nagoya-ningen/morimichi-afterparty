/**
 * 森道 After party 投稿削除依頼フォーム生成スクリプト（Google Apps Script）
 * ------------------------------------------------------------------
 * 森道 After party（森道市場2026の感想投稿アプリ）の公開フィードに対し、
 * 投稿の削除依頼・お問い合わせを受け付けるGoogleフォームを生成し、
 * 回答が自動で集計スプレッドシートに溜まるよう連携設定する。
 *
 * 【できること】
 *   - 投稿削除依頼フォームの自動生成（質問6問・必須/任意）
 *   - 回答集計用スプレッドシートの自動作成とフォームへの連携
 *   - 送信後の確認メッセージ（受付の案内）の設定
 *
 * 【使い方】
 *   1. このファイルの内容を <https://script.google.com/> の新規プロジェクトに貼り付ける
 *   2. createTakedownForm を1回だけ実行する（初回は権限の承認ダイアログが出る）
 *   3. 実行ログ（表示 > ログ）に出る「フォーム公開URL」をコピーする
 *   4. そのURLを js/app.js の TAKEDOWN_FORM_URL に貼り付ける
 *   5. 回答は集計スプレッドシートに自動で溜まる。運営者は随時確認すること
 *
 * ※ 一回限りの生成ツール。日次トリガーなどは不要。
 * ※ セットアップ手順全体は README.md を参照。
 */

// ===== 設定 =====
var FORM_TITLE  = '森道 After party 投稿削除のご依頼・お問い合わせ';  // フォームのタイトル
var SHEET_TITLE = '森道 After party 投稿削除依頼 回答';               // 回答集計スプレッドシートの名前

/**
 * メイン関数。これを1回だけ実行するとフォームと集計シートが生成される。
 */
function createTakedownForm() {
  // --- フォーム本体を生成 ---
  var form = FormApp.create(FORM_TITLE);
  form.setTitle(FORM_TITLE);
  form.setDescription(
    '「森道 After party」は、森道市場2026の感想を参加者どうしで共有する\n' +
    '非公式のファンアプリです（主催・運営とは関係ありません）。\n\n' +
    '公開フィードに掲載された投稿について、削除のご依頼やお問い合わせを\n' +
    'このフォームで受け付けます。いただいた内容を確認し、対応します。'
  );
  form.setProgressBar(true);     // 回答進捗バーを表示
  form.setCollectEmail(false);   // メールはQ3で別途取得するため自動収集はしない

  // --- Q1: 申立者の種別 必須・ラジオ ---
  form.addMultipleChoiceItem()
    .setTitle('あなたはどのお立場ですか')
    .setHelpText('もっとも近いものを1つ選んでください。')
    .setChoiceValues([
      '出店者・店舗',
      '出演アーティスト・関係者',
      'その他の権利者',
      '投稿に写っている本人',
      'その他'
    ])
    .setRequired(true);

  // --- Q2: お名前・団体名 必須・短文 ---
  form.addTextItem()
    .setTitle('お名前・団体名')
    .setHelpText('ご依頼者のお名前、または団体・店舗の名称をご記入ください。')
    .setRequired(true);

  // --- Q3: ご連絡先メールアドレス 必須・短文 ---
  form.addTextItem()
    .setTitle('ご連絡先メールアドレス')
    .setHelpText('対応の連絡をお送りするために使用します。')
    .setRequired(true);

  // --- Q4: 対象の投稿 必須・段落 ---
  form.addParagraphTextItem()
    .setTitle('対象の投稿')
    .setHelpText(
      '削除・対応をご希望の投稿を特定できる情報をご記入ください。\n' +
      '（投稿のURL、投稿内容の引用、投稿者名、写真の内容など）'
    )
    .setRequired(true);

  // --- Q5: ご依頼の理由 必須・チェックボックス（複数選択可）---
  form.addCheckboxItem()
    .setTitle('ご依頼の理由（複数選択可）')
    .setChoiceValues([
      '著作権の侵害',
      '名誉毀損・信用毀損',
      'プライバシーの侵害',
      'なりすまし',
      'その他'
    ])
    .setRequired(true);

  // --- Q6: 詳しい状況 任意・段落 ---
  form.addParagraphTextItem()
    .setTitle('詳しい状況')
    .setHelpText('補足したいことがあればご記入ください。任意です。')
    .setRequired(false);

  // --- 送信後の確認メッセージ ---
  form.setConfirmationMessage(
    'ご連絡ありがとうございます。内容を確認し、対応します。\n' +
    '森道 After party 運営'
  );

  // --- 回答集計スプレッドシートを作成し、フォームに連携 ---
  var ss = SpreadsheetApp.create(SHEET_TITLE);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // --- 生成結果のURLをログ出力 ---
  Logger.log('=== 森道 After party 投稿削除依頼フォーム 生成完了 ===');
  Logger.log('■ フォーム公開URL（app.js に設定）: ' + publishedUrl_(form));
  Logger.log('■ フォーム編集URL                : ' + form.getEditUrl());
  Logger.log('■ 回答スプレッドシートURL        : ' + ss.getUrl());
}

/**
 * フォームの公開URLを返すヘルパ。
 * @param {GoogleAppsScript.Forms.Form} form 対象のフォーム
 * @return {string} 回答者に配布・参照させる公開URL
 */
function publishedUrl_(form) {
  return form.getPublishedUrl();
}
