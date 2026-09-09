import { describe, it, expect } from 'vitest';
import { rightPaneLayout, type RightPaneState } from './rightPane';

const S = (p: Partial<RightPaneState> = {}): RightPaneState => ({
  browserOpen: false, browserWidth: 560, inspectorCollapsed: false, inspectorWidth: 280, ...p,
});

describe('rightPaneLayout', () => {
  it('浏览器关着 → Inspector，用它自己的宽度与收起状态', () => {
    expect(rightPaneLayout(S())).toEqual({ mode: 'inspector', width: 280, collapsed: false });
    expect(rightPaneLayout(S({ inspectorCollapsed: true })))
      .toEqual({ mode: 'inspector', width: 280, collapsed: true });
  });

  /**
   * 第二轮变异 N12 是从这里活下来的：`rightWidth` 改成恒取 `insWidth` 时三条 gate 全绿，
   * 现象是拖宽浏览器侧栏，DOM 那一栏跟着变而原生网页停在旧宽度上（或者反过来）。
   */
  it('浏览器开着 → 用浏览器自己的宽度，不是 Inspector 的', () => {
    const l = rightPaneLayout(S({ browserOpen: true, browserWidth: 700, inspectorWidth: 280 }));
    expect(l.mode).toBe('browser');
    expect(l.width).toBe(700);
  });

  it('浏览器开着时右栏一定是展开的，哪怕 Inspector 记着「收起」', () => {
    expect(rightPaneLayout(S({ browserOpen: true, inspectorCollapsed: true })).collapsed).toBe(false);
  });

  it('关掉浏览器之后 Inspector 回到用户上次留下的样子（收起状态没被掰过）', () => {
    const before = S({ inspectorCollapsed: true });
    rightPaneLayout({ ...before, browserOpen: true });
    expect(rightPaneLayout(before)).toEqual({ mode: 'inspector', width: 280, collapsed: true });
  });

  it('两份宽度互不冒充：两个数不一样时各归各的', () => {
    const s = S({ browserWidth: 700, inspectorWidth: 280 });
    expect(rightPaneLayout({ ...s, browserOpen: true }).width).toBe(700);
    expect(rightPaneLayout({ ...s, browserOpen: false }).width).toBe(280);
  });
});
