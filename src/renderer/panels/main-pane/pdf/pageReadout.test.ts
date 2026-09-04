import { describe, it, expect } from 'vitest';
import { mostVisiblePage } from './pageReadout';
import type { PageSize } from './pageLayout';

const h = (...hs: number[]): PageSize[] => hs.map((y) => ({ w: 595, h: y }));

describe('mostVisiblePage', () => {
  // 三页 600 高、间距 16：顶边 0 / 616 / 1232。视口 [700, 1226] 高 526：
  // 第 1 页整个在上方、第 2 页占了 516、第 3 页只露出来 0（顶边 1232 在视口下沿之外）
  const tops = [0, 616, 1232];
  const sizes = h(600, 600, 600);

  it('取视口内可见高度最大的页', () => {
    expect(mostVisiblePage(tops, sizes, 1, 700, 1226)).toBe(2);
  });

  it('两页各占一半时取靠前的', () => {
    expect(mostVisiblePage([0, 563], h(563, 563), 1, 300, 826)).toBe(1);
  });

  it('都不可见时取离视口最近的页', () => {
    // 视口整个落在最后一页下方的留白里：三页都在视口之上，取靠后的那页
    expect(mostVisiblePage(tops, sizes, 1, 2000, 2526)).toBe(3);
    // 反过来滚到内容上方（橡皮筋回弹）：取第 1 页
    expect(mostVisiblePage(tops, sizes, 1, -1000, -474)).toBe(1);
  });

  it('页顶边按 scale 缩放，不是按 scale 1 的坐标判', () => {
    // scale 2 之后第 2 页在 [1232, 2432]；视口 [1300, 1826] 整个落在它身上
    expect(mostVisiblePage(tops, sizes, 2, 1300, 1826)).toBe(2);
    // 同一个视口在 scale 1 下落的是第 3 页（[1232, 1832]）——同一份 tops，结论不同
    expect(mostVisiblePage(tops, sizes, 1, 1300, 1826)).toBe(3);
  });

  it('空文档返回 1', () => {
    expect(mostVisiblePage([], [], 1, 0, 526)).toBe(1);
  });
});
