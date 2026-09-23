/**
 * md 导出 PDF 的设置卡选项（spec docs/superpowers/specs/2026-09-22-md-export-pdf-design.md §2.2 / §3.7）。
 * 渲染层、主进程、设置文件共用这一份：放在 shared，两边都 import 得到。
 */
export type MdExportPaper = 'a4' | 'letter';
export type MdExportMargin = 'standard' | 'narrow';
export type MdExportOptions = { paper: MdExportPaper; margin: MdExportMargin; pageNumbers: boolean };

export const DEFAULT_MD_EXPORT: MdExportOptions = { paper: 'a4', margin: 'standard', pageNumbers: true };

/**
 * 逐项清洗：缺字段、类型不对、取值不认识 → **只有那一项**回默认。读盘（parseAndMigrateSettings）
 * 与写盘（settingsService.update）两条路共用这一个 —— 只在读路径清洗的话，渲染层传错一次就当场
 * 进 cache 与磁盘，重启才被拉回来，现象是「重启就好了」（同 sanitizeBrowserWidth 的理由）。
 */
export function sanitizeMdExport(v: unknown): MdExportOptions {
  const o = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return {
    paper: o.paper === 'a4' || o.paper === 'letter' ? o.paper : DEFAULT_MD_EXPORT.paper,
    margin: o.margin === 'standard' || o.margin === 'narrow' ? o.margin : DEFAULT_MD_EXPORT.margin,
    pageNumbers: typeof o.pageNumbers === 'boolean' ? o.pageNumbers : DEFAULT_MD_EXPORT.pageNumbers,
  };
}

/** 存储框的默认路径：md 同目录、同名，`.md` / `.markdown`（不分大小写）换成 `.pdf`，否则直接加（spec §2.3）。 */
export function defaultPdfPath(mdPath: string): string {
  const m = /\.(md|markdown)$/i.exec(mdPath);
  return m ? `${mdPath.slice(0, m.index)}.pdf` : `${mdPath}.pdf`;
}
