import type { RGB } from './pageBackground';

/**
 * 译文墨色是内容，不随主题变 —— 与标注墨色同一条原则（见 annotationInks.ts 开头）。
 *
 * 译文块的底是 PDF 的底（右栏在矩形里填的是页背景色），而 --color-ink 跟的是应用主题：
 * midnight 下它接近白，压在白纸上对比度只有 ~1.23:1。所以墨色必须由**实际背景**推导。
 *
 * 两个候选取 vellum 的两端。sRGB 值是把对应的 oklch 交给 Chromium 算出来的——用 canvas 2D
 * context（colorSpace: 'srgb'）填色后 getImageData 读回字节，而不是 getComputedStyle().color：
 * 新版 Chromium 的 computed style 原样保留 oklch() 语法、不再折算成 rgb()，canvas 才会强制解析。
 * 注释里留着 oklch 原值以便对账；单测断言两者各自的对比度 ≥ 4.5:1，抄错会红。
 */
export const INK_ON_LIGHT: RGB = [32, 25, 20]; // oklch(0.22 0.015 60)
export const INK_ON_DARK: RGB = [249, 246, 241]; // oklch(0.975 0.008 85)

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 相对亮度对比度。1:1 到 21:1。 */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 两个候选里取对比度高的那个。
 * 这是一次**比较**，不是阈值判定——没有「亮度大于 0.5 就用黑字」那种拟合出来的分界。
 */
export function inkForBackground(bg: RGB): RGB {
  return contrast(INK_ON_LIGHT, bg) >= contrast(INK_ON_DARK, bg) ? INK_ON_LIGHT : INK_ON_DARK;
}

export function toCss([r, g, b]: RGB): string {
  return `rgb(${r}, ${g}, ${b})`;
}
