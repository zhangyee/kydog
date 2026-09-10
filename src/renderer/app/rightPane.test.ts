import { describe, it, expect } from 'vitest';
import { rightPaneLayout, browserWidthFor, availableForCenterAndRight, type RightPaneState } from './rightPane';

const S = (p: Partial<RightPaneState> = {}): RightPaneState => ({
  browserOpen: false, browserWidth: null, browserFullscreen: false,
  inspectorCollapsed: false, inspectorWidth: 280, availableWidth: 1012, ...p,
});

describe('rightPaneLayout', () => {
  it('浏览器关着 → Inspector，用它自己的宽度与收起状态', () => {
    expect(rightPaneLayout(S())).toEqual({ mode: 'inspector', width: 280, collapsed: false, centerHidden: false });
    expect(rightPaneLayout(S({ inspectorCollapsed: true })))
      .toEqual({ mode: 'inspector', width: 280, collapsed: true, centerHidden: false });
  });

  /**
   * 第二轮变异 N12 是从这里活下来的：`rightWidth` 改成恒取 `insWidth` 时三条 gate 全绿，
   * 现象是拖宽浏览器侧栏，DOM 那一栏跟着变而原生网页停在旧宽度上（或者反过来）。
   */
  it('浏览器开着 → 用浏览器自己的宽度，不是 Inspector 的', () => {
    // availableWidth 拉宽到 1200：700 才不会撞上 browserWidthFor 的下限（那是另一组用例的正题，
    // 这条只想守「读的是 browserWidth 不是 inspectorWidth」，不想被下限钳制打岔。
    const l = rightPaneLayout(S({
      browserOpen: true, browserWidth: 700, inspectorWidth: 280, availableWidth: 1200,
    }));
    expect(l.mode).toBe('browser');
    expect(l.width).toBe(700);
  });

  it('浏览器开着时右栏一定是展开的，哪怕 Inspector 记着「收起」', () => {
    expect(rightPaneLayout(S({ browserOpen: true, inspectorCollapsed: true })).collapsed).toBe(false);
  });

  it('关掉浏览器之后 Inspector 回到用户上次留下的样子（收起状态没被掰过）', () => {
    const before = S({ inspectorCollapsed: true });
    rightPaneLayout({ ...before, browserOpen: true });
    expect(rightPaneLayout(before)).toEqual({ mode: 'inspector', width: 280, collapsed: true, centerHidden: false });
  });

  it('两份宽度互不冒充：两个数不一样时各归各的', () => {
    // 同上：availableWidth 拉宽到 1200，避免 700 撞上下限、把这条测试的正题岔开。
    const s = S({ browserWidth: 700, inspectorWidth: 280, availableWidth: 1200 });
    expect(rightPaneLayout({ ...s, browserOpen: true }).width).toBe(700);
    expect(rightPaneLayout({ ...s, browserOpen: false }).width).toBe(280);
  });
});

