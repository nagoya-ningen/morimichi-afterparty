# 森道 After party

森、道、市場2026の感想・思い出を投稿し、SNSのように共有しあう非公式ファンアプリ（PWA）。

- 公開フィード型：投稿が新着順に並び、参加者どうしで読み合える
- 投稿項目：名前（必須・ニックネーム可）／参加した曜日／SNS URL（任意）／感想本文（30字以上）／感想の対象（アーティスト・店舗・ショップ・エリア・森道自体・運営への感謝）／写真（任意・1枚）
- 写真つき投稿は事前承認制。運営が承認するまで公開フィードに出ない
- 誹謗中傷フィルタ（NGワード辞書）＋通報＋運営による承認/非表示
- バックエンドは Firebase Firestore（無料の Spark プラン）。写真は Cloudinary（無料枠）に保存
- 公開ページ（誰でも投稿）と運営者専用の管理画面に分かれている

このアプリは非公式のファンアプリです。森、道、市場の主催・運営とは一切関係ありません。

## このアプリの構成

公開ページ（`index.html`）と運営者専用の管理ページ（`admin.html`）の2画面で動きます。

- **公開ページ** `index.html`：誰でも見られる。匿名認証で、名前を登録しなくても感想を投稿できる
- **管理ページ** `admin.html`：運営者だけが使う。メールアドレスとパスワードでログインし、写真つき投稿の承認・通報対応・非表示などのモデレーションを行う

## ファイル構成

```
morimichi-afterparty/
├── index.html            公開ページ（感想の投稿・閲覧）
├── admin.html            運営者専用の管理ページ（モデレーション）
├── manifest.json         PWA設定（ホーム画面に追加できる）
├── sw.js                 Service Worker（オフライン対応・キャッシュ）
├── css/                  スタイルシート
├── js/
│   ├── data.js           アーティスト/店舗/エリアのマスタ＋出典
│   ├── ngwords.js        NGワード辞書・誹謗中傷フィルタ
│   ├── image.js          画像の圧縮・EXIF除去・Cloudinaryアップロード（★要設定）
│   ├── firebase.js       Firebase接続（★要設定）
│   ├── app.js            公開ページの本体（★要設定：削除依頼フォームURL）
│   └── admin.js          管理ページの本体
├── firestore.rules       Firestore セキュリティルール（★要設定：管理者メール）
└── tools/
    └── takedown-form.gs  投稿削除依頼フォームを作るGoogle Apps Script
```

`★要設定` のファイルは、下のセットアップ手順で値を書き換えます。

## セットアップ手順

投稿の保存に Firebase、写真の保存に Cloudinary、削除依頼の受付に Googleフォームを使います。
**いずれも無料の範囲だけで動き、クレジットカードの登録は不要です。**
以下を1ステップずつ、順番どおりに進めてください。

### 1. Firebase プロジェクトを作成

1. <https://console.firebase.google.com/> にアクセスし、Googleアカウントでログイン
2. 「プロジェクトを作成」を選び、任意の名前（例：`morimichi-afterparty`）を入力
3. Google アナリティクスは**オフ**のままで進める（個人特定を避けるため不要）
4. 作成が終わるまで待つ。これが無料の Spark プランのプロジェクトになる

### 2. ウェブアプリを登録し firebaseConfig を置き換える

1. プロジェクト画面で「ウェブ」アイコン（`</>`）をクリック
2. アプリのニックネームを入力して登録する（「Firebase Hosting も設定」のチェックは不要）
3. 表示される `firebaseConfig`（`apiKey` など6項目）をコピーする
4. `js/firebase.js` を開き、ファイル先頭の `firebaseConfig` の `REPLACE_...` 6項目（`apiKey` / `authDomain` / `projectId` / `storageBucket` / `messagingSenderId` / `appId`）を、コピーした値に置き換える

`apiKey` は公開してかまいません。アクセス制御はセキュリティルールと App Check で行います。

### 3. Firestore Database を有効化

1. 左メニュー「構築」→「Firestore Database」→「データベースを作成」
2. **本番環境モード**で開始する
3. ロケーションは `asia-northeast1`（東京）を選ぶ

### 4. Authentication で 2 つのログイン方法を有効化

公開ページ用と管理画面用で、ログイン方法を2種類使います。

1. 左メニュー「構築」→「Authentication」→「始める」
2. 「Sign-in method」タブを開く
3. 「**匿名**」を**有効**にして保存する（公開ページで、誰でも投稿できるようにするため）
4. 続けて「**メール/パスワード**」を**有効**にして保存する（管理画面のログイン用）

### 5. 管理者アカウントを作成する

