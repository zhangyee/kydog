import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, findOneWhere } from '../../../test-support/miniReact';

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

const { BrowserSidebar } = await import('./BrowserSidebar');
const { TabStrip } = await import('./TabStrip');
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
  useUiStore.setState({ browserOpen: true });
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
  delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
});

function tab(patch: Partial<{ id: string; url: string; title: string }> = {}) {
  return {
    id: 't1', url: 'https://example.org/', title: '',
    loading: false, owner: 'user' as const, canGoBack: false, canGoForward: false,
    ...patch,
  };
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
