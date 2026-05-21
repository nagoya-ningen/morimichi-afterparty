/* ===================================================================
   森道 After party — 写真のExif除去・リサイズ

   投稿写真は Canvas に描き直して再エンコードする。これにより
   GPS位置情報・撮影日時・端末モデルなどのExif（メタデータ）が
   完全に消える。元ファイルは絶対にアップロードしない。

   stripExifAndResize(file) -> Promise<{ blob, width, height }>
   失敗時（HEIC非対応など）は reject。呼び出し側は写真なしで継続する。
=================================================================== */

async function stripExifAndResize(file, maxSide, quality) {
  maxSide = maxSide || 1280;
  quality = quality || 0.82;

  if (!file || !/^image\//.test(file.type || '')) {
    throw new Error('画像ファイルではありません');
  }

  /* createImageBitmap は多くのブラウザで使えるが、HEIC等は失敗しうる。
     imageOrientation:'from-image' でExifの回転情報を反映してから
     Canvasに描く（描いた時点で回転は焼き込まれ、Exifは不要になる）。 */
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    /* HEICなど未対応形式。フォールバックとして <img> 経由を試みる。 */
    bitmap = await loadViaImg(file);
  }

  let w = bitmap.width, h = bitmap.height;
  if (!w || !h) throw new Error('画像サイズを取得できませんでした');

  const longSide = Math.max(w, h);
  if (longSide > maxSide) {
    const r = maxSide / longSide;
    w = Math.round(w * r);
    h = Math.round(h * r);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvasを利用できません');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) { try { bitmap.close(); } catch (e) {} }

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      b => b ? resolve(b) : reject(new Error('画像の変換に失敗しました')),
      'image/jpeg',
      quality
    );
  });

  return { blob: blob, width: w, height: h };
}

/* createImageBitmap が失敗した時のフォールバック（<img>でデコード） */
function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('この画像形式は対応していません'));
    };
    img.src = url;
  });
}
