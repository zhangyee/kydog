import { describe, expect, it } from 'vitest';
import { unitLayout, type PageSize } from './pageLayout';
import { computeWindow, WINDOW_BUDGET_PX, type WindowInput } from './pageWindow';

const A4: PageSize = { w: 595, h: 842 };
const pages = (n: number): PageSize[] => Array.from({ length: n }, () => A4);

function input(over: Partial<WindowInput> & { sizes: PageSize[] }): WindowInput {
  const { tops } = unitLayout(over.sizes, 16, 24);
  return {
    tops, scrollTop: 0, clientHeight: 900, visualScale: 1, dpr: 2,
    columns: 1, editingPage: null, ...over,
  };
}

/** 窗口内所有页所有栏的像素总和 */
function used(r: { pages: Set<number>; rasterScale: number }, sizes: PageSize[], dpr: number, columns: number) {
  let sum = 0;
  for (const p of r.pages) sum += sizes[p - 1].w * sizes[p - 1].h * (r.rasterScale * dpr) ** 2 * columns;
  return sum;
}

describe('computeWindow', () => {
  it('空文档不炸', () => {
    const r = computeWindow(input({ sizes: [] }));
    expect(r.pages.size).toBe(0);
    expect(r.rasterScale).toBe(1);
  });

  it('短文档低缩放：全部在窗口内，栅格不降级', () => {
    const r = computeWindow(input({ sizes: pages(3) }));
    expect(r.rasterScale).toBe(1);
    expect([...r.pages].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('长文档：窗口远小于总页数，且总像素不超预算', () => {
    const sizes = pages(1000);
    const r = computeWindow(input({ sizes, scrollTop: 200000 }));
    expect(r.pages.size).toBeLessThan(30);
    expect(used(r, sizes, 2, 1)).toBeLessThanOrEqual(WINDOW_BUDGET_PX);
  });

  it('高缩放：rasterScale 被预算封顶，低于 visualScale', () => {
    const sizes = pages(20);
    const r = computeWindow(input({ sizes, visualScale: 5, scrollTop: 0 }));
    expect(r.rasterScale).toBeLessThan(5);
    expect(used(r, sizes, 2, 1)).toBeLessThanOrEqual(WINDOW_BUDGET_PX);
  });

  it('必保集合从 2 页变 3 页时，rasterScale 相应降低而不是超额', () => {
    const sizes = pages(50);
    // 滚到两页交界处：两页都可见
    const { tops } = unitLayout(sizes, 16, 24);
    const boundary = (tops[10] + 842) - 450;   // 第 11 页底边正好在视口中间
    const two = computeWindow(input({ sizes, scrollTop: boundary, visualScale: 5 }));
    const three = computeWindow(input({ sizes, scrollTop: boundary, visualScale: 5, editingPage: 1 }));

    expect(three.rasterScale).toBeLessThan(two.rasterScale);
    expect(used(three, sizes, 2, 1)).toBeLessThanOrEqual(WINDOW_BUDGET_PX);
  });

  it('editingPage 必在窗口内，哪怕它离视口很远', () => {
    const r = computeWindow(input({ sizes: pages(500), scrollTop: 300000, editingPage: 1 }));
    expect(r.pages.has(1)).toBe(true);
  });

  it('双栏时同一预算下 rasterScale 更低', () => {
    const sizes = pages(20);
    const one = computeWindow(input({ sizes, visualScale: 5, columns: 1 }));
    const two = computeWindow(input({ sizes, visualScale: 5, columns: 2 }));
    expect(two.rasterScale).toBeLessThan(one.rasterScale);
    expect(used(two, sizes, 2, 2)).toBeLessThanOrEqual(WINDOW_BUDGET_PX);
  });

  it('预算被调到极小时窗口仍不为空', () => {
    const r = computeWindow(input({ sizes: pages(100), scrollTop: 50000, budgetPx: 1000 }));
    expect(r.pages.size).toBeGreaterThanOrEqual(1);
    expect(r.rasterScale).toBeGreaterThan(0);
  });

  it('视口落在页间留白里时，取最近的一页而不是空集', () => {
    const sizes = pages(5);
    const { tops } = unitLayout(sizes, 16, 24);
    // 第 2 页底边与第 3 页顶边之间那 16pt
    const gapTop = tops[1] + 842 + 4;
    const r = computeWindow(input({ sizes, scrollTop: gapTop, clientHeight: 8 }));
    expect(r.pages.size).toBeGreaterThanOrEqual(1);
  });
});
