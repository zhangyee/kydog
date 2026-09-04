import { describe, it, expect, vi } from 'vitest';
import { prefetchPageSizes, FALLBACK_PAGE_SIZE, type PageProxyLike } from './PdfFileTab';

// `prefetchPageSizes` 是 Task 4 复审要求的容错路径（单页失败要隔离、不能拖垮整份文档）的核心
// 循环，从 PdfFileTab 组件里抽出来单测。组件本体依赖 react-pdf / DOM / window.kydog，这个仓库
// 的 vitest 是 `environment: 'node'`（无 jsdom），渲染级测试目前没有基础设施；这里改为对纯函数
// 灌入可控的 getPage/isCancelled 桩，直接断言「单页失败不中断循环」「取消后不吐部分结果」
// 「proxy 与失败各自的回调」这几条行为——比硬套一个渲染测试更直接，也不需要新依赖。

function fakePage(w: number, h: number, n = 0): PageProxyLike {
  return {
    pageNumber: n,
    getViewport: () => ({ width: w, height: h, convertToViewportPoint: () => [0, 0] }),
    getTextContent: () => Promise.resolve({ items: [] }),
  };
}

describe('prefetchPageSizes', () => {
  it('全部页成功：按页号顺序返回尺寸，逐页回调 onPageReady', async () => {
    const pages: Record<number, PageProxyLike> = { 1: fakePage(100, 200, 1), 2: fakePage(300, 400, 2), 3: fakePage(500, 600, 3) };
    const ready: number[] = [];
    const failed: number[] = [];
    const out = await prefetchPageSizes(
      3,
      async (n) => pages[n],
      () => false,
      (n) => ready.push(n),
      (n) => failed.push(n),
    );
    expect(out).toEqual([{ w: 100, h: 200 }, { w: 300, h: 400 }, { w: 500, h: 600 }]);
    expect(ready).toEqual([1, 2, 3]);
    expect(failed).toEqual([]);
  });

  it('单页 getPage 失败：跳过该页但继续跑完，占位保持下标对齐页号，不影响其余页', async () => {
    const failed: Array<{ n: number; err: unknown }> = [];
    const boom = new Error('坏页字典');
    const out = await prefetchPageSizes(
      3,
      async (n) => {
        if (n === 2) throw boom;
        return fakePage(n * 100, n * 100, n);
      },
      () => false,
      () => {},
      (n, err) => failed.push({ n, err }),
    );
    // 3 页全部在数组里，第 2 页是占位（不是被跳过导致后面的页整体前移一位）
    expect(out).toHaveLength(3);
    expect(out?.[0]).toEqual({ w: 100, h: 100 });
    expect(out?.[2]).toEqual({ w: 300, h: 300 });
    // 占位用最近一次成功页（第 1 页）的尺寸
    expect(out?.[1]).toEqual({ w: 100, h: 100 });
    // 失败留了痕，且是那一页、那个错误
    expect(failed).toEqual([{ n: 2, err: boom }]);
  });

  it('第 1 页就失败：占位退到 FALLBACK_PAGE_SIZE（还没有任何成功页可以借）', async () => {
    const out = await prefetchPageSizes(
      1,
      async () => { throw new Error('第一页也坏'); },
      () => false,
      () => {},
      () => {},
    );
    expect(out).toEqual([FALLBACK_PAGE_SIZE]);
  });

  it('单页失败不让 async 整体 reject：函数返回值而不是抛错/悬空 promise', async () => {
    const p = prefetchPageSizes(
      2,
      async (n) => { if (n === 1) throw new Error('x'); return fakePage(1, 1, n); },
      () => false,
      () => {},
      () => {},
    );
    await expect(p).resolves.toBeDefined();
  });

  it('取消：检测到取消后不再吐出结果——即使下一页的 getPage 已经在途', async () => {
    // 第 2 页 ready 时才置为已取消：第 3 页的 getPage 在那一刻可能已经在途（循环下一轮的 await
    // 先于本轮的取消检查发生），拦不住它被调用；但函数保证的是它的结果不会被交出去——
    // onPageReady 不会替第 3 页触发，整趟返回 null，调用方不会把这半成品当结果用。
    const getPage = vi.fn(async (n: number) => fakePage(n, n, n));
    const ready: number[] = [];
    let cancelled = false;
    const out = await prefetchPageSizes(
      5,
      getPage,
      () => cancelled,
      (n) => { ready.push(n); if (n === 2) cancelled = true; },
      () => {},
    );
    expect(out).toBeNull();
    expect(ready).toEqual([1, 2]);
  });

  it('取消：失败页之后也会被检测到 → 返回 null，不把这页失败当成「正常留痕」处理', async () => {
    const onPageFailed = vi.fn();
    const out = await prefetchPageSizes(
      3,
      async (n) => { if (n === 1) throw new Error('boom'); return fakePage(n, n, n); },
      () => true, // 从一开始就已取消（模拟：换文件发生在这次调用读到 token 之后、第一次 await 之前）
      () => {},
      onPageFailed,
    );
    expect(out).toBeNull();
    expect(onPageFailed).not.toHaveBeenCalled();
  });
});
