import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, findOneWhere, isElement, type MiniElement } from '../../../test-support/miniReact';

/**
 * **`BrowserSidebar` 的「组件那一半」。**
 *
 * `stage.ts` 的 `nextReport` 有 18 条用例，`useStageBounds` 里只剩「什么时候问」——
 * 而**那一半今天没人守**。评审实测两条变异三条 gate 全绿：
 *
 *  · `BrowserSidebar` 不调 `useStageBounds`（`:20`）→ 主进程永远收不到 bounds，
 *    侧栏里那块网页一直不可见，全程零错误；
 *  · `useStageBounds` 卸载时那次 `visible:false` 不发（`:73`）→ 关掉侧栏之后
 *    原生层还按最后一份几何盖在 Inspector 上。
 *
 * 这份用例**真的把组件挂载一遍**（miniReact：真调组件函数、按 React 的次序先挂 ref
 * 再跑 effect、卸载时跑清理函数），断言的是**真的发出去了什么 RPC** ——
 * `browser.syncView` 的每一个字段，包括那一次收尾的 `visible:false`。
 *
 * 守不住的是真实几何：`getBoundingClientRect()` 与 `setBounds` 到底对不对得齐，
 * 那要 Task 12 在真界面上量。这里的矩形是喂进去的。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// store 只是数据源：**只把 React 订阅那一层换成直读**，`getState` / `subscribe`
// 全用真身 —— `useStageBounds` 订阅的、读 epoch 的都是真的那个 store。
vi.mock('./browserStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./browserStore')>();
  const real = mod.useBrowserStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useBrowserStore: hook };
});

// 同一件事：`BrowserSidebar` 现在用 hook 形式读 `browserFullscreen`
// （`useUiStore((s) => s.browserFullscreen)`），真的 zustand hook 在这个
// 没有真 React 渲染器的环境里会摸到 null 的 dispatcher（`useCallback` 炸）。
vi.mock('../../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

const { BrowserSidebar } = await import('./BrowserSidebar');
const { TabStrip } = await import('./TabStrip');
const { UrlBar } = await import('./UrlBar');
const { useBrowserStore } = await import('./browserStore');
const { useConfirmStore } = await import('../../stores/confirmStore');
const { useUiStore } = await import('../../stores/uiStore');

type Call = { method: string; args: unknown };

const calls: Call[] = [];
const winListeners = new Map<string, Set<() => void>>();
/** 建出来的 ResizeObserver，用来手工触发一次「舞台尺寸变了」。 */
const observers: Array<{ cb: () => void; observed: unknown[]; disconnected: boolean }> = [];

const STAGE = { left: 100, top: 50, width: 400, height: 600 };
const BOUNDS = { x: 100, y: 50, width: 400, height: 600 };

function syncViews(): Array<Record<string, unknown>> {
  return calls.filter((c) => c.method === 'browser.syncView').map((c) => c.args as Record<string, unknown>);
}

beforeEach(() => {
  calls.length = 0;
  winListeners.clear();
  observers.length = 0;
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, args: unknown) => { calls.push({ method, args }); return Promise.resolve(undefined); },
    },
    addEventListener: (t: string, fn: () => void) => { (winListeners.get(t) ?? winListeners.set(t, new Set()).get(t)!).add(fn); },
    removeEventListener: (t: string, fn: () => void) => { winListeners.get(t)?.delete(fn); },
  };
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    private rec: { cb: () => void; observed: unknown[]; disconnected: boolean };
    constructor(cb: () => void) { this.rec = { cb, observed: [], disconnected: false }; observers.push(this.rec); }
    observe(el: unknown) { this.rec.observed.push(el); }
    disconnect() { this.rec.disconnected = true; }
  };
  useBrowserStore.setState(useBrowserStore.getInitialState());
  useConfirmStore.setState(useConfirmStore.getInitialState());
  // 全量复位，不能只 setState 一个字段 —— 新加的全屏/关闭那几条用例真的会
  // 翻 `browserFullscreen` / `browserOpen`，留着上一条用例的尾巴会互相污染。
  useUiStore.setState({ ...useUiStore.getInitialState(), browserOpen: true });
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
  delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
});

function tab(patch: Partial<{ id: string; url: string; title: string }> = {}) {
  return {
    id: 't1', url: 'https://example.org/', title: '',
    loading: false, owner: 'user' as const, canGoBack: false, canGoForward: false,
    viewportMode: 'fit' as const,
    ...patch,
  };
}

/** 把一棵 miniReact 元素树里所有的文本叶子拼起来，用来断言「这几个字不在 DOM 里」。 */
function collectText(node: unknown): string {
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (isElement(node)) return collectText(node.props?.children);
  return '';
}

