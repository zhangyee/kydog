import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BootstrapState, SettingsFileForRenderer } from '../shared/types';
import { bootstrap } from './bootstrap';
import { useSettingsStore } from './stores/settingsStore';
import { useBrowserStore } from './panels/browser/browserStore';
import { useUiStore } from './stores/uiStore';

/**
 * **`bootstrap.ts` 里那一行浏览器接线的守卫。**
 *
 * 评审 I-1：把 `installBrowserBridge(window.kydog, useBrowserStore.getState())` 删掉
 * （或者换成不接线的形式），`tsc` / `lint` / `npm test` **三条全绿** —— 而产品行为是
 * **整个浏览器侧栏彻底死掉**：镜像永远是空的、epoch 永远是 `NO_EPOCH`、
 * 于是 `useStageBounds` 报的每一次 `syncView` 都被主进程判为过期，
 * 侧栏里那块网页永远不可见，全程零错误零警告。
 * `browserBridge.test.ts`（9 条）守的是「接哪两条、什么顺序」，守不了「bootstrap
 * 到底有没有调它」。
 *
 * 这是主进程 `main.ts` 那条的同型问题，解法也照那边：**真的把 bootstrap 跑一遍**，
 * 替身掉的只有 `window.kydog` 这一个出口，`browserBridge` 与 `browserStore` 都是真身。
 * 断言的是**装配之后可观测的副作用** ——
 *
 *  1. `browser.getState` 真的被调了，而且它的返回值真的进了 store（**epoch 只从这里来**）；
 *  2. 两条广播真的接上了：把一帧 `browser.tabsChanged` / `browser.agentFocus` 打进
 *     记下来的监听器，store 真的跟着变；
 *  3. 顺序：两条订阅都排在 `browser.getState` **之前**。
 *
 * 删掉那一行调用，这三条各自红。
 */

const SETTINGS: SettingsFileForRenderer = {
  schemaVersion: 9,
  ui: {
    theme: 'vellum',
    locale: 'zh',
    workspaceCollapsed: false,
    inspectorCollapsed: false,
    readingFontSize: 'medium',
    collapsedProjects: [],
    browserOpen: true,
    browserWidth: 520,
  },
  llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: 'anthropic', defaultModel: 'x' },
  skills: { disabledBuiltins: [] },
  tools: { externalBins: [] },
  research: { presets: {}, custom: [] },
  institution: null,
  updates: { autoCheck: true, dismissedCandidateId: null },
  telemetry: { state: 'undecided', decidedAt: null },
  onboarding: { completedAt: '2026-09-01T00:00:00.000Z' },
};

const BOOT: BootstrapState = {
  projects: [],
  threads: [],
  settings: SETTINGS,
  settingsHealth: { kind: 'ok' },
  appVersion: '0.0.0-test',
  systemLocale: 'zh',
  identity: { userName: '我', agentName: 'KyDog' },
  onboardingRecovery: 'none',
  viewState: null,
};

/** 主进程手上那份浏览器状态。**epoch 只从 `browser.getState` 来**（广播里刻意不带）。 */
const STATE = {
  revision: 7,
  epoch: 3,
  activeTabId: 't1',
  tabs: [{
    id: 't1', url: 'https://example.org/', title: '例子',
    loading: false, owner: 'user' as const, canGoBack: false, canGoForward: false,
    viewportMode: 'fit' as const,
  }],
};

type Listener = (payload: unknown) => void;

/** 按发生次序记下来的「装配轨迹」：`on:<topic>` 与 `invoke:<method>`。 */
let trace: string[] = [];
let listeners: Map<string, Listener[]>;
/** `window.addEventListener` 装的监听器，按事件名分桶 —— resize 那条就走这里，
 *  与上面 `window.kydog.on` 的 `listeners`（IPC 广播）是两回事，不能共用一份。 */
let windowListeners: Map<string, Array<() => void>>;

function fire(topic: string, payload: unknown): void {
  const fns = listeners.get(topic) ?? [];
  if (fns.length === 0) throw new Error(`没有人订阅 ${topic}`);
  for (const fn of fns) fn(payload);
}

beforeEach(() => {
  trace = [];
  listeners = new Map();
  windowListeners = new Map();
  useBrowserStore.setState(useBrowserStore.getInitialState());
  const replies: Record<string, unknown> = {
    'app.bootstrap': BOOT,
    'browser.getState': STATE,
    'llm.list': { catalog: [], configured: [], customProviders: [], defaultProvider: null, defaultModel: null },
    'update.getStatus': { check: { state: 'idle' }, update: { state: 'none' }, bannerDismissed: false, autoCheck: true, currentVersion: '0.0.0-test' },
    'skill.list': [],
    'skill.getSyncHealth': { state: 'ok', installedOrUpgraded: [], userSkills: [] },
    'settings.update': SETTINGS,
    'viewState.save': undefined,
  };
  (globalThis as unknown as { window: unknown }).window = {
    // bootstrap.ts 拿它初始化 uiStore.windowWidth（见 syncWindowWidth）。
    innerWidth: 1280,
    kydog: {
      invoke: (method: string) => {
        trace.push(`invoke:${method}`);
        return Promise.resolve(replies[method]);
      },
      on: (topic: string, fn: Listener) => {
        trace.push(`on:${topic}`);
        const arr = listeners.get(topic) ?? [];
        arr.push(fn);
        listeners.set(topic, arr);
        return () => { listeners.set(topic, (listeners.get(topic) ?? []).filter((f) => f !== fn)); };
      },
    },
    addEventListener: (event: string, fn: () => void) => {
      const arr = windowListeners.get(event) ?? [];
      arr.push(fn);
      windowListeners.set(event, arr);
    },
  };
});

afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).window; });

describe('bootstrap 把 settingsHealth 接进了 store', () => {
  /**
   * 设置页那条横幅唯一的数据源。这一段是**运行时填表**（`setBootstrapMeta` 里逐字段抄），
   * 漏抄一个字段不会编译报错、也不会有别的用例红 —— 横幅从此永远不显示，
   * 而它要说的正是「你的设置和凭据出事了」。
   */
  it('bootstrap 之后 store 里就是主进程给的那一档', async () => {
    BOOT.settingsHealth = { kind: 'quarantined', backup: 'kydog.json.unreadable-X' };
    await bootstrap();
    expect(useSettingsStore.getState().settingsHealth)
      .toEqual({ kind: 'quarantined', backup: 'kydog.json.unreadable-X' });
    BOOT.settingsHealth = { kind: 'ok' };
  });
});

describe('bootstrap 真的把浏览器侧栏接上了', () => {
  it('走了一次 browser.getState，epoch 与标签清单都进了 store', async () => {
    await bootstrap();
    // getState 是 fire-and-forget 的，等一拍让它落地。
    await new Promise<void>((r) => { setTimeout(r, 0); });

    expect(trace.filter((t) => t === 'invoke:browser.getState')).toHaveLength(1);
    const s = useBrowserStore.getState();
    expect(s.epoch).toBe(3);
    expect(s.revision).toBe(7);
    expect(s.tabs.map((t) => t.id)).toEqual(['t1']);
    expect(s.activeTabId).toBe('t1');
  });

  it('两条广播真的接上了：打一帧进去，镜像跟着变', async () => {
    await bootstrap();
    await new Promise<void>((r) => { setTimeout(r, 0); });

    fire('browser.tabsChanged', {
      revision: 8,
      activeTabId: 't2',
      tabs: [{ ...STATE.tabs[0], id: 't2', title: '换了一帧' }],
    });
    expect(useBrowserStore.getState().tabs.map((t) => t.id)).toEqual(['t2']);
    // 广播里没有 epoch，也不许碰它。
    expect(useBrowserStore.getState().epoch).toBe(3);

    fire('browser.agentFocus', { tabId: 't2', active: true, action: '操作网页' });
    expect(useBrowserStore.getState().agentTabs.get('t2')).toBe('操作网页');

    fire('browser.agentFocus', { tabId: 't2', active: false });
    expect(useBrowserStore.getState().agentTabs.has('t2')).toBe(false);
  });

  it('恢复协议的顺序：两条订阅都排在 browser.getState 之前', async () => {
    await bootstrap();
    const getState = trace.indexOf('invoke:browser.getState');
    expect(getState).toBeGreaterThan(-1);
    expect(trace.indexOf('on:browser.tabsChanged')).toBeGreaterThan(-1);
    expect(trace.indexOf('on:browser.tabsChanged')).toBeLessThan(getState);
    expect(trace.indexOf('on:browser.agentFocus')).toBeLessThan(getState);
  });
});

describe('bootstrap 装了窗口宽度的 resize 监听', () => {
  /**
   * `ThreeColumnLayout` 排版要用的 `windowWidth` 只能来自这里：组件那层跑在
   * `environment: 'node'` 的用例里，没有 `window` 也没有 `ResizeObserver`，
   * 量不了。守住「装没装、装完能不能用」，不是只守「调用过 addEventListener」——
   * 后者哪怕监听器什么都不做也会绿。
   */
  it('启动时用 window.innerWidth 初始化，resize 后监听器真的把新宽度写回 store', async () => {
    await bootstrap();
    expect(useUiStore.getState().windowWidth).toBe(1280);

    (globalThis as unknown as { window: { innerWidth: number } }).window.innerWidth = 900;
    const fns = windowListeners.get('resize') ?? [];
    expect(fns.length).toBeGreaterThan(0);
    for (const fn of fns) fn();
    expect(useUiStore.getState().windowWidth).toBe(900);
  });
});

describe('browserFullscreen 不落盘', () => {
  /**
   * 全屏按设计**不落盘**（见 uiStore.ts 与 bootstrap.ts 的注释）：落了盘，退出时
   * 停在全屏、下次开应用看不见对话，用户会以为坏了。这条不是断「订阅里没写这个
   * 字段」（读源码就知道），而是断**可观测的行为**——改 browserFullscreen 一次，
   * 一次 `settings.update` 都不该多出来。持久化订阅比较的字段集合里但凡漏加了
   * browserFullscreen 三个字都不会让它红，加了才会。
   */
  it('改 browserFullscreen 不触发 settings.update', async () => {
    await bootstrap();
    await new Promise<void>((r) => { setTimeout(r, 0); });
    const before = trace.filter((t) => t === 'invoke:settings.update').length;

    useUiStore.getState().toggleBrowserFullscreen();
    await new Promise<void>((r) => { setTimeout(r, 0); });

    expect(trace.filter((t) => t === 'invoke:settings.update').length).toBe(before);
  });
});
