// src/renderer/app/overlayColors.ts
export type OverlayColors = { color: string; symbolColor: string };

/** Windows 的 titleBarOverlay 需要两个颜色：按钮底色与符号色。真源是主题 CSS 的
 *  --color-titlebar-* token，主进程里不留任何副本，避免两处 hex 各自漂移。
 *
 *  底色取 bg-to 而不是 bg-from：TitleBar 是一条自上而下的渐变，overlay 只能是纯色，
 *  两端都对不齐；现有五套主题的渐变落差都很小（如 vellum 的 L 0.955→0.975），取哪端
 *  肉眼都看不出来，固定取 bg-to 以免每次改主题又要重新拍。
 *
 *  任一 token 读不到、或归一化失败，一律返回 null 而不是凑一个半截载荷 —— 主题 CSS
 *  还没生效时把默认黑刷上去，比让 overlay 多停留一帧系统色更难看。 */
export function overlayColors(
  readToken: (name: string) => string,
  toHex: (css: string) => string,
): OverlayColors | null {
  const bg = readToken('--color-titlebar-bg-to').trim();
  const fg = readToken('--color-titlebar-text').trim();
  if (!bg || !fg) return null;
  const color = toHex(bg);
  const symbolColor = toHex(fg);
  if (!color || !symbolColor) return null;
  return { color, symbolColor };
}
