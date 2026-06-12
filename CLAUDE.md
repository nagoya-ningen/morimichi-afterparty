# morimichi-afterparty（森道 After party）

## プロジェクト概要
森、道、市場2026の感想・思い出を投稿し共有しあう非公式ファンアプリ（PWA）。
公開フィード型・事後モデレーション制（即時公開＋通報経由で運営が非表示）。
主催・運営とは無関係。詳細なセットアップ手順は `README.md` を参照。

## 技術スタック
- フロント：静的HTML / CSS / Vanilla JS（ビルドツール・package.json なし）
- バックエンド：Firebase Firestore（Sparkプラン）＋匿名認証／管理者はメール+パスワード認証
- 写真：Cloudinary（無料枠）に保存。アップロード前に圧縮・EXIF除去
- PWA：manifest.json + sw.js

## ファイル構成
- `index.html` — 公開ページ（感想の投稿・閲覧、匿名で投稿可）
- `admin.html` — 運営者専用の管理ページ（通報対応・非表示）
- `js/app.js` / `js/admin.js` — 各ページの本体
- `js/data.js` — アーティスト/店舗/エリアのマスタ＋出典
- `js/ngwords.js` — NGワード辞書・誹謗中傷フィルタ
- `js/firebase.js` / `js/image.js` — Firebase接続・画像処理（要設定）
- `firestore.rules` — Firestoreセキュリティルール（要設定：管理者メール）
- `tools/takedown-form.gs` — 削除依頼フォーム作成用 Google Apps Script

## 関連プロジェクト
- `~/Projects/morimichi-app/` — 森道市場2026 非公式ファンガイド本体
- `~/Projects/watashi-no-morimichi/` — 行った店の記録・画像出力アプリ
- 森道市場の知識ベース → `~/.claude/nagoya_ningen/mag_moridoichiba.md`