/**
 * 从根走到某个 testId 节点的完整路径（含根、含目标节点自己）。
 * 用来断言「这个节点的祖先里有没有另一个 testId」——miniReact 本身不提供这个，
 * 只有按 testId 查单个节点的 `findByTestId` / `queryByTestId`。
 */
function pathToTestId(root: unknown, testId: string): MiniElement[] {
  const trail: MiniElement[] = [];
  function rec(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(rec);
    if (!isElement(node)) return false;
    trail.push(node);
    if (node.props['data-testid'] === testId || node.props.testId === testId) return true;
    if (rec(node.props?.children)) return true;
    trail.pop();
    return false;
  }
  if (!rec(root)) throw new Error(`miniReact: 这棵树上没有 testId="${testId}"`);
  return trail;
}

describe('BrowserSidebar：舞台几何真的报出去了', () => {
  it('挂上去就把舞台矩形报给主进程（拿到 epoch 之后）', () => {
    useBrowserStore.setState({ epoch: 5, revision: 1, tabs: [tab()], activeTabId: 't1' });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });

    expect(syncViews()).toEqual([{ epoch: 5, visible: true, occluded: false, bounds: BOUNDS }]);
    // 舞台那块 div 上真的挂了 ref，而且 ResizeObserver 盯的就是它。
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toHaveLength(1);
    expect((observers[0].observed[0] as { testId: string }).testId).toBe('browser-stage');
    m.unmount();
  });

  it('**对照组**：还没拿到 epoch 时一个字都不报（证明上面那条不是空绿）', () => {
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    expect(syncViews()).toEqual([]);
    m.unmount();
  });

  it('卸载时补报一次 visible:false，用的是最后那一份真几何', () => {
    useBrowserStore.setState({ epoch: 5, revision: 1, tabs: [tab()], activeTabId: 't1' });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    m.unmount();

    const reports = syncViews();
    expect(reports).toHaveLength(2);
    // **不是零矩形**：零宽会把这个标签的逻辑视口毁掉（stage.ts 那条注释）。
    expect(reports[1]).toEqual({ epoch: 5, visible: false, occluded: false, bounds: BOUNDS });
    // 顺带钉住清理：RO 断开、window 上的 resize 监听摘掉。
    expect(observers[0].disconnected).toBe(true);
    expect(winListeners.get('resize')?.size ?? 0).toBe(0);
  });

  it('确认框弹出来 → occluded 跟着报上去（单一订阅点接着 confirmStore）', () => {
    useBrowserStore.setState({ epoch: 5, revision: 1, tabs: [tab()], activeTabId: 't1' });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    calls.length = 0;

    useConfirmStore.getState().open({
      id: 1, title: '随便什么确认框', resolve: () => {},
    });

    expect(syncViews()).toEqual([{ epoch: 5, visible: true, occluded: true, bounds: BOUNDS }]);
    m.unmount();
  });
});

describe('BrowserSidebar：横幅与关标签的接线', () => {
  it('用户眼前这一页正被驱动 → 横幅出来，说得出动作名', () => {
    useBrowserStore.setState({
      epoch: 5, revision: 1, tabs: [tab()], activeTabId: 't1',
      agentTabs: new Map([['t1', '操作网页']]),
    });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    const banner = m.find('browser-agent-banner');
    expect(JSON.stringify(banner.props.children)).toContain('操作网页');
    m.unmount();
  });

  it('被驱动的是后台标签 → 横幅不出（那一个归标签条的指示灯管）', () => {
    useBrowserStore.setState({
      epoch: 5, revision: 1, tabs: [tab(), tab({ id: 't2' })], activeTabId: 't1',
      agentTabs: new Map([['t2', null]]),
    });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    expect(m.query('browser-agent-banner')).toBeNull();
    m.unmount();
  });

  it('「1:1 / 适配」开关按下去，RPC 带的是当前活动标签的 id', () => {
    useBrowserStore.setState({
      epoch: 5, revision: 1, tabs: [tab(), tab({ id: 't2' })], activeTabId: 't2',
    });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    const bar = findOneWhere(m.tree, (el) => el.type === UrlBar);
    expect(bar.props.tab).toMatchObject({ id: 't2' });
    (bar.props.onViewportMode as (mode: string) => void)('oneToOne');

    expect(calls.filter((c) => c.method === 'browser.setViewportMode')).toEqual([
      { method: 'browser.setViewportMode', args: { tabId: 't2', mode: 'oneToOne' } },
    ]);
    m.unmount();
  });

  it('关一个空闲标签：直接关，不弹确认框', () => {
    useBrowserStore.setState({ epoch: 5, revision: 1, tabs: [tab()], activeTabId: 't1' });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    const strip = findOneWhere(m.tree, (el) => el.type === TabStrip);
    (strip.props.onClose as (id: string) => void)('t1');

    expect(calls.filter((c) => c.method === 'browser.close')).toEqual([
      { method: 'browser.close', args: { tabId: 't1' } },
    ]);
    expect(useConfirmStore.getState().request).toBeNull();
    m.unmount();
  });

  it('关一个正被 agent 驱动的标签：先弹确认框，答「否」就不关', async () => {
    useBrowserStore.setState({
      epoch: 5, revision: 1, tabs: [tab()], activeTabId: 't1',
      agentTabs: new Map([['t1', '操作网页']]),
    });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    (findOneWhere(m.tree, (el) => el.type === TabStrip).props.onClose as (id: string) => void)('t1');

    const req = useConfirmStore.getState().request;
    expect(req).not.toBeNull();
    expect(calls.some((c) => c.method === 'browser.close')).toBe(false);

    useConfirmStore.getState().resolve(false);
    await m.settle();
    expect(calls.some((c) => c.method === 'browser.close')).toBe(false);
    m.unmount();
  });
});

