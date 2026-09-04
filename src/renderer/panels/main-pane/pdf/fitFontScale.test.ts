import { describe, expect, it } from 'vitest';
import { fitFontScale } from './fitFontScale';

/** 高度与字号比例成正比的假页面 */
const linear = (hAt1: number) => (ratio: number) => hAt1 * ratio;

describe('fitFontScale', () => {
  it('一次就装得下 → 1，不做二分', () => {
    let calls = 0;
    const r = fitFontScale((ratio) => { calls++; return linear(50)(ratio); }, 60);
    expect(r).toBe(1);
    expect(calls).toBe(1);
  });

  it('装不下 → 收到装得下为止', () => {
    const r = fitFontScale(linear(100), 60);
    expect(r).toBeLessThanOrEqual(0.6);
    expect(linear(100)(r)).toBeLessThanOrEqual(60);
  });

  it('收敛精度：6 步之后离理论最优不超过 1%', () => {
    const r = fitFontScale(linear(100), 60);
    expect(r).toBeGreaterThan(0.6 - 0.01);
  });

  it('缩到下限仍不够 → 返回下限，不返回更小的值', () => {
    expect(fitFontScale(linear(1000), 60)).toBe(0.5);
  });

  it('下限可调', () => {
    expect(fitFontScale(linear(1000), 60, 0.25)).toBe(0.25);
  });

  it('maxH 为 0 → 下限', () => {
    expect(fitFontScale(linear(10), 0)).toBe(0.5);
  });
});
