// 注意：类型名字是 `PrintToPDFOptions`，不是 `Electron.PrintToPDFOptions`——后者虽然 tsc
// 认（electron.d.ts 顶层确实有一个全局 `Electron` 命名空间），但 eslint 的 `no-undef`
// 不认这种走全局命名空间的写法，会报 `'Electron' is not defined`。electron 包自己在
// `declare module 'electron'` 里把它重新导出成同名的具名类型，import 这一个就两边都过。
import type { PrintToPDFOptions } from 'electron';
import type { MdExportOptions } from '../../shared/mdExport';

/**
 * 设置卡选项 → webContents.printToPDF 的参数（spec 2026-09-22-md-export-pdf-design §3.2）。
 * 边距单位是英寸：标准 1（Word「常规」25.4mm）、窄 0.5（Word「窄」12.7mm）。
 * printBackground 必须开：代码块的深底是背景色。
 * 不开 generateDocumentOutline / generateTaggedPDF：Yee 不要书签（§1.12）。
 */
/** 四边同一个边距（英寸）。printOptionsFor 与 printableWidthPx 都从这里取，两边不会各改各的。 */
function marginInches(o: MdExportOptions): number {
  return o.margin === 'narrow' ? 0.5 : 1;
}

export function printOptionsFor(o: MdExportOptions): PrintToPDFOptions {
  const m = marginInches(o);
  return {
    pageSize: o.paper === 'letter' ? 'Letter' : 'A4',
    margins: { top: m, bottom: m, left: m, right: m },
    printBackground: true,
    // CI 的 macOS Chromium 曾把 header/footer template 整段漏印（PDF 原件已核对）。
    // 页码由打印页的 @page @bottom-center 生成；这里关掉内建模板，避免本机重复印。
    displayHeaderFooter: false,
  };
}

/**
 * 纸宽（英寸），取 Electron 自己把 pageSize 字符串换成纸宽的那张表（Electron 41 的
 * webContents.printToPDF → parsePageSize：a4 8.27、letter 8.5），不是 ISO 的 210mm = 8.2677in ——
 * 传给 Chromium 的是这个数。
 */
const PAPER_WIDTH_IN: Record<MdExportOptions['paper'], number> = { a4: 8.27, letter: 8.5 };

/**
 * 版心宽（CSS px，96/in）= 纸宽 − 左右边距。打印窗口的内容宽度就开成这个数（spec §2.5）：
 * Crepe 的块级图片在 load 时按当下的块宽把 style.height 写死、配 object-fit: cover，窗口比版心宽的话，
 * printToPDF 按版心排版时宽度被 max-width 压窄、高度不变，宽图左右被裁掉。
 * 窗口只能宁窄勿宽（窄了只是图小不到一个像素，宽了就裁）。四舍五入在这里仍落在不宽的一侧：Chromium
 * 实际排版用的版心比名义值略宽 —— 2026-09-22 探针用 print 媒体查询量得 A4 标准 602.6、A4 窄 698.6、
 * Letter 恰好 624 / 720，而这里给 602 / 698 / 624 / 720。
 */
export function printableWidthPx(o: MdExportOptions): number {
  return Math.round((PAPER_WIDTH_IN[o.paper] - 2 * marginInches(o)) * 96);
}
