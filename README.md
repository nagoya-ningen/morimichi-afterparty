# 森道 After party

森、道、市場2026の感想・思い出を投稿し、SNSのように共有しあう非公式ファンアプリ（PWA）。

- 公開フィード型：投稿が新着順に並び、参加者どうしで読み合える
- 投稿項目：名前（必須・ニックネーム可）／行った曜日／Instagram（任意）／感想本文（30字以上）／感想の対象（アーティスト・店舗・ショップ・エリア・森道自体・運営への感謝）
- 誹謗中傷フィルタ（NGワード辞書）＋通報＋運営による非表示
- バックエンドは Firebase（Firestore + 匿名認証 + App Check）

> このバージョンは **テキスト投稿のみ**です。写真添付機能は Cloud Storage（Blazeプラン）が必要になるため未実装にしています。将来、写真を追加したくなったら Storage を有効化して `firebase.js` の `createPost` を拡張すれば対応できます。

## ファイル構成

```
morimichi-afterparty/
├── index.html
├── manifest.json
├── sw.js
├── css/style.css
├── js/
│   ├── data.js       アーティスト/店舗/エリアのマスタ＋出典
│   ├── ngwords.js    NGワード辞書・誹謗中傷フィルタ
│   ├── firebase.js   Firebase接続（★要設定）
│   └── app.js        アプリ本体
├── firestore.rules   Firestore セキュリティルール
└── img/icon-192.png, icon-512.png
```

## セットアップ（Firebase）

このアプリは投稿を保存するために Firebase を使います。以下を1ステップずつ進めてください。**無料の Spark プランだけで動きます（クレジットカード登録は不要）。**

### 1. Firebase プロジェクトを作成

1. <https://console.firebase.google.com/> にアクセス（Googleアカウントでログイン）
2. 「プロジェクトを作成」→ 任意の名前（例：`morimichi-afterparty`）
3. Google アナリティクスは **オフ** のままで可（個人特定を避けるため不要）

### 2. ウェブアプリを登録

1. プロジェクト画面で「ウェブ」アイコン（`</>`）をクリック
2. アプリのニックネームを入力して登録（「Firebase Hosting も設定」はチェック不要）
3. 表示される `firebaseConfig`（apiKey 等の6項目）をコピー
4. `js/firebase.js` の `firebaseConfig` の `REPLACE_...` を、コピーした値に置き換える

> apiKey は公開してかまいません。アクセス制御は Security Rules と App Check で行います。

### 3. Firestore を有効化

1. 左メニュー「構築」→「Firestore Database」→「データベースを作成」
2. **本番環境モード** で開始
3. ロケーションは `asia-northeast1`（東京）など近いものを選択

### 4. 匿名認証を有効化

1. 左メニュー「構築」→「Authentication」→「始める」
2. 「Sign-in method」タブ →「匿名」を**有効**にして保存

### 5. App Check（reCAPTCHA v3）を設定

Bot による不正な書き込みを防ぐため、必ず設定してください。

1. <https://www.google.com/recaptcha/admin/create> で reCAPTCHA を新規作成
   - 種類：**reCAPTCHA v3（スコアベース）**
   - ドメイン：GitHub Pages のドメイン（例 `nagoya-ningen.github.io`）と `localhost`
2. 発行された「サイトキー」を `js/firebase.js` の `RECAPTCHA_SITE_KEY` に設定
3. Firebase コンソール「構築」→「App Check」→ アプリを登録し、プロバイダに reCAPTCHA v3、上記の **シークレットキー** を登録
4. App Check の「APIs」で **Firestore** を「適用（Enforce）」にする

### 6. セキュリティルールを反映

1. Firestore コンソール →「ルール」タブ → `firestore.rules` の中身を貼り付けて「公開」

### 7. 承認済みドメインを追加

1. Authentication →「設定」→「承認済みドメイン」
2. GitHub Pages のドメインと `localhost` を追加

### 8. 複合インデックスを作成

「さがす」機能（対象別の感想表示）は複合インデックスが必要です。

- 簡単な方法：アプリを動かして「さがす」で何かを開くと、コンソールにエラーが出ます。エラーメッセージ内の **インデックス作成リンク** をクリックすれば自動で作成されます。
- 対象：コレクション `posts`／フィールド `hidden`(昇順) `targetType`(昇順) `targetId`(昇順) `createdAt`(降順)、および `hidden`(昇順) `createdAt`(降順)

## ローカルでの動作確認

```bash
cd morimichi-afterparty
python3 -m http.server 8000
```

ブラウザで <http://localhost:8000/> を開く。
Firebase の承認済みドメインに `localhost` を入れておくこと（手順7）。

開発中は Service Worker のキャッシュが残るため、DevTools の Application → Service Workers で「Update on reload」を有効にすると便利です。

## デプロイ（GitHub Pages）

`nagoya-ningen/morimichi-afterparty` リポジトリにpushし、Settings → Pages で `main` / `(root)` を公開。
URL は `https://nagoya-ningen.github.io/morimichi-afterparty/` になります。

## 運営（モデレーション）

- 不適切な投稿は、Firestore コンソールで該当 `posts` ドキュメントの `hidden` を `true` にすると、フィードから即座に消えます。
- 通報は `reports` コレクションに溜まります。`postId` から該当投稿を確認できます。
- `clientFlags` に `ng_soft` が付いた投稿は、グレーな語を含むものです。優先的に確認してください。

## プライバシー設計（このアプリが「しないこと」）

- 位置情報（Geolocation）を取得しない
- 端末情報・IP・アクセス解析を収集しない（Firebase Analytics は導入していない）
- 投稿に含まれるのは、投稿者が自分で入力した情報（名前・曜日・Instagram・感想）のみ
- 匿名認証の UID は内部処理（連投制限・通報）専用で、ユーザーには表示しない

## 既知の制約

- 匿名認証の UID は端末ごとで使い捨て可能なため、レート制限は完全ではない。App Check の有効化が必須。
- NGワード辞書はクライアントに配信されるため、回避は原理的に可能。最終的な担保は通報＋運営の非表示。
- 投稿の編集・削除はできない（改ざん・荒らし対策）。削除は運営のみ。
- フィードは1ページ20件のページネーション（Firestore 無料枠を維持するため）。
- 写真添付は未対応（Cloud Storage / Blazeプランを避けるため）。

これは非公式のファンアプリです。森、道、市場の主催・運営とは一切関係ありません。
