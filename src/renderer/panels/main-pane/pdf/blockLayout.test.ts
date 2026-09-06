import { describe, expect, it } from 'vitest';
import { fitFontScale } from './fitFontScale';
import { LEAD, LINE_HEIGHT, blockFrame, glyphHeight } from './blockLayout';

/** 模拟测量宿主：n 行译文、字号 px、行高 LINE_HEIGHT 时的 scrollHeight。 */
const scrollH = (lines: number, px: number) => lines * LINE_HEIGHT * px;

describe('glyphHeight', () => {
  it('一行的字形跨度就是字号本身（行框比字形高出的 LEAD 是空白）', () => {
    expect(glyphHeight(scrollH(1, 12), 12)).toBeCloseTo(12, 9);
  });
  it('n 行的字形跨度 = 行框总高 − 首尾半行距', () => {
    expect(glyphHeight(scrollH(3, 10), 10)).toBeCloseTo(3 * 15 - LEAD * 10, 9);
  });
});

describe('与 fitFontScale 合起来', () => {
  const px = 12;
  // 单行标题：块高 = 字高（边车里 30 个 title 块 h/fontSize 中位数 1.00）。原来 1.5·px > px 二分到 ≈ 0.67。
  it('单行块 → fit 恰为 1', () => {
    const fit = fitFontScale((r) => glyphHeight(scrollH(1, px * r), px * r), px);
    expect(fit).toBe(1);
  });
  // 三行原文（LaTeX 行距 1.2：px + 2 × 1.2·px = 3.4·px），中文两行（跨度 px + 1.5·px = 2.5·px）→ 装得下。
  it('三行原文、两行译文 → 1', () => {
    const fit = fitFontScale((r) => glyphHeight(scrollH(2, px * r), px * r), 3.4 * px);
    expect(fit).toBe(1);
  });
  // 两行原文（2.2·px）、译文仍两行（2.5·px）：1.5 倍行高本来就比 LaTeX 宽，仍要收——收到 2.2/2.5 = 0.88。
  it('两行原文、两行译文 → 仍二分，≈ 0.88', () => {
    const fit = fitFontScale((r) => glyphHeight(scrollH(2, px * r), px * r), 2.2 * px);
    expect(fit).toBeLessThan(1);
    expect(fit).toBeCloseTo(0.88, 1);
  });
});

describe('blockFrame', () => {
  it('上移四分之一字号、高度加半个字号——字形顶仍对齐 y、字形底仍不越过 y + h', () => {
    expect(blockFrame({ y: 100, height: 12 }, 12)).toEqual({ top: 97, height: 18 });
  });
  it('字号跟着 fit 走（调用方传的是 fontSize × SIZE_MUL × fit）', () => {
    expect(blockFrame({ y: 100, height: 40 }, 8)).toEqual({ top: 98, height: 44 });
  });
});
