import { describe, it, expect } from 'vitest';
import { BLOCK_PAD, containsCenter, paddedRect, unionRect } from './blockRect';

describe('blockRect', () => {
  it('paddedRect 四周各外扩 BLOCK_PAD', () => {
    expect(paddedRect({ x: 10, y: 20, w: 100, h: 50 }))
      .toEqual({ x: 10 - BLOCK_PAD, y: 20 - BLOCK_PAD, w: 100 + 2 * BLOCK_PAD, h: 50 + 2 * BLOCK_PAD });
  });
  it('unionRect 取并集', () => {
    expect(unionRect([{ x: 10, y: 10, w: 20, h: 10 }, { x: 40, y: 30, w: 10, h: 10 }]))
      .toEqual({ x: 10, y: 10, w: 40, h: 30 });
  });
  it('unionRect 单个矩形原样返回', () => {
    expect(unionRect([{ x: 1, y: 2, w: 3, h: 4 }])).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
  it('unionRect 空数组抛错，不产出 Infinity 垃圾矩形', () => {
    // 去掉那道 guard 时这里会拿到 {x: Infinity, y: Infinity, w: -Infinity, h: -Infinity}
    // 而不是抛——断言「抛」正是为了把那条静默路径钉死。
    expect(() => unionRect([])).toThrow(/空的矩形数组/);
  });
  it('containsCenter 看的是中心点不是相交', () => {
    const r = { x: 0, y: 0, w: 100, h: 10 };
    // 与 r 相交但中心在外 → false（相邻两行字身框沾边的情形，不该被判死）
    expect(containsCenter(r, { x: 0, y: 8, w: 100, h: 10 })).toBe(false);
    // 中心在内 → true
    expect(containsCenter(r, { x: 0, y: 2, w: 100, h: 4 })).toBe(true);
  });
});
