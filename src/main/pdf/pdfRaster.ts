// src/main/pdf/pdfRaster.ts
//
// 把 PDF 的某一页渲染成 PNG。
//
// 为什么在主进程还要开一个窗口：pdf.js 要一块真 canvas 才能画，主进程里没有。
// 所以开一个不显示的 BrowserWindow 加载 pdf-raster.html —— 那里有完整的 Chromium
// canvas 和随渲染层一起打包好的 pdfjs。不引 node-canvas（多一个原生依赖，且它的
// PDF 支持和 pdf.js 不是一回事）。
//
// 用 `show: false` 而不是 `webPreferences.offscreen: true`：我们要的只是「一个有真
// canvas 的 JS 环境」，2D canvas 的绘制根本不经过窗口合成。offscreen 会切到离屏渲染
// 管线，换来一堆我们用不上的行为差异。
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { BrowserWindow } from 'electron';
import { KydogError } from '../../shared/errors';
import { logger } from '../log';

export type RenderPageArgs = { path: string; page: number; scale?: number };
export type NormalizedRenderArgs = { path: string; page: number; scale: number };

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const DEFAULT_SCALE = 2;
/** 页码上限。真实论文插图 PDF 都是个位数页，给到 5000 已经远超任何合理输入。 */
export const MAX_PAGE = 5000;
/** 源 PDF 体积上限：字节要 base64 化后经 executeJavaScript 送进窗口，太大会把内存撑爆。 */
const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** 单次渲染超时。页面若加载失败，等待就没有尽头，必须有个上限把它变成一条错误。 */
const RENDER_TIMEOUT_MS = 60_000;

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

/**
 * 校验并归一化参数。纯函数，不碰磁盘也不碰 electron —— 单测覆盖的就是它。
 *
 * 挡住的东西和理由：
 * - 非绝对路径：这个入口同时给 agent 用，agent 的 cwd 与主进程的 process.cwd() 不是
 *   一回事，相对路径会解析到别处。要就要说清楚是哪个文件。
 * - `..` 段与 NUL：文件名可能直接来自论文附件包，那是外部输入。注意不能先 normalize
 *   再查 —— `/a/../../etc/x.pdf` 归一化后是 `/etc/x.pdf`，`..` 已经被吃掉了。
 * - 非 .pdf 后缀：这个工具只做 PDF，别的格式进来只会在 pdf.js 里炸得莫名其妙。
 * - 页码非正整数 / 超上限。
 * - scale 超出 1–4：一张 A0 海报按 8 倍渲染就是几百 MB 的 PNG。
 *   （scale 封顶还不够 —— 4 倍的 A0 仍有一亿多像素，像素总数的兜底在渲染页里。）
 */
export function validateRenderArgs(args: RenderPageArgs): NormalizedRenderArgs {
  if (typeof args !== 'object' || args === null) {
    throw new KydogError('fs.read_failed', 'pdf.renderPage 参数必须是对象');
  }
  const raw = args.path;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new KydogError('fs.read_failed', 'pdf.renderPage 需要一个文件路径');
  }
  if (raw.includes('\0')) {
    throw new KydogError('fs.read_failed', '路径里不能含 NUL 字符');
  }
  if (!path.isAbsolute(raw)) {
    throw new KydogError('fs.read_failed', `路径必须是绝对路径：${raw}`);
  }
  if (raw.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new KydogError('fs.read_failed', `路径里不能含 .. 段：${raw}`);
  }
  const filePath = path.normalize(raw);
  if (path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new KydogError('fs.read_failed', `只能渲染 .pdf 文件：${raw}`);
  }

  const page = args.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    throw new KydogError('fs.read_failed', `页码必须是 1–${MAX_PAGE} 之间的整数，收到 ${String(page)}`);
  }

  const scale = args.scale === undefined ? DEFAULT_SCALE : args.scale;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) {
    throw new KydogError(
      'fs.read_failed',
      `scale 必须在 ${MIN_SCALE}–${MAX_SCALE} 之间，收到 ${String(args.scale)}`,
    );
  }

  return { path: filePath, page, scale };
}

/** 产物落在 PDF 同目录，文件名 `<原名>-p<页码>.png`。 */
export function pngOutputPath(pdfPath: string, page: number): string {
  const dir = path.dirname(pdfPath);
  const stem = path.basename(pdfPath, path.extname(pdfPath));
  return path.join(dir, `${stem}-p${page}.png`);
}

