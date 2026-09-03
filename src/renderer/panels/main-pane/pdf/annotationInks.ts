import type { HighlightColor, Level, NoteColor } from '../../../../shared/pdfSidecar';

// 标注墨色是内容，不随主题变。蓝（marginalia）与红（accent）直接取 vellum 的语义色值加透明度，
// 实测判定 OK，原样不动。
//
// 黄与绿另算：荧光笔的黄绿要**亮而饱和**，而语义色里的 amber / moss 是给小字用的暗调（低明度、低彩度），
// 压在纸上 multiply 出来是土黄和灰绿。这里的取值绕不开混色本身：multiply + alpha 的结果相当于按
// 「(1-a) + a×色」逐通道乘在纸上，alpha 越低越白、越接近纸色，所以想要「黄得起来」必须同时抬高
// 彩度与 alpha —— 低 alpha 下蓝通道压不下去，无论怎么调都是土色。文字是深色，multiply 保深，字仍清楚。
export const HIGHLIGHT_FILL: Record<HighlightColor, string> = {
  amber: 'oklch(0.93 0.19 100 / 0.78)',
  moss: 'oklch(0.86 0.21 142 / 0.62)',
  marginalia: 'oklch(0.42 0.10 250 / 0.30)',
  accent: 'oklch(0.55 0.16 28 / 0.30)',
};
/** 高亮色点与预览用的实心色：比 HIGHLIGHT_FILL 的黄绿压暗一档，纸底上那颗 20px 圆点才看得出边界。 */
export const HIGHLIGHT_SWATCH: Record<HighlightColor, string> = {
  amber: 'oklch(0.86 0.18 100)',
  moss: 'oklch(0.74 0.19 142)',
  marginalia: 'oklch(0.42 0.10 250)',
  accent: 'oklch(0.55 0.16 28)',
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
