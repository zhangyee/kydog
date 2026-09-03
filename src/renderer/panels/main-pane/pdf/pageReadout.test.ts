import { describe, it, expect } from 'vitest';
import { mostVisiblePage } from './pageReadout';

describe('mostVisiblePage', () => {
  const rects = [
    { page: 1, top: -700, bottom: -100 },
    { page: 2, top: -84, bottom: 516 },
    { page: 3, top: 532, bottom: 1132 },
  ];
  it('取视口内可见高度最大的页', () => {
    expect(mostVisiblePage(rects, 0, 526)).toBe(2);
  });
  it('两页各占一半时取靠前的', () => {
    expect(mostVisiblePage([{ page: 1, top: -300, bottom: 263 }, { page: 2, top: 263, bottom: 826 }], 0, 526)).toBe(1);
  });
  it('都不可见时取第一页', () => {
    expect(mostVisiblePage([{ page: 4, top: 900, bottom: 1500 }], 0, 526)).toBe(4);
  });
  it('空表返回 1', () => {
    expect(mostVisiblePage([], 0, 526)).toBe(1);
  });
});
