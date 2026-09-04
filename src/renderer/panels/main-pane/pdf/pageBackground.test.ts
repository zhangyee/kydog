import { describe, expect, it } from 'vitest';
import { pageBackground, type RGB } from './pageBackground';

const solid = (c: RGB) => () => c;
/** 左上角 40×40 是一张图，其余是白 */
const withCornerImage = (_w: number, _h: number) => (x: number, y: number): RGB =>
  (x < 40 && y < 40 ? [12, 34, 56] : [255, 255, 255]);

describe('pageBackground', () => {
  it('纯白页 → 白', () => {
    expect(pageBackground(solid([255, 255, 255]), 595, 842)).toEqual([255, 255, 255]);
  });

  it('深色页 → 该色', () => {
    expect(pageBackground(solid([18, 18, 22]), 595, 842)).toEqual([18, 18, 22]);
  });

  it('一角压着插图（八点不全同）→ null', () => {
    expect(pageBackground(withCornerImage(595, 842), 595, 842)).toBeNull();
  });

  it('采样点内缩，不落在最外一圈的抗锯齿上', () => {
    const seen: [number, number][] = [];
    pageBackground((x, y) => { seen.push([x, y]); return [255, 255, 255]; }, 100, 200, 2);
    expect(seen).toHaveLength(8);
    for (const [x, y] of seen) {
      expect(x).toBeGreaterThanOrEqual(2);
      expect(y).toBeGreaterThanOrEqual(2);
      expect(x).toBeLessThanOrEqual(97);
      expect(y).toBeLessThanOrEqual(197);
    }
  });

  it('只差一个通道也算不同 —— 二值判定，没有容差', () => {
    let n = 0;
    expect(pageBackground(() => (n++ === 0 ? [255, 255, 254] : [255, 255, 255]), 100, 100)).toBeNull();
  });

  it('页太小放不下 inset 时不抛，退回 null', () => {
    expect(pageBackground(solid([255, 255, 255]), 2, 2)).toBeNull();
  });
});
