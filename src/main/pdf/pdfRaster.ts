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
import { atomicWriteBytes } from '../persist/atomicWrite';
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
 * 「这一轮渲染还算数吗」的代号。每次 destroyRasterWindow 都 +1。
 *
 * 为什么需要它：超时（withTimeout）可能发生在**建窗之前** —— 60 秒完全可能耗在
 * 一个 50MB PDF 的 fsp.readFile 上。那一刻 activeWindow 还是 null，外层 finally 的
 * destroyRasterWindow 什么也没销毁；而被放弃的那次 doRender 并不会因为 race 输了就
 * 停下，它继续往下跑、建出一个 show:false 的窗口，从此没有任何人持有它——
 * 而 show:false 的窗口照样压住 window-all-closed，app 再也退不出去。
 * 所以 doRender 在开头取一次代号，建窗前后各复查一次：对不上就说明自己已经被放弃，
 * 立刻把（可能已经建出来的）窗口销毁掉再退出。
 */
let windowGeneration = 0;

/**
 * 销毁当前这个渲染窗口（如果有）。正常路径由 doRender 的 finally 调用；
 * main.ts 的 before-quit 也会调一次，收拾掉退出时还在飞的那一个。
 *
 * 同时把代号 +1：即使此刻没有窗口可销毁（超时发生在建窗之前），也要让还在飞的那次
 * doRender 知道自己已经作废，见 windowGeneration 的注释。
 */
export function destroyRasterWindow(): void {
  windowGeneration += 1;
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

/**
 * `onGone` 是这个窗口的「坏消息通道」。渲染进程中途消失时（OOM、GPU 进程崩），
 * loadFile / executeJavaScript 的 promise 可能永不 settle —— 只靠 await 它们等不到
 * 任何结果。把 render-process-gone 变成一条 reject，调用方 race 一下就能脱身。
 */
async function createRasterWindow(
  onGone: (err: Error) => void,
  generation: number,
): Promise<BrowserWindow> {
  // 建窗之前先复查一次：超时可能发生在 doRender 读 PDF 的那一段，这时候连窗口都还
  // 不该建（见 windowGeneration 的注释）。
  if (windowGeneration !== generation) {
    throw new KydogError('fs.read_failed', 'PDF 渲染已被放弃（超时或中止）');
  }
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
  win.webContents.on('render-process-gone', (_e, details) => {
    onGone(new KydogError('fs.read_failed', `PDF 渲染进程退出：${details.reason}`));
  });
  // 这页没人看得见，它的 console 就是唯一能说话的地方 —— pdf.js 的字体回退告警之类
  // 全落在这里。
  //
  // 不能只按 level 过滤，这一点反直觉：pdf.js 的 warn() 实现就是
  // `console.log(\`Warning: ${msg}\`)`（见 pdfjs-dist/build/pdf.mjs），它从不调
  // console.warn；而 Electron 的 level 取自 Chromium 实际调用的 console 方法名，
  // console.log 映射成 'info'。所以只放行 warning/error 会把字体回退告警整批漏掉 ——
  // 而那正是这条转发唯一要抓的东西。下面这个前缀判据是 pdf.js 自己加的，
  // 既捕得到，又不会把正常日志刷进来。**别把它当冗余删掉。**
  const PDFJS_ALERT = /^(Warning|Error):/;
  win.webContents.on('console-message', (details) => {
    const loud = details.level === 'warning' || details.level === 'error';
    if (!loud && !PDFJS_ALERT.test(details.message)) return;
    logger.warn('pdf-raster', `渲染页 console.${details.level}`, {
      message: details.message, source: details.sourceId, line: details.lineNumber,
    });
  });
  activeWindow = win;

  const loc = rasterPageLocation();
  try {
    if (loc.url) await win.loadURL(loc.url);
    else await win.loadFile(loc.file!);
  } catch (err) {
    throw new KydogError('fs.read_failed', `PDF 渲染页加载失败：${String(err)}`);
  }
  // 加载途中同样可能超时（destroyRasterWindow 那一下把 activeWindow 置空、销毁了这个
  // 窗口，或者压根还没轮到 activeWindow 赋值）。复查代号，对不上就自己收拾干净——
  // 不能把一个没人持有的窗口 return 出去。
  if (windowGeneration !== generation) {
    if (!win.isDestroyed()) win.destroy();
    if (activeWindow === win) activeWindow = null;
    throw new KydogError('fs.read_failed', 'PDF 渲染已被放弃（超时或中止）');
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

/** signal 一 abort 就 reject 的通道；没有 signal 时是一条永不 settle 的路，race 里等于不存在。 */
function abortChannel(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return new Promise<never>(() => {});
  if (signal.aborted) return Promise.reject(new KydogError('agent.aborted', 'PDF 渲染已中止'));
  return new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new KydogError('agent.aborted', 'PDF 渲染已中止')),
      { once: true },
    );
  });
}

