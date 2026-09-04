import { describe, expect, it } from 'vitest';
import { unitLayout, PAGE_GAP, PAGE_PAD, type PageSize } from './pageLayout';
import { computeWindow, sameWindow, COLUMN_BUDGET_PX, type WindowInput } from './pageWindow';

const A4: PageSize = { w: 595, h: 842 };
const pages = (n: number): PageSize[] => Array.from({ length: n }, () => A4);

function input(over: Partial<WindowInput> & { sizes: PageSize[] }): WindowInput {
  const { tops } = unitLayout(over.sizes, PAGE_GAP, PAGE_PAD);
  return {
    tops, scrollTop: 0, clientHeight: 900, visualScale: 1, dpr: 2,
    editingPage: null, ...over,
  };
}

/** 窗口内一栏的像素总和（columns 已不进入 computeWindow，这里就是总用量） */
function used(r: { pages: Set<number>; rasterScale: number }, sizes: PageSize[], dpr: number) {
  let sum = 0;
  for (const p of r.pages) sum += sizes[p - 1].w * sizes[p - 1].h * (r.rasterScale * dpr) ** 2;
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
    expect(used(r, sizes, 2)).toBeLessThanOrEqual(COLUMN_BUDGET_PX);
  });

  it('高缩放：rasterScale 被预算封顶，低于 visualScale', () => {
    const sizes = pages(20);
    const r = computeWindow(input({ sizes, visualScale: 5, scrollTop: 0 }));
    expect(r.rasterScale).toBeLessThan(5);
    expect(used(r, sizes, 2)).toBeLessThanOrEqual(COLUMN_BUDGET_PX);
  });

  it('必保集合从 2 页变 3 页时，rasterScale 相应降低而不是超额', () => {
    const sizes = pages(50);
    // 滚到两页交界处：两页都可见
    const { tops } = unitLayout(sizes, PAGE_GAP, PAGE_PAD);
    const boundary = (tops[10] + 842) - 450;   // 第 11 页底边正好在视口中间
    const two = computeWindow(input({ sizes, scrollTop: boundary, visualScale: 5 }));
    const three = computeWindow(input({ sizes, scrollTop: boundary, visualScale: 5, editingPage: 1 }));

    expect(three.rasterScale).toBeLessThan(two.rasterScale);
    expect(used(three, sizes, 2)).toBeLessThanOrEqual(COLUMN_BUDGET_PX);
  });

  it('editingPage 必在窗口内，哪怕它离视口很远', () => {
    const r = computeWindow(input({ sizes: pages(500), scrollTop: 300000, editingPage: 1 }));
    expect(r.pages.has(1)).toBe(true);
  });

  it('visible 不含 editingPage（它可能在视口外，不该拖住双缓冲顶替）', () => {
    const r = computeWindow(input({ sizes: pages(500), scrollTop: 300000, editingPage: 1 }));
    expect(r.pages.has(1)).toBe(true);
    expect(r.visible.has(1)).toBe(false);
    expect(r.visible.size).toBeGreaterThan(0);
  });

  it('visible 是 pages 的子集，且只含与视口相交的页', () => {
    const sizes = pages(50);
    const { tops } = unitLayout(sizes, PAGE_GAP, PAGE_PAD);
    const r = computeWindow(input({ sizes, scrollTop: tops[9] }));
    for (const p of r.visible) expect(r.pages.has(p)).toBe(true);
    // 视口 [tops[9], tops[9] + 900]：第 10 页（顶边正好在视口顶）与第 11 页各占一段
    expect([...r.visible].sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it('视口落在留白里时 visible 不为空（否则顶替条件永远凑不齐）', () => {
    const sizes = pages(5);
    const { tops } = unitLayout(sizes, PAGE_GAP, PAGE_PAD);
    const r = computeWindow(input({ sizes, scrollTop: tops[1] + 842 + 4, clientHeight: 8 }));
    expect(r.visible.size).toBe(1);
  });

  // 栏数不影响 rasterScale（v6 订正）：预算口径是「每栏」，每栏各自反解 cap，互不拖累。
  // computeWindow / WindowInput 已经不接受 columns 参数——栏数根本不进入这条计算，
  // 所以「双栏时 rasterScale 更低」这个维度不存在了，没有对应的行为用例可写；下面这条
  // 编译期哨兵钉住「不接受」本身，不是靠注释宣称。
  it('WindowInput 不接受 columns（回归哨兵）', () => {
    // @ts-expect-error —— columns 不在 WindowInput 里。这行一旦不再报错，说明有人把栏数加回了
    // 这条计算：先去核对 spec §8.2「v6 订正」的「每栏各自反解 cap、互不拖累」是否还成立，
    // 而不是默默让它编译通过。
    // 局限：这条哨兵防的是「加回 columns 这个名字」，防不住换个名字（比如 paneCount）重新
    // 引入同一个 bug——静态检查只能钉住已知的名字，钉不住任意换皮的复发。
    const withColumns: WindowInput = { ...input({ sizes: pages(1) }), columns: 2 };
    void withColumns;
  });

  it('预算被调到极小时窗口仍不为空', () => {
    const r = computeWindow(input({ sizes: pages(100), scrollTop: 50000, budgetPx: 1000 }));
    expect(r.pages.size).toBeGreaterThanOrEqual(1);
    expect(r.rasterScale).toBeGreaterThan(0);
  });

  it('视口落在页间留白里时，取最近的一页而不是空集', () => {
    const sizes = pages(5);
    const { tops } = unitLayout(sizes, PAGE_GAP, PAGE_PAD);
    // 第 2 页底边与第 3 页顶边之间那 16pt
    const gapTop = tops[1] + 842 + 4;
    const r = computeWindow(input({ sizes, scrollTop: gapTop, clientHeight: 8 }));
    expect(r.pages.size).toBeGreaterThanOrEqual(1);
  });

  // ——— 扩张的空间上界（spec §8.2「v4 新增」）———

  it('扩张不超出「视口上下各一个视口高度」：低缩放下窗口远小于预算装得下的页数', () => {
    const sizes = pages(800);
    const { tops } = unitLayout(sizes, PAGE_GAP, PAGE_PAD);
    // 0.25 缩放 / dpr 1：单页像素只有 3.13e4，预算装得下 1532 页——只按预算会把全部 800 页挂上
    const r = computeWindow(input({ sizes, visualScale: 0.25, dpr: 1, scrollTop: 20000 }));
    expect(r.pages.size).toBeLessThanOrEqual(14);
    expect(used(r, sizes, 1) / COLUMN_BUDGET_PX).toBeLessThan(0.02); // 远没花光预算，是空间上界在收手

    // 窗口里每一页都与 [视口顶 − 视口高, 视口底 + 视口高] 相交（必保集合这里恰好也在带内）
    const bandTop = 20000 - 900;
    const bandBottom = 20000 + 900 * 2;
    for (const p of r.pages) {
      expect((tops[p - 1] + 842) * 0.25).toBeGreaterThan(bandTop);
      expect(tops[p - 1] * 0.25).toBeLessThan(bandBottom);
    }
  });

  it('窗口页数由 3 个视口高的内容范围定，与预算宽松到什么程度无关', () => {
    const sizes = pages(800);
    // 扫过一整个页间距，取窗口最大的那个位置（页数随滚动位置在相邻两个值间跳）
    const worst = (visualScale: number, dpr: number) => {
      const pitch = (842 + PAGE_GAP) * visualScale;
      let max = 0;
      for (let i = 0; i < 200; i++) {
        const r = computeWindow(input({ sizes, visualScale, dpr, scrollTop: 100 * pitch + (i * pitch) / 200 }));
        max = Math.max(max, r.pages.size);
      }
      return max;
    };
    // 独立验算（A4 595×842、gap 16、pad 24、视口 900、预算 4.8e7）：
    //   缩放 1.0 / dpr 2 → 仅按预算 23 页，空间上界 5 页
    //   缩放 0.5 / dpr 2 → 仅按预算 95 页，空间上界 8 页
    //   缩放 0.25 / dpr 2 → 仅按预算 383 页，空间上界 14 页
    //   缩放 0.25 / dpr 1 → 仅按预算 1532 页，空间上界 14 页（dpr 只影响预算那一侧，上界不动）
    expect(worst(1, 2)).toBe(5);
    expect(worst(0.5, 2)).toBe(8);
    expect(worst(0.25, 2)).toBe(14);
    expect(worst(0.25, 1)).toBe(14);
  });

  it('预算比空间上界更紧时预算说了算（取 min 的另一侧）', () => {
    const sizes = pages(800);
    const loose = computeWindow(input({ sizes, visualScale: 0.25, dpr: 1, scrollTop: 20000, budgetPx: 1e12 }));
    // 预算紧到反解出的 rasterScale 让必保集合恰好铺满预算：一页预取的余地都没有
    const tight = computeWindow(input({ sizes, visualScale: 0.25, dpr: 1, scrollTop: 20000, budgetPx: 1e5 }));
    expect(loose.pages.size).toBeGreaterThan(tight.pages.size);
    expect([...tight.pages].sort((a, b) => a - b)).toEqual([...tight.visible].sort((a, b) => a - b));
  });

  it('必保集合不受空间上界约束：远处的 editingPage 照样挂着，别的越界页一个都不进来', () => {
    const sizes = pages(800);
    const { tops } = unitLayout(sizes, PAGE_GAP, PAGE_PAD);
    const scrollTop = 200000;
    const r = computeWindow(input({ sizes, scrollTop, editingPage: 1 }));
    expect(r.pages.has(1)).toBe(true);
    // 第 1 页离带子十万八千里——它在窗口里只因为是必保页
    expect((tops[0] + 842)).toBeLessThan(scrollTop - 900);
    // 除它以外，窗口里的页全在带内
    for (const p of r.pages) {
      if (p === 1) continue;
      expect(tops[p - 1] + 842).toBeGreaterThan(scrollTop - 900);
      expect(tops[p - 1]).toBeLessThan(scrollTop + 1800);
    }
  });

  it('clientHeight 为 0（tab 被隐藏）= 没有视口：窗口退到只剩必保页，不预取', () => {
    const sizes = pages(800);
    const { tops } = unitLayout(sizes, PAGE_GAP, PAGE_PAD);
    // 视口高度 0、位置落在第 51 页正中：must 就是这一页，带宽为 0，两侧都扩不出去
    const r = computeWindow(input({ sizes, clientHeight: 0, scrollTop: tops[50] + 400 }));
    expect([...r.pages]).toEqual([51]);
    expect([...r.visible]).toEqual([51]);

    // 与「视口落在页间留白里」区分开：那时视口是真实存在的，带宽照常是 3 个视口高，照常预取
    const inGap = computeWindow(input({ sizes, clientHeight: 900, scrollTop: tops[50] + 842 + 4 }));
    expect(inGap.pages.size).toBeGreaterThan(1);
  });
});

describe('sameWindow', () => {
  const w = (pages: number[], visible: number[], rasterScale: number) =>
    ({ pages: new Set(pages), visible: new Set(visible), rasterScale });

  it('三样全同才算同一个窗口', () => {
    expect(sameWindow(w([1, 2], [1], 1), w([2, 1], [1], 1))).toBe(true);
    expect(sameWindow(w([1, 2], [1], 1), w([1, 2, 3], [1], 1))).toBe(false);
    expect(sameWindow(w([1, 2], [1], 1), w([1, 2], [1, 2], 1))).toBe(false);
    expect(sameWindow(w([1, 2], [1], 1), w([1, 2], [1], 0.9))).toBe(false);
  });

  it('页数相同但成员不同也算变了', () => {
    expect(sameWindow(w([1, 2], [1], 1), w([2, 3], [2], 1))).toBe(false);
  });
});