`admin.html`（管理ページ）にログインするための運営者アカウントを作ります。

1. Authentication の「**Users**」タブを開く
2. 「ユーザーを追加」を選び、運営者のメールアドレスとパスワードを入力して1件登録する
3. ここで登録したメールアドレスが、管理画面のログインに使う**管理者アカウント**になる
4. このメールアドレスは次の手順6で使うので控えておく

### 6. firestore.rules に管理者メールを設定

1. `firestore.rules` を開く
2. `adminEmail()` の中の `REPLACE_WITH_ADMIN_EMAIL` を、手順5で登録した管理者のメールアドレスに置き換える
   （例：`function adminEmail() { return 'admin@example.com'; }`）

これにより、投稿の承認・非表示・削除はそのメールでログインした運営者だけが行えるようになります。

### 7. App Check（reCAPTCHA v3）を設定

Bot による不正な書き込みを防ぐため、必ず設定してください。

1. <https://www.google.com/recaptcha/admin/create> で reCAPTCHA を新規作成する
   - 種類：**reCAPTCHA v3（スコアベース）**
   - ドメイン：GitHub Pages のドメイン（例 `nagoya-ningen.github.io`）と `localhost`
2. 発行された「**サイトキー**」を、`js/firebase.js` 先頭の `RECAPTCHA_SITE_KEY` に置き換える
3. Firebase コンソール「構築」→「App Check」を開き、ウェブアプリを登録する。プロバイダに reCAPTCHA v3 を選び、上記で発行された「**シークレットキー**」を登録する
4. App Check の「APIs」で **Firestore** を「適用（Enforce）」にする

### 8. セキュリティルールを反映

1. Firestore コンソールに戻り、「**ルール**」タブを開く
2. 手順6で書き換えた `firestore.rules` の中身をすべてコピーして貼り付ける
3. 「公開」を押す

### 9. 承認済みドメインを追加

1. Authentication →「設定」→「承認済みドメイン」を開く
2. GitHub Pages のドメイン（例 `nagoya-ningen.github.io`）と `localhost` を追加する

これがないと、デプロイ後やローカルでログイン・投稿ができません。

### 10. Cloudinary を設定（写真投稿用）

写真は Firebase ではなく Cloudinary に保存します。無料枠だけで動き、クレジットカードは不要です。

1. <https://cloudinary.com/> に無料登録する（クレジットカード不要）
2. 登録後のダッシュボードで「**Cloud name**」を確認する（控えておく）
3. 「Settings」→「Upload」を開き、「Upload presets」で「Add upload preset」を選ぶ
4. 作成するプリセットを次のように設定する
   - **Signing Mode：Unsigned**（サーバーなしでアップロードするため必須）
   - **許可フォルダ**：投稿用のフォルダを1つ指定し、そこに限定する
   - **最大ファイルサイズ**：上限を設定する（例：3MB 程度。アプリ側でも圧縮済み）
   - **許可形式**：`jpg` / `png` / `webp` のみ
5. 作成したプリセットの名前（**upload preset 名**）を控える
6. `js/image.js` を開き、先頭の `CLOUDINARY_CLOUD_NAME` に手順2の Cloud name、`CLOUDINARY_UPLOAD_PRESET` に手順5のプリセット名を置き換える

未設定のままだと、投稿フォームに写真の欄が表示されません（テキスト投稿は引き続き可能）。

### 11. 削除依頼フォームを作成し app.js に設定

出店者や写っている本人などから、投稿の削除依頼を受け付けるGoogleフォームを用意します。

1. <https://script.google.com/> で新規プロジェクトを作成する
2. `tools/takedown-form.gs` の内容をすべて貼り付ける（詳しい手順はファイル冒頭のコメント参照）
3. `createTakedownForm` 関数を1回だけ実行する（初回は権限の承認ダイアログが出る）
4. 実行ログ（表示 > ログ）に出る「**フォーム公開URL**」をコピーする
5. `js/app.js` を開き、`TAKEDOWN_FORM_URL` をそのURLに置き換える

回答は自動生成された集計スプレッドシートに溜まります。運営者は随時確認してください。

### 12. 複合インデックスを作成

対象別の感想表示や承認待ち一覧など、複数条件の検索には Firestore の複合インデックスが必要です。