describe('browserWidthFor', () => {
  it('没设定过 → 按 4:6 算（1280 窗口下可用 1012 → 浏览器 607、对话 405）', () => {
    expect(browserWidthFor(null, 1012)).toBe(607);
  });

  /**
   * **本节正题。** 4:6 在 1024 窗口下给对话栏 306，低于 MIN_MAIN_WIDTH。
   * 下限必须压过 4:6 —— 不压的话就是「1024 窗口把 composer 挤没」那个已登记的坑。
   */
  it('可用宽度不够时下限压过 4:6：756 → 浏览器 396、对话 360（不是 454/306）', () => {
    expect(browserWidthFor(null, 756)).toBe(396);
  });

  it('记住的宽度一样要被下限压：设定 700、可用 756 → 396', () => {
    expect(browserWidthFor(700, 756)).toBe(396);
  });

  /**
   * 简报原文这里写的是「设定 700、可用 1012 → 700」（原样通过、不压）。跑出来是 652，
   * 且这不是实现的锅：同一份公式（`available - MIN_MAIN_WIDTH`）在「700、756 → 396」
   * 那条已经被另外两条用例钉死，MIN_MAIN_WIDTH 不能同时 ≤312（满足这里）又 ≥360
   * （满足那条）。1012 这个可用宽度本身是被复用的既有夹具（对应 1280 窗口，出现在
   * `browserWidthFor(null, 1012)` 与全屏那条用例里），不像是笔误；700 才是那个孤立、
   * 只在这一条出现的数。于是改的是这条断言，不是公式——652 卡在下限，对话栏刚好拿到
   * 360（MIN_MAIN_WIDTH），这正是「下限压过记住的宽度」那条规则本该产生的结果。
   * 已在 task-1-report.md 里记录，供复核。
   */
  it('记住的宽度一样要被下限压——即便在这个「宽」窗口夹具下：设定 700、可用 1012 → 652（对话栏刚好卡在 360）', () => {
    expect(browserWidthFor(700, 1012)).toBe(652);
  });

  /**
   * 外层那道 `Math.max(MIN_BROWSER_WIDTH, …)` 防的是**手改配置改小了**的情形
   * （落盘那一侧的 sanitize 会把 < 320 的值判成「未设定」，但这个函数是导出的，
   * 拖拽那条路 Task 2 还要改它 —— 一道没人守的钳制迟早被顺手删掉）。
   * 没有这一条的话，把整条外层钳制删掉 17 条用例**一条都不红**（评审实测）。
   */
  it('记住的宽度小于浏览器下限时被抬回 320', () => {
    expect(browserWidthFor(100, 1012)).toBe(320);
  });

  /**
   * 两个下限加起来 680。**在这个边界上不许跳变** —— 写成「放不下就按 4:6 缩」
   * 的话，可用 680 给 320、679 给 407，窗口窄 1px 浏览器反而暴涨 87px。
   */
  it('两边下限的边界上是连续的：680 → 320，679 → 320', () => {
    expect(browserWidthFor(null, 680)).toBe(320);
    expect(browserWidthFor(null, 679)).toBe(320);
  });

  it('窄到两个下限都放不下 → 按下限的比例缩，谁都不为 0', () => {
    expect(browserWidthFor(null, 340)).toBe(160);
    expect(browserWidthFor(null, 10)).toBeGreaterThan(0);
  });
});

describe('availableForCenterAndRight', () => {
  it('减掉左栏与两个把手', () => {
    expect(availableForCenterAndRight(1280, false, 260)).toBe(1012);
    expect(availableForCenterAndRight(1024, false, 260)).toBe(756);
  });
  it('左栏收起时按 24px 轨算、且没有那个把手', () => {
    expect(availableForCenterAndRight(1280, true, 260)).toBe(1252);
  });
  it('不会回负数', () => {
    expect(availableForCenterAndRight(100, false, 260)).toBe(0);
  });
});

describe('rightPaneLayout 全屏', () => {
  it('全屏 → 中栏藏起来、右栏吃满可用宽度', () => {
    const l = rightPaneLayout(S({ browserOpen: true, browserFullscreen: true, availableWidth: 1012 }));
    expect(l).toEqual({ mode: 'browser', width: 1012, collapsed: false, centerHidden: true });
  });

  it('不全屏时 centerHidden 恒为假（浏览器开着、关着都是）', () => {
    expect(rightPaneLayout(S({ browserOpen: true })).centerHidden).toBe(false);
    expect(rightPaneLayout(S()).centerHidden).toBe(false);
  });

  /** 全屏是浏览器的事，不许把用户的 Inspector 收起状态掰了。 */
  it('全屏不改 inspectorCollapsed：关掉浏览器之后 Inspector 回原样', () => {
    const before = S({ inspectorCollapsed: true });
    rightPaneLayout({ ...before, browserOpen: true, browserFullscreen: true });
    expect(rightPaneLayout(before)).toEqual({
      mode: 'inspector', width: 280, collapsed: true, centerHidden: false,
    });
  });
});