/**
 * **顶部结构（Task 4）**：删标题行，标签条升顶，三个按钮固定在它右端。
 *
 * 这一组守的都是接线，不是排版本身（排版是下面 TabStrip 那组的事）：标题字样
 * 真的没了、`+` 走的是 `browser.newTab` 不是 `browser.open`、全屏/关闭两个按钮
 * 分别接的是 `toggleBrowserFullscreen` / `closeBrowser`、舞台提示的判据真的从
 * 「一个标签都没有」挪到了「当前标签没有网址」。
 */
describe('BrowserSidebar：顶部结构（Task 4）', () => {
  it('顶部没有标题行了：「浏览器 Browser」那几个字不在 DOM 里', () => {
    useBrowserStore.setState({ epoch: 5, revision: 1, tabs: [tab()], activeTabId: 't1' });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    expect(collectText(m.tree)).not.toContain('浏览器 Browser');
    m.unmount();
  });

  it('点 + 走的是 browser.newTab，不是 browser.open', () => {
    useBrowserStore.setState({ epoch: 5, revision: 1, tabs: [tab()], activeTabId: 't1' });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    const strip = findOneWhere(m.tree, (el) => el.type === TabStrip);
    (strip.props.onNewTab as () => void)();

    expect(calls.filter((c) => c.method === 'browser.newTab')).toEqual([
      { method: 'browser.newTab', args: undefined },
    ]);
    expect(calls.some((c) => c.method === 'browser.open')).toBe(false);
    m.unmount();
  });

  it('点全屏调 toggleBrowserFullscreen；点关闭调 closeBrowser', () => {
    useBrowserStore.setState({ epoch: 5, revision: 1, tabs: [tab()], activeTabId: 't1' });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    const strip = findOneWhere(m.tree, (el) => el.type === TabStrip);

    expect(strip.props.fullscreen).toBe(false);
    expect(useUiStore.getState().browserFullscreen).toBe(false);
    (strip.props.onToggleFullscreen as () => void)();
    expect(useUiStore.getState().browserFullscreen).toBe(true);

    expect(useUiStore.getState().browserOpen).toBe(true);
    (strip.props.onClosePane as () => void)();
    expect(useUiStore.getState().browserOpen).toBe(false);
    m.unmount();
  });

  it('当前标签没有网址时，舞台上仍然显示那句提示', () => {
    // tabs.length === 1（不是「一个标签都没有」）——判据必须挂在
    // 「当前标签没有网址」上，不能是旧的 tabs.length === 0。
    useBrowserStore.setState({ epoch: 5, revision: 1, tabs: [tab({ url: '' })], activeTabId: 't1' });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    expect(collectText(m.find('browser-stage'))).toContain('在上面的地址栏输入一个网址');
    m.unmount();
  });
});

/**
 * **TabStrip：三个按钮在滚动容器外面**（Task 4，见组件里那条 docblock）。
 *
 * 这条守的是一个静默失效：`TabStrip` 原本整条 `overflow-x-auto`，三个按钮放进
 * 滚动容器**里面**的话，标签一多就跟着横向滚出可视区——现象是「标签开到第五个
 * 之后关不掉侧栏」，三条 gate 一条都不红。断言的是**祖先关系**，不是「按钮存在」：
 * 从每个按钮往上走到 `TabStrip` 根节点的路径上，不能出现 `browser-tabscroll` 那层。
 */