- **簡単な方法**：アプリを実際に動かすと、未作成のインデックスが必要になったとき、ブラウザのコンソール（DevTools）にエラーが出ます。そのエラーメッセージ内の**インデックス作成リンク**をクリックすれば、必要なインデックスが自動で作成されます。
- 対象（コレクション `posts`）：
  - `hidden` ＋ `status` ＋ `createdAt`
  - `hidden` ＋ `status` ＋ `targetType` ＋ `targetId` ＋ `createdAt`
  - `status` ＋ `hidden` ＋ `createdAt`（管理画面の承認待ち一覧）
  - `hidden` ＋ `status` ＋ `pinned` ＋ `pinnedAt`（「今日のひとこと」セクション）
  - `pinned` ＋ `pinnedAt`（管理画面のピン留め一覧）

アプリの全機能を一通り操作し、出たリンクをすべてクリックしておくと確実です。

## ローカルでの動作確認

```bash
cd morimichi-afterparty
python3 -m http.server 8000
```

ブラウザで <http://localhost:8000/> を開きます。管理画面は <http://localhost:8000/admin.html> です。

- Firebase の承認済みドメインに `localhost` を入れておくこと（手順9）
- 開発中は Service Worker のキャッシュが残るため、DevTools の Application → Service Workers で「Update on reload」を有効にすると便利です

## デプロイ（GitHub Pages）

1. `nagoya-ningen/morimichi-afterparty` リポジトリにファイル一式を push する
2. リポジトリの Settings → Pages で、ブランチ `main` / フォルダ `(root)` を選んで公開する
3. 公開URLは `https://nagoya-ningen.github.io/morimichi-afterparty/` になる
4. 管理画面は `https://nagoya-ningen.github.io/morimichi-afterparty/admin.html`

このドメインが手順9の承認済みドメインに入っていることを確認してください。

## 運営（モデレーション）ガイド

運営は `admin.html` で行います。冒頭で運営者のメールアドレス（手順5で作成）とパスワードを入力してログインしてください。

### 写真つき投稿の承認

- 写真つきの投稿は `status='pending'`（承認待ち）で保存され、**承認するまで公開フィードに出ません**。テキストのみの投稿は即時公開されます。
- 管理画面の承認待ち一覧で写真と本文を確認し、問題なければ「承認」を押すと公開フィードに表示されます。
- 不適切な写真・本文は承認せず、「非表示」にします。

### 通報への対応

- 公開ページから投稿が通報されると、`reports` コレクションに記録され、管理画面の通報一覧に並びます。
- 通報された投稿の内容を確認し、問題があれば「非表示」にします。
- `clientFlags` に `ng_soft` が付いた投稿は、グレーな語を含むものです。優先的に確認してください。

### 投稿の非表示

- 不適切な投稿は管理画面で「非表示」にすると、公開フィードから即座に消えます（`hidden` が `true` になります）。
- 誤って非表示にした場合は「再表示」で戻せます。

### バックアップ

- 管理画面から全投稿を JSON 形式でエクスポートできます。定期的に保存しておくと、データ消失時の備えになります。

### Cloudinary 上の画像削除

- 投稿を非表示・削除しても、Cloudinary にアップロードされた**画像ファイル自体は残ります**。
- 画像を完全に消す場合は、Cloudinary の管理画面（Media Library）から該当画像を探して削除してください。
- 投稿削除依頼フォーム（手順11）への依頼に対応するときも、必要に応じて Cloudinary 側の画像削除を行います。

## プライバシー設計（このアプリが「しないこと」）

- 位置情報（Geolocation）を取得しない
- 写真は投稿前にブラウザ側で圧縮し、EXIF（GPS位置情報を含む）を除去してからアップロードする
- 端末情報・IP・アクセス解析を収集しない（Firebase Analytics は導入していない）
- 投稿に含まれるのは、投稿者が自分で入力した情報（名前・曜日・SNS URL・感想・写真）のみ
- 匿名認証の UID は内部処理（連投制限・通報）専用で、ユーザーには表示しない
- 写真つき投稿は事前承認制のため、運営の確認を経ない写真は公開されない

## 既知の制約

- 匿名認証の UID は端末ごとで使い捨て可能なため、レート制限は完全ではない。App Check の有効化が必須。
- NGワード辞書はクライアントに配信されるため、回避は原理的に可能。最終的な担保は通報＋運営の承認/非表示。
- 投稿の編集・削除は投稿者本人にはできない（改ざん・荒らし対策）。削除は運営のみ。
- フィードは1ページ20件のページネーション（Firestore 無料枠を維持するため）。
- 写真は1投稿につき1枚まで。
- Cloudinary 上の画像は、投稿を消しても自動では削除されない（運営が手動で削除する）。
- 無料枠（Firestore / Cloudinary）の上限を超えると停止する。アクセスが多い場合は利用状況を確認すること。

---

これは非公式のファンアプリです。森、道、市場の主催・運営とは一切関係ありません。
