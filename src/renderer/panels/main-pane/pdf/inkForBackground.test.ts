import { describe, expect, it } from 'vitest';
import { INK_ON_DARK, INK_ON_LIGHT, contrast, inkForBackground, toCss } from './inkForBackground';

const WHITE: [number, number, number] = [255, 255, 255];
const NEAR_BLACK: [number, number, number] = [18, 18, 22];

describe('contrast', () => {
  it('黑白是 21:1', () => {
    expect(contrast([0, 0, 0], WHITE)).toBeCloseTo(21, 1);
  });
  it('对称', () => {
    expect(contrast([12, 34, 56], WHITE)).toBeCloseTo(contrast(WHITE, [12, 34, 56]), 6);
  });
});

describe('两个墨色常量本身够用', () => {
  // 这两条同时也是「Step 1 的 sRGB 有没有抄错」的守卫
  it('浅底墨色对白纸 ≥ 4.5:1', () => {
    expect(contrast(INK_ON_LIGHT, WHITE)).toBeGreaterThanOrEqual(4.5);
  });
  it('深底墨色对近黑底 ≥ 4.5:1', () => {
    expect(contrast(INK_ON_DARK, NEAR_BLACK)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('inkForBackground', () => {
  it('白底选浅底墨色', () => {
    expect(inkForBackground(WHITE)).toEqual(INK_ON_LIGHT);
  });
  it('近黑底选深底墨色', () => {
    expect(inkForBackground(NEAR_BLACK)).toEqual(INK_ON_DARK);
  });
  it('任何背景下选出来的墨色对比度都是两者中较高的那个', () => {
    for (const g of [0, 40, 80, 120, 160, 200, 255]) {
      const bg: [number, number, number] = [g, g, g];
      const got = inkForBackground(bg);
      expect(contrast(got, bg)).toBeGreaterThanOrEqual(
        Math.min(contrast(INK_ON_LIGHT, bg), contrast(INK_ON_DARK, bg)),
      );
      expect(contrast(got, bg)).toBe(Math.max(contrast(INK_ON_LIGHT, bg), contrast(INK_ON_DARK, bg)));
    }
  });
});

describe('toCss', () => {
  it('输出 rgb()', () => {
    expect(toCss([1, 2, 3])).toBe('rgb(1, 2, 3)');
  });
});
