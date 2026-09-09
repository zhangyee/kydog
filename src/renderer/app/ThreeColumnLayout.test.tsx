import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllByProp } from '../../test-support/miniReact';

/**
 * **`ThreeColumnLayout` 的「组件那一半」。**
 *
 * `rightPane.ts` 里那个判断有 22 条用例守着，但**读它的那一半没有**：评审实测两条变异
 * 三条 gate 全绿 ——
 *
 *  · 把 `right.mode === 'browser' ? browser : inspector` 挂反（右栏渲染出来的是
 *    另一个面板，浏览器侧栏彻底看不见）；
 *  · 排版那一行用 `insWidth` 而不是 `right.width`（「浏览器开着却按 Inspector 的
 *    宽度排版」—— 正是 `rightPane.ts` 文件头声称已经防住的那个状态）。
 *
 * 所以这份用例**真的把组件调用一遍**，断言它返回的那棵树：右栏挂的是哪一个节点
 * （按身份比，不是按类型名）、排版用的是哪一份宽度。`rightPaneLayout` 是真身，
 * 只有 store 那一层换成直读（见下面的 mock）—— 被守的是组件的接线，不是 zustand。
 *
 * 守不住的仍然是真实布局：grid 到底把网页排到哪几个像素上，那要 e2e。
 */

// store 只是数据源。**把 React 订阅那一层换成直读**，其余（getState / setState /
// subscribe）用真身 —— 这样 `useUiStore.setState()` 摆的状态组件立刻读得到，
// 而被测的东西（组件 → rightPaneLayout → 树）一个字都没被替身掉。
vi.mock('../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

const { ThreeColumnLayout } = await import('./ThreeColumnLayout');
const { useUiStore } = await import('../stores/uiStore');

const INSPECTOR = <div data-testid="pane-inspector" />;
const BROWSER = <div data-testid="pane-browser" />;

const props = { left: <div />, center: <div />, inspector: INSPECTOR, browser: BROWSER };

/** 右栏那块 `<aside>`。`data-pane` 是它自己写上去的，所以顺带也钉住了那个属性。 */
function rightAside(tree: unknown) {
  const hits = [
    ...findAllByProp(tree, 'data-pane', 'browser'),
    ...findAllByProp(tree, 'data-pane', 'inspector'),
  ];
  expect(hits).toHaveLength(1);
  return hits[0];
}

/** `gridTemplateColumns` 的第五轨 = 右栏的宽度。 */
function rightTrack(tree: unknown): string {
  const cols = (tree as { props: { style: { gridTemplateColumns: string } } }).props.style.gridTemplateColumns;
  return cols.split(' ')[4];
}

function handleTrack(tree: unknown): string {
  const cols = (tree as { props: { style: { gridTemplateColumns: string } } }).props.style.gridTemplateColumns;
  return cols.split(' ')[3];
}

beforeEach(() => {
  // 三个宽度**刻意互不相等**：相等的话「用错哪一份」这条断言就永远绿。
  useUiStore.setState({
    workspaceCollapsed: false,
    inspectorCollapsed: false,
    workspaceWidth: 261,
    inspectorWidth: 333,
    browserOpen: false,
    browserWidth: 505,
  });
});

describe('ThreeColumnLayout：右栏挂哪个节点、按哪一份宽度排版', () => {
  it('浏览器开着 → 右栏挂的就是传进来的那个 browser 节点', () => {
    useUiStore.setState({ browserOpen: true });
    const m = mount(ThreeColumnLayout, props);
    const aside = rightAside(m.tree);
    expect(aside.props['data-pane']).toBe('browser');
    // **按身份比**：比 `type` 的话，两个占位都是 div，挂反了照样绿。
    expect(aside.props.children).toBe(BROWSER);
    expect(aside.props.children).not.toBe(INSPECTOR);
  });

  it('浏览器关着 → 右栏挂的是 inspector 节点', () => {
    const m = mount(ThreeColumnLayout, props);
    const aside = rightAside(m.tree);
    expect(aside.props['data-pane']).toBe('inspector');
    expect(aside.props.children).toBe(INSPECTOR);
    expect(aside.props.children).not.toBe(BROWSER);
  });

  it('浏览器开着 → 排版用的是 browserWidth，不是 inspectorWidth', () => {
    useUiStore.setState({ browserOpen: true });
    expect(rightTrack(mount(ThreeColumnLayout, props).tree)).toBe('505px');
  });

  it('浏览器关着 → 排版用的是 inspectorWidth', () => {
    expect(rightTrack(mount(ThreeColumnLayout, props).tree)).toBe('333px');
  });

  it('Inspector 收着但浏览器开着 → 右栏照样展开（不跟着 inspectorCollapsed 收）', () => {
    useUiStore.setState({ browserOpen: true, inspectorCollapsed: true });
    const m = mount(ThreeColumnLayout, props);
    expect(rightTrack(m.tree)).toBe('505px');
    expect(handleTrack(m.tree)).toBe('4px');
    expect(rightAside(m.tree).props['data-pane']).toBe('browser');
  });

  it('Inspector 收着且浏览器关着 → 收成竖轨，分栏手柄没了', () => {
    useUiStore.setState({ inspectorCollapsed: true });
    const m = mount(ThreeColumnLayout, props);
    expect(rightTrack(m.tree)).toBe('24px');
    expect(handleTrack(m.tree)).toBe('0px');
  });

  it('拖右边那条手柄时，写的是当前占用者自己的宽度', () => {
    useUiStore.setState({ browserOpen: true });
    const m = mount(ThreeColumnLayout, props);
    const handle = findAllByProp(m.tree, 'side', 'right')[0];
    (handle.props.setWidth as (w: number) => void)(480);
    expect(useUiStore.getState().browserWidth).toBe(480);
    expect(useUiStore.getState().inspectorWidth).toBe(333);

    useUiStore.setState({ browserOpen: false });
    const m2 = mount(ThreeColumnLayout, props);
    (findAllByProp(m2.tree, 'side', 'right')[0].props.setWidth as (w: number) => void)(410);
    expect(useUiStore.getState().inspectorWidth).toBe(410);
    expect(useUiStore.getState().browserWidth).toBe(480);
  });
});