describe('TabStrip：三个按钮在滚动容器外面（Task 4）', () => {
  it('8 个标签时，new-tab / fullscreen / close-pane 三个节点的祖先里没有 browser-tabscroll', () => {
    const tabs = Array.from({ length: 8 }, (_, i) => tab({ id: `t${i}` }));
    const m = mount(TabStrip, {
      tabs, activeTabId: 't0', agentTabs: new Map(),
      onSelect: () => {}, onClose: () => {}, onKeep: () => {},
      fullscreen: false, onNewTab: () => {}, onToggleFullscreen: () => {}, onClosePane: () => {},
    });

    // 先确认滚动容器真的在树上——否则下面「路径里没有它」这句断言对「它压根
    // 就没被渲染」这种坏法也会成立，等于没守住任何东西。
    expect(m.query('browser-tabscroll')).not.toBeNull();

    for (const id of ['browser-new-tab', 'browser-fullscreen', 'browser-close-pane']) {
      const path = pathToTestId(m.tree, id);
      expect(path.some((el) => el.props['data-testid'] === 'browser-tabscroll')).toBe(false);
    }
    m.unmount();
  });
});

/**
 * **`onGo` 的 tabId 路由（Task 4 修复轮 R1）**。
 *
 * `UrlBar` 的 `onGo` 签名从 `(url, newTab)` 收成 `(url)` 之后，「有活动标签就带
 * `tabId`、没有就不带」这条判断全挪到了 `BrowserSidebar` 传给 `UrlBar` 的那个
 * 闭包里（`:66-68`），而这段路由本身**没有任何用例守着**——评审实测把它退化成
 * 恒不带 `tabId`（即恒 `{ url }`），全量仍然全绿。
 *
 * 两条缺一不可：只有「有活动标签」那条，「恒带 tabId」的退化也会绿；只有
 * 「没有标签」那条，「恒不带」的退化也会绿。第二条特意用 `hasOwnProperty`
 * 断「这个键不存在」，不是断「值是 undefined」——否则 `{ url, tabId:
 * active?.id }` 这种没有活动标签时把 `tabId` 显式设成 `undefined`、但键还在
 * 的退化会被 `toEqual` 之类的宽松比较放过（`toEqual` 视 `{a: undefined}` 与
 * `{}` 相等，但键存不存在是这条要守的东西）。
 */
describe('BrowserSidebar：onGo 的 tabId 路由（Task 4 修复轮 R1）', () => {
  it('有活动标签时，地址栏提交的网址：browser.open 带 tabId，等于活动标签的 id', () => {
    // 活动标签必须**不是** tabs 数组的最后一个——否则「取 active（按 activeTabId
    // 查到的那个标签对象）的 id」和「退化成取数组最后一个的 id」这两种写法在这份
    // fixture 下会给出同一个值，这条断言就分不清代码走的是哪一种（复审实测踩过：
    // 把实现悄悄换成 `tabs[tabs.length - 1] ?? null`，这里原本全绿）。这里复用的是
    // 本文件已有的同形态 fixture（见上面「被驱动的是后台标签」那条：
    // `tabs: [tab(), tab({ id: 't2' })], activeTabId: 't1'`）。整理 fixture 时别把
    // 顺序「理顺」成 activeTabId 又指回最后一个，那样会悄悄退回只剩一个为真的原因。
    useBrowserStore.setState({
      epoch: 5, revision: 1, tabs: [tab(), tab({ id: 't2' })], activeTabId: 't1',
    });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    const bar = findOneWhere(m.tree, (el) => el.type === UrlBar);
    (bar.props.onGo as (url: string) => void)('https://example.com/');

    const opens = calls.filter((c) => c.method === 'browser.open');
    expect(opens).toHaveLength(1);
    const args = opens[0].args as Record<string, unknown>;
    expect(args.url).toBe('https://example.com/');
    expect(args.tabId).toBe('t1');
    m.unmount();
  });

  it('一个标签都没有时，地址栏提交的网址：browser.open 的参数里没有 tabId 这个键', () => {
    useBrowserStore.setState({ epoch: 5, revision: 1, tabs: [], activeTabId: null });
    const m = mount(BrowserSidebar, {}, { rects: { 'browser-stage': STAGE } });
    const bar = findOneWhere(m.tree, (el) => el.type === UrlBar);
    (bar.props.onGo as (url: string) => void)('https://example.com/');

    const opens = calls.filter((c) => c.method === 'browser.open');
    expect(opens).toHaveLength(1);
    const args = opens[0].args as Record<string, unknown>;
    expect(args.url).toBe('https://example.com/');
    expect(Object.prototype.hasOwnProperty.call(args, 'tabId')).toBe(false);
    m.unmount();
  });
});
