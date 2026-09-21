import { base64Length, fitWithin, JPEG_QUALITIES, MAX_IMAGE_BASE64 } from './attachments';

export type PreparedImage = { ok: true; data: string; mimeType: string } | { ok: false; reason: 'unreadable' | 'too-large' };

async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/**
 * 长边 ≤ 2000 且 base64 后 ≤ 4.5MB：原样用（GIF 动图不被压平）。否则缩到长边 2000 重编码：
 * 先 PNG，超了改 JPEG（白底，免得透明处变黑）逐级降质量；仍超就不收（spec §3.3）。
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const fit = fitWithin(bitmap.width, bitmap.height);
    if (!fit.scaled && base64Length(file.size) <= MAX_IMAGE_BASE64) {
      return { ok: true, data: await blobToBase64(file), mimeType: file.type };
    }
    const png = new OffscreenCanvas(fit.width, fit.height);
    const pctx = png.getContext('2d');
    if (!pctx) return { ok: false, reason: 'unreadable' };
    pctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
    const pngBlob = await png.convertToBlob({ type: 'image/png' });
    if (base64Length(pngBlob.size) <= MAX_IMAGE_BASE64) return { ok: true, data: await blobToBase64(pngBlob), mimeType: 'image/png' };

    const jpg = new OffscreenCanvas(fit.width, fit.height);
    const jctx = jpg.getContext('2d');
    if (!jctx) return { ok: false, reason: 'unreadable' };
    jctx.fillStyle = '#ffffff';
    jctx.fillRect(0, 0, fit.width, fit.height);
    jctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
    for (const quality of JPEG_QUALITIES) {
      const blob = await jpg.convertToBlob({ type: 'image/jpeg', quality });
      if (base64Length(blob.size) <= MAX_IMAGE_BASE64) return { ok: true, data: await blobToBase64(blob), mimeType: 'image/jpeg' };
    }
    return { ok: false, reason: 'too-large' };
  } finally {
    bitmap.close();
  }
}
