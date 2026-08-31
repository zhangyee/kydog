// src/renderer/app/domColor.ts
//
// 这两个函数都直接碰 DOM。vitest 是 environment: 'node'（见 vitest.config.ts），
// 没有 document 也没有 canvas，测不了 —— 纯逻辑已经拆到 overlayColors.ts 单测，
// 这里剩下的薄适配层靠 e2e 与手测覆盖。

/** 把任意 CSS 颜色归一化成 #rrggbb。
 *
 *  主题 token 有四套是 oklch()，而 Electron 的颜色解析器只认 Hex / RGB / RGBA /
 *  HSL / HSLA / 具名色（electron.d.ts 里 backgroundColor 的说明就是这么列的，
 *  没有 CSS Color 4），直接把 oklch 交给 setTitleBarOverlay 会解析失败。
 *
 *  过一次 1×1 画布再读像素，而不是读 ctx.fillStyle 的 getter：后者对超出 sRGB 的
 *  颜色会回吐 color(display-p3 …)，那同样喂不进 Electron。读像素拿到的必然是
 *  sRGB 8bit 三元组。 */
export function cssColorToHex(css: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '';
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 读根元素上某个 CSS 自定义属性的计算值（var() 已代入）。 */
export function readCssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}