async function doRender(
  args: NormalizedRenderArgs,
  signal: AbortSignal | undefined,
  generation: number,
): Promise<{ pngPath: string }> {
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
  let onGone!: (err: Error) => void;
  const gone = new Promise<never>((_, reject) => { onGone = reject; });
  // 没被 race 到时它仍是一条 rejected promise，先挂个消费者，别变成 unhandled rejection。
  gone.catch(() => {});
  const aborted = abortChannel(signal);
  aborted.catch(() => {});

  let result: RasterResult;
  try {
    const win = await Promise.race([createRasterWindow(onGone, generation), gone, aborted]);
    result = await Promise.race([
      win.webContents.executeJavaScript(code) as Promise<RasterResult>,
      gone,
      aborted,
    ]);
  } catch (err) {
    if (err instanceof KydogError) throw err;
    throw new KydogError('fs.read_failed', `渲染失败：${String(err)}`, err);
  }

  const pngPath = pngOutputPath(args.path, args.page);
  // 覆盖是幂等重转时的期望行为，但附件包里本来就有同名文件时这一下不可逆，留个痕。
  const overwriting = await fsp.stat(pngPath).then(() => true, () => false);
  if (overwriting) logger.warn('pdf-raster', '覆盖已存在的 PNG', { pngPath });
  try {
    // 走 atomicWrite 那套 tmp + rename：写一半崩掉不会留下截断的 PNG（agent 可能转手
    // 就把它嵌进报告），rename 也不跟随符号链接 —— 目标若是个 symlink，换掉的是链接本身。
    await atomicWriteBytes(pngPath, Buffer.from(result.pngBase64, 'base64'));
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
 *
 * 超时必须罩住**整个** doRender，不能只罩 executeJavaScript：建窗与 loadFile 那段同样
 * 可能永不 settle（渲染进程在加载途中消失时 loadFile 的 promise 就不会 settle）。
 * 而 queue 是模块级、进程内唯一的一条链 —— 只要有一次不 settle，后面所有渲染都排在它
 * 后面，既不返回也不报错，且没有恢复路径。外面那层 finally 也是为此：doRender 卡住时
 * 它自己的清理跑不到，窗口得由这里销毁。
 */
export async function renderPageToPng(
  rawArgs: RenderPageArgs,
  signal?: AbortSignal,
): Promise<{ pngPath: string }> {
  const args = validateRenderArgs(rawArgs);
  const what = `渲染 ${path.basename(args.path)} 第 ${args.page} 页`;
  const runOnce = async () => {
    // 代号在这里取，不在 doRender 里取：超时可能在 doRender 走到建窗那步之前就发生，
    // 而下面 finally 的 destroyRasterWindow 会把代号 +1 —— doRender 拿着这个更早的
    // 代号才能发现「我已经被放弃了」。见 windowGeneration 的注释。
    const generation = windowGeneration;
    try {
      return await withTimeout(doRender(args, signal, generation), RENDER_TIMEOUT_MS, what);
    } finally {
      // 清理的次生错误不该顶掉 try 里那条真正的错误（超时 / 渲染失败），
      // 否则调用方看到的是一条误导性的信息。
      try {
        destroyRasterWindow();
      } catch (err) {
        logger.warn('pdf-raster', '销毁渲染窗口失败', { err: String(err) });
      }
    }
  };
  const run = queue.then(runOnce, runOnce);
  queue = run.then(() => undefined, () => undefined);
  return run;
}