// ── 渲染窗口的生命周期 ────────────────────────────────────────────────
//
// 每次渲染新建一个窗口，画完在 finally 里销毁 —— 不留常驻窗口，也就没有闲置定时器
// 这类「等多久算闲」的拍脑袋阈值。三条理由：
//   1. 常驻窗口会堵住退出：主窗口关掉后只剩这个不显示的窗口，Electron 的
//      window-all-closed 不触发，app 就不退。用完即毁把这个窗口期压到一次渲染之内。
//   2. 每次都是干净进程：上一张大图在 pdfjs 里留下的缓存与内存随进程一起还给系统。
//   3. 代价小：实测建窗 + 加载 pdfjs + 画一页，整轮不到一秒。
// 并发调用由 queue 串起来，所以任一时刻最多只有一个这样的窗口。
let activeWindow: BrowserWindow | null = null;
let queue: Promise<unknown> = Promise.resolve();

/**
 * 销毁当前这个渲染窗口（如果有）。正常路径由 doRender 的 finally 调用；
 * main.ts 的 before-quit 也会调一次，收拾掉退出时还在飞的那一个。
 */
export function destroyRasterWindow(): void {
  const win = activeWindow;
  activeWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

/** 渲染页面的地址：dev 走 vite dev server，打包后走 loadFile 的磁盘路径。 */
function rasterPageLocation(): { url?: string; file?: string } {
  const devServer = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string'
    ? MAIN_WINDOW_VITE_DEV_SERVER_URL
    : undefined;
  if (devServer) return { url: `${devServer}/src/renderer/assets/pdf-raster.html` };
  // vite 按 root 的相对路径输出多页面入口，所以产物路径保留了 src/renderer/assets/ 这一层。
  return {
    file: path.join(
      __dirname,
      `../renderer/${MAIN_WINDOW_VITE_NAME}/src/renderer/assets/pdf-raster.html`,
    ),
  };
}

async function createRasterWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口不显示 ⇒ 一直是 background，默认的节流会拖慢页面里的定时器。
      backgroundThrottling: false,
    },
  });
  // 这个窗口只加载我们自己那一页，任何导航都是异常，一律拦掉。
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  activeWindow = win;

  const loc = rasterPageLocation();
  try {
    if (loc.url) await win.loadURL(loc.url);
    else await win.loadFile(loc.file!);
  } catch (err) {
    destroyRasterWindow();
    throw new KydogError('fs.read_failed', `PDF 渲染页加载失败：${String(err)}`);
  }
  return win;
}

type RasterResult = { pngBase64: string; width: number; height: number; appliedScale: number };

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new KydogError('fs.read_failed', `${what} 超时（${ms}ms）`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function doRender(args: NormalizedRenderArgs): Promise<{ pngPath: string }> {
  let stat;
  try {
    stat = await fsp.stat(args.path);
  } catch (err) {
    throw new KydogError('fs.read_failed', `无法读取 ${args.path}`, err);
  }
  if (!stat.isFile()) throw new KydogError('fs.read_failed', `${args.path} 不是文件`);
  if (stat.size > MAX_PDF_BYTES) {
    throw new KydogError('fs.too_large', `${args.path} 超过 ${MAX_PDF_BYTES / 1024 / 1024}MB 上限`);
  }

  const base64 = (await fsp.readFile(args.path)).toString('base64');

  // 字节走 base64 从这里进（executeJavaScript 只能送可序列化的东西），PNG 走 base64
  // 从那边回。__pdfRasterReady 是页面里同步建好的 promise，模块跑完才 resolve ——
  // 不用轮询探 window.__renderPdfPage 在不在，等一个真信号。
  const code = `window.__pdfRasterReady.then(() => window.__renderPdfPage(`
    + `${JSON.stringify(base64)}, ${args.page}, ${args.scale}))`;
  let result: RasterResult;
  try {
    const win = await createRasterWindow();
    result = await withTimeout(
      win.webContents.executeJavaScript(code) as Promise<RasterResult>,
      RENDER_TIMEOUT_MS,
      `渲染 ${path.basename(args.path)} 第 ${args.page} 页`,
    );
  } catch (err) {
    if (err instanceof KydogError) throw err;
    throw new KydogError('fs.read_failed', `渲染失败：${String(err)}`, err);
  } finally {
    destroyRasterWindow();
  }

  const pngPath = pngOutputPath(args.path, args.page);
  try {
    await fsp.writeFile(pngPath, Buffer.from(result.pngBase64, 'base64'));
  } catch (err) {
    throw new KydogError('fs.write_failed', `无法写入 ${pngPath}`, err);
  }
  logger.info('pdf-raster', 'rendered page to png', {
    pdf: args.path, page: args.page,
    requestedScale: args.scale, appliedScale: result.appliedScale,
    width: result.width, height: result.height, pngPath,
  });
  return { pngPath };
}

/**
 * 渲染一页并落成 PNG，返回产物路径。并发调用会排队 —— 一个窗口一次只画一页。
 */
export async function renderPageToPng(rawArgs: RenderPageArgs): Promise<{ pngPath: string }> {
  const args = validateRenderArgs(rawArgs);
  const run = queue.then(() => doRender(args), () => doRender(args));
  queue = run.then(() => undefined, () => undefined);
  return run;
}
