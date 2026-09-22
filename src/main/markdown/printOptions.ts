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
export const FOOTER_TEMPLATE = '<div style="width:100%;text-align:center;font-size:8px;color:#8a8a8a;'
  + 'font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;">'
  + '— <span class="pageNumber"></span> —</div>';

export function printOptionsFor(o: MdExportOptions): PrintToPDFOptions {
  const m = o.margin === 'narrow' ? 0.5 : 1;
  return {
    pageSize: o.paper === 'letter' ? 'Letter' : 'A4',
    margins: { top: m, bottom: m, left: m, right: m },
    printBackground: true,
    displayHeaderFooter: o.pageNumbers,
    ...(o.pageNumbers ? { headerTemplate: '<span></span>', footerTemplate: FOOTER_TEMPLATE } : {}),
  };
}
