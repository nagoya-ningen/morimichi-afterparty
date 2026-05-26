/* ===================================================================
   森道 After party — 画像アップロード（Cloudinary unsigned upload）

   ・GitHub Pages の静的サイトから、サーバーを介さず Cloudinary へ
     画像を直接アップロードする（unsigned upload preset を使用）。
   ・アップロード前にブラウザ側で圧縮し、EXIF（GPS位置情報を含む）を
     除去する。これはプライバシー対策として必須。
   ・画像つき投稿も事後モデレーション制。即時公開され、不適切なものは
     通報経由で運営が hidden=true に切り替えて非表示にする。

   ▼ セットアップ：下の2つを自分の Cloudinary の値に置き換える（手順は README）。
=================================================================== */

/* ===== セットアップ：ここを自分の Cloudinary の値に置き換える ===== */
const CLOUDINARY_CLOUD_NAME    = 'dsmrdy4kl';
const CLOUDINARY_UPLOAD_PRESET = 'morimichi_afterparty';
/* ================================================================ */

/* 画像機能が設定済みかどうか。未設定なら投稿フォームで画像欄を出さない。 */
export const IMAGE_READY =
  CLOUDINARY_CLOUD_NAME.indexOf('REPLACE') === -1 &&
  CLOUDINARY_UPLOAD_PRESET.indexOf('REPLACE') === -1;

/* 受け付ける画像形式・元ファイルの上限（圧縮前の安全弁） */
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024; // 20MB

/* 圧縮＆EXIF除去。
   browser-image-compression（index.html でCDN読み込み）を使う。
   preserveExif は既定 false のため、再エンコードの過程で
   EXIF（GPS位置情報を含む）が除去される。 */
export async function compressImage(file) {
  if (!window.imageCompression) {
    /* ライブラリ未ロード時は、安全のためアップロードさせない */
    throw new Error('compressor-unavailable');
  }
  return window.imageCompression(file, {
    maxSizeMB: 0.8,
    maxWidthOrHeight: 1600,
    useWebWorker: true,
    preserveExif: false
  });
}

/* Cloudinary へアップロードし { url, publicId } を返す。 */
export async function uploadImage(blob) {
  if (!IMAGE_READY) throw new Error('image-not-configured');
  const form = new FormData();
  form.append('file', blob);
  form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  const res = await fetch(
    'https://api.cloudinary.com/v1_1/' +
    encodeURIComponent(CLOUDINARY_CLOUD_NAME) + '/image/upload',
    { method: 'POST', body: form }
  );
  if (!res.ok) throw new Error('upload-failed');
  const data = await res.json();
  if (!data.secure_url) throw new Error('upload-failed');
  return { url: data.secure_url, publicId: data.public_id || null };
}
