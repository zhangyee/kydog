// src/renderer/assets/pdfRasterPage.ts
//
// pdf-raster.html 的全部逻辑。它跑在一个不显示的 BrowserWindow 里，由主进程的
// pdfRaster.ts 通过 executeJavaScript 驱动，不属于 KyDog 的 UI。
import * as pdfjsLib from 'pdfjs-dist';

// worker 用 Vite 的 new URL 资产模式引，dev(http) 与 packaged(file://) 下都能解析 ——
// 与 PdfFileTab.tsx 里已有的那份写法保持一致。
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// 像素总数兜底。scale 已经封在 4 以内，但 4 倍的 A0 海报仍有一亿多像素 ——
// 那是几百 MB 的位图。超了就等比降 scale，宁可画小一点也别把进程撑爆。
const MAX_PIXELS = 24_000_000;

export type RasterResult = {
  pngBase64: string;
  width: number;
  height: number;
  /** 实际用上的倍率：撞到像素上限时会小于请求值。 */
  appliedScale: number;
  numPages: number;
};

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function renderPage(base64: string, page: number, scale: number): Promise<RasterResult> {
  const doc = await pdfjsLib.getDocument({ data: base64ToBytes(base64) }).promise;
  const numPages = doc.numPages;
  try {
    if (page > numPages) throw new Error(`第 ${page} 页不存在，这份 PDF 只有 ${numPages} 页`);
    const pdfPage = await doc.getPage(page);

    const unit = pdfPage.getViewport({ scale: 1 });
    const wanted = unit.width * unit.height * scale * scale;
    const appliedScale = wanted > MAX_PIXELS ? scale * Math.sqrt(MAX_PIXELS / wanted) : scale;
    const viewport = pdfPage.getViewport({ scale: appliedScale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('拿不到 2d canvas context');
    // PDF 页面本身是白纸，canvas 默认透明。不铺白底，内嵌进 HTML 报告后会透出背景色。
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/png');
    return {
      pngBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      width: canvas.width,
      height: canvas.height,
      appliedScale,
      numPages,
    };
  } finally {
    await doc.destroy();
  }
}

declare global {
  interface Window {
    __renderPdfPage: typeof renderPage;
    __pdfRasterReady: Promise<void>;
    __pdfRasterResolve: () => void;
    __pdfRasterReject: (err: unknown) => void;
  }
}

window.__renderPdfPage = renderPage;
window.__pdfRasterResolve();
