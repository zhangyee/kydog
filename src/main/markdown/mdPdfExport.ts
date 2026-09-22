// src/main/markdown/mdPdfExport.ts
//
// md 导出 PDF（spec docs/superpowers/specs/2026-09-22-md-export-pdf-design.md §3.2）。
//
// 开一个不显示的窗口加载 md-print.html：那一页用编辑器同一套 Crepe 把 md 画出来、按协议事实判定
// 排好了再兑现（renderer/assets/mdPrintPage.ts），这里 printToPDF 并原子写盘。窗口生命周期照
// pdf/pdfRaster.ts：用完即毁、串行、代号防孤儿窗口、进程消失变 reject、整体超时 —— 每一条的理由
// 都在那边的注释里，这里不复述。那个文件本身不动（spec §3.2）。
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { atomicWriteBytes } from '../persist/atomicWrite';
import { KydogError } from '../../shared/errors';
import type { MdExportOptions } from '../../shared/mdExport';
import { logger } from '../log';
import { settingsService } from '../settings/settingsService';
import { printableWidthPx, printOptionsFor } from './printOptions';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export type ExportPdfArgs = { mdPath: string; markdown: string; outPath: string; options: MdExportOptions };

/** 整体上限：错误上限，不是判据（spec §3.2）。网络图片一直不回应时就停在这里。 */
const EXPORT_TIMEOUT_MS = 60_000;

function bad(msg: string): never {
  throw new KydogError('fs.write_failed', msg);
}

function absPath(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) bad(`${what}必须是非空字符串`);
  if (v.includes('\0')) bad(`${what}里不能含 NUL 字符`);
  if (!path.isAbsolute(v)) bad(`${what}必须是绝对路径：${v}`);
  return v;
}

/** 校验不清洗：渲染层传来认不出的选项是 bug，悄悄换成默认值只会把它藏起来。 */
export function validateExportArgs(args: unknown): ExportPdfArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) bad('markdown.exportPdf 参数必须是对象');
  const a = args as Record<string, unknown>;
  const mdPath = absPath(a.mdPath, 'md 路径');
  const outPath = absPath(a.outPath, '导出路径');
  if (typeof a.markdown !== 'string') bad('markdown 必须是字符串');
  const o = a.options as Record<string, unknown> | undefined;
  if (typeof o !== 'object' || o === null
    || (o.paper !== 'a4' && o.paper !== 'letter')
    || (o.margin !== 'standard' && o.margin !== 'narrow')
    || typeof o.pageNumbers !== 'boolean') bad('导出选项不合法');
  return {
    mdPath, outPath, markdown: a.markdown,
    options: { paper: o.paper, margin: o.margin, pageNumbers: o.pageNumbers } as MdExportOptions,
  };
}

let activeWindow: BrowserWindow | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** 同 pdfRaster 的 windowGeneration：超时后还在飞的那次导出靠它发现自己已作废。 */
let windowGeneration = 0;

export function destroyMdPrintWindow(): void {
  windowGeneration += 1;
  const win = activeWindow;
  activeWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
}

function printPageLocation(): { url?: string; file?: string } {
  const devServer = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
  if (devServer) return { url: `${devServer}/src/renderer/assets/md-print.html` };
  return { file: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/src/renderer/assets/md-print.html`) };
}

const abandoned = () => new KydogError('fs.write_failed', '导出已被放弃（超时）');

async function createPrintWindow(onGone: (err: Error) => void, generation: number, width: number): Promise<BrowserWindow> {
  if (windowGeneration !== generation) throw abandoned();
  const win = new BrowserWindow({
    show: false,
    // 内容宽 = 这次导出的版心宽（printableWidthPx，spec §2.5）：块级图片在 load 时按当下的块宽写死高度，
    // 窗口比版心宽的话打印时宽图被裁。useContentSize：width 量的是网页的宽，不含窗框（Windows 的窗框
    // 会从 width 里再吃掉十几个像素）。页面自己的滚动条由 print.css 藏掉，理由在那边。
    width,
    height: 600,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // 不挂 preload：打印页拿不到 window.kydog（spec §3.2）
    },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('render-process-gone', (_e, details) => {
    onGone(new KydogError('fs.write_failed', `打印页进程退出：${details.reason}`));
  });
  win.webContents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return;
    logger.warn('md-print', `打印页 console.${details.level}`, {
      message: details.message, source: details.sourceId, line: details.lineNumber,
    });
  });
  activeWindow = win;
  const loc = printPageLocation();
  try {
    if (loc.url) await win.loadURL(loc.url);
    else await win.loadFile(loc.file!);
  } catch (err) {
    throw new KydogError('fs.write_failed', `打印页加载失败：${String(err)}`);
  }
  if (windowGeneration !== generation) {
    if (!win.isDestroyed()) win.destroy();
    if (activeWindow === win) activeWindow = null;
    throw abandoned();
  }
  return win;
}

async function doExport(args: ExportPdfArgs, generation: number): Promise<{ pdfPath: string }> {
  const readingFontSize = (await settingsService.get()).ui.readingFontSize;
  const payload = {
    markdown: args.markdown,
    mdPath: args.mdPath,
    title: path.basename(args.mdPath).replace(/\.(md|markdown)$/i, ''),
    readingFontSize,
  };
  const code = `window.__mdPrintReady.then(() => window.__mdPrint(${JSON.stringify(payload)}))`;
  let onGone!: (err: Error) => void;
  const gone = new Promise<never>((_, reject) => { onGone = reject; });
  gone.catch(() => {});

  let pdf: Buffer;
  try {
    const win = await Promise.race([createPrintWindow(onGone, generation, printableWidthPx(args.options)), gone]);
    await Promise.race([win.webContents.executeJavaScript(code) as Promise<void>, gone]);
    pdf = await Promise.race([win.webContents.printToPDF(printOptionsFor(args.options)), gone]);
  } catch (err) {
    if (err instanceof KydogError) throw err;
    throw new KydogError('fs.write_failed', `打印页渲染失败：${String(err)}`, err);
  }
  // printToPDF 恰在超时那一刻兑现时，这次导出已经被判了超时（用户看到「导出超时」、队列放行了下一次），
  // 这里还写盘就是用户以为失败了、文件却换了；下一次导出写同一路径的话，还可能被这份旧的盖掉。
  // 同 createPrintWindow 的做法：代号变了就是作废，不写。
  if (windowGeneration !== generation) throw abandoned();
  try {
    await atomicWriteBytes(args.outPath, pdf);
  } catch (err) {
    throw new KydogError('fs.write_failed', `无法写入 ${args.outPath}`, err);
  }
  logger.info('md-print', 'exported markdown to pdf', { md: args.mdPath, pdf: args.outPath, bytes: pdf.length, options: args.options });
  return { pdfPath: args.outPath };
}

async function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new KydogError('fs.write_failed', '导出超时（60 秒）')), EXPORT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 导出一份 md。并发调用排队；超时罩住整个 doExport（理由同 pdfRaster 的 renderPageToPng）。 */
export async function exportMarkdownPdf(rawArgs: unknown): Promise<{ pdfPath: string }> {
  const args = validateExportArgs(rawArgs);
  const runOnce = async () => {
    const generation = windowGeneration;
    try {
      return await withTimeout(doExport(args, generation));
    } finally {
      try {
        destroyMdPrintWindow();
      } catch (err) {
        logger.warn('md-print', '销毁打印窗口失败', { err: String(err) });
      }
    }
  };
  const run = queue.then(runOnce, runOnce);
  queue = run.then(() => undefined, () => undefined);
  return run;
}
