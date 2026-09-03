import type { HighlightColor, Level, NoteColor } from '../../../../shared/pdfSidecar';

// 标注墨色是内容，不随主题变：固定取 vellum 的四个语义色值（src/renderer/theme/vellum.css）。
export const HIGHLIGHT_FILL: Record<HighlightColor, string> = {
  amber: 'oklch(0.62 0.10 75 / 0.42)',
  moss: 'oklch(0.48 0.06 150 / 0.36)',
  marginalia: 'oklch(0.42 0.10 250 / 0.30)',
  accent: 'oklch(0.55 0.16 28 / 0.30)',
};
export const SWATCH: Record<HighlightColor | NoteColor, string> = {
  amber: 'oklch(0.62 0.10 75)',
  moss: 'oklch(0.48 0.06 150)',
  marginalia: 'oklch(0.42 0.10 250)',
  accent: 'oklch(0.55 0.16 28)',
  ink: 'oklch(0.22 0.015 60)',
};
export const NOTE_INK: Record<NoteColor, string> = {
  ink: SWATCH.ink, accent: SWATCH.accent, marginalia: SWATCH.marginalia, moss: SWATCH.moss,
};
export const HIGHLIGHT_COLORS: HighlightColor[] = ['amber', 'moss', 'marginalia', 'accent'];
export const NOTE_COLORS: NoteColor[] = ['ink', 'accent', 'marginalia', 'moss'];
export const LEVELS: Level[] = [1, 2, 3];
/** scale 1 下的笔画宽度（px） */
export const STROKE_WIDTH: Record<Level, number> = { 1: 6, 2: 10, 3: 14 };
/** scale 1 下的文字注字号（px = pt，因为 scale 1 就是 PDF 用户坐标）。
 *  论文正文通常 9–10pt，所以最小档必须比它更小，笔记才不会喧宾夺主（用户反馈 4）。 */
export const NOTE_FONT_SIZE: Record<Level, number> = { 1: 7, 2: 10, 3: 14 };
/** 卡片与浮条里字号预览用的「A」字号：按 NOTE_FONT_SIZE 原样画在 28px 高的格子里太小，认不出档位差别。 */
export const NOTE_SIZE_PREVIEW: Record<Level, number> = { 1: 11, 2: 15, 3: 20 };
/** 卡片与浮条里粗细预览的线高 */
export const STROKE_PREVIEW: Record<Level, number> = { 1: 3, 2: 6, 3: 10 };
