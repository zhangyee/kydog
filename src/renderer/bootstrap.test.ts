import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BootstrapState, SettingsFileForRenderer, Thread, UpdateStatus } from '../shared/types';
import { bootstrap } from './bootstrap';
import { useSettingsStore } from './stores/settingsStore';
import { useThreadsStore } from './stores/threadsStore';
import { useBrowserStore } from './panels/browser/browserStore';
import { useUiStore } from './stores/uiStore';
import { useUpdateStore, shouldShowBanner } from './stores/updateStore';

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

/** `update.getStatus` 的回复：没有可用更新。形状必须是真的 `UpdateStatus` ——
 *  `shouldShowBanner` 判的是 `update.kind`，形状不对时它读到 undefined，会把「没有更新」判成要挂横幅。 */
const UPDATE_IDLE: UpdateStatus = {
  check: { phase: 'never' },
  update: { kind: 'none' },
  bannerDismissed: false,
  autoCheck: true,
  currentVersion: '0.0.0-test',
};

type Listener = (payload: unknown) => void;

/** 按发生次序记下来的「装配轨迹」：`on:<topic>` 与 `invoke:<method>`。 */
let trace: string[] = [];
/** 每一次 invoke 连同参数。`trace` 只记方法名，看负载要从这里取。 */
let calls: Array<{ method: string; args: unknown }> = [];
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
  calls = [];
  listeners = new Map();
  windowListeners = new Map();
  useBrowserStore.setState(useBrowserStore.getInitialState());
  const replies: Record<string, unknown> = {
    'app.bootstrap': BOOT,
    'browser.getState': STATE,
    'llm.list': { catalog: [], configured: [], customProviders: [], defaultProvider: null, defaultModel: null },
    'update.getStatus': UPDATE_IDLE,
    'skill.list': [],
    'skill.getSyncHealth': { state: 'ok', installedOrUpgraded: [], userSkills: [] },
    'settings.update': SETTINGS,
    'viewState.save': undefined,
  };
  (globalThis as unknown as { window: unknown }).window = {
    // bootstrap.ts 拿它初始化 uiStore.windowWidth（见 syncWindowWidth）。
    // **刻意不等于 uiStore 里 windowWidth 的默认值（1280）**：评审 I-2 实测，两个数撞在一起时，
    // 下面那条「初始化」断言删掉 bootstrap.ts 里的 syncWindowWidth() 调用也照样绿——
    // 断的其实是 store 的默认值，不是同步这件事本身。
    innerWidth: 1600,
    kydog: {
      invoke: (method: string, args?: unknown) => {
        trace.push(`invoke:${method}`);
        calls.push({ method, args });
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
    expect(useUiStore.getState().windowWidth).toBe(1600);

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

describe('restoreViewState 的「已知 thread」集合滤掉已归档的', () => {
  /**
   * 回归：bootstrap 直接从 `state.threads` 建 `knownThreadIds` 给 `restoreViewState`，
   * 那份列表是主进程给的原始全集，包含已归档的——threadsStore.hydrate 的桶已经把归档的
   * 挡在外面了（唯一过滤点，见 threadsStore.ts 顶部注释），但 `knownThreadIds` 是第二个
   * 读 `state.threads` 的地方，漏了同一条规则的话，viewState 记着的 thread 恰好是刚被
   * 归档的那个时，重启会把一个左栏里根本看不见的会话选中。
   */
  it('viewState 指向的 thread 已归档就不选它；没归档的同一批里正常选中', async () => {
    const origThreads = BOOT.threads;
    const origViewState = BOOT.viewState;
    const archived: Thread = {
      id: 'thr-archived', projectPath: '/p', title: '已归档',
      createdAt: '2026-09-01T00:00:00Z', lastActiveAt: '2026-09-01T00:00:00Z',
      archivedAt: '2026-09-02T00:00:00Z',
    };
    const alive: Thread = {
      id: 'thr-alive', projectPath: '/p', title: '还在',
      createdAt: '2026-09-01T00:00:00Z', lastActiveAt: '2026-09-01T00:00:00Z',
    };
    BOOT.threads = [archived, alive];
    try {
      BOOT.viewState = { threadId: 'thr-archived', filePaths: [], activeFilePath: null, activeTab: 'thread' };
      await bootstrap();
      expect(useThreadsStore.getState().currentThreadId).toBeNull();

      // 正向对照，同一批线程里：换成指向没被归档的那个，正常选中——证明上面的 null
      // 不是 knownThreadIds 整个传丢了、或者随便指哪个都选不中。
      BOOT.viewState = { threadId: 'thr-alive', filePaths: [], activeFilePath: null, activeTab: 'thread' };
      await bootstrap();
      expect(useThreadsStore.getState().currentThreadId).toBe('thr-alive');
    } finally {
      BOOT.threads = origThreads;
      BOOT.viewState = origViewState;
    }
  });
});

/** 一拍宏任务：订阅里的 `settings.update` 与启动时那几次 invoke 都是 fire-and-forget。 */
const settle = () => new Promise<void>((r) => { setTimeout(r, 0); });

/** 从某一刻起发出去的全部 `settings.update` 负载。 */
function settingsUpdatesSince(from: number): Array<{ ui: Record<string, unknown> }> {
  return calls.slice(from)
    .filter((c) => c.method === 'settings.update')
    .map((c) => c.args as { ui: Record<string, unknown> });
}

describe('改主题时 settings.update 不捎带 locale', () => {
  /**
   * 回归：bootstrap 的持久化订阅曾把 `locale: 'zh'` 硬编码进 ui 负载，en 用户改一次主题，
   * 重启就被打回中文。locale 只走 `locale.set`（它还要换 skill 树），这条订阅一个字都不该碰它 ——
   * 主进程那边按 `{ ...cur.ui, ...patch.ui }` 合并，负载里没有这个键，盘上的 locale 就原样留着。
   *
   * 断的是**键不在**，而不是「值等于 en」：透传启动时读到的值也不对（与菜单里切语言那条路赛跑）。
   */
  it('负载里带着新主题（找到的就是这一次），但没有 locale 这个键', async () => {
    await bootstrap();
    await settle();
    const from = calls.length;

    useUiStore.getState().setTheme('midnight');
    await settle();

    const sent = settingsUpdatesSince(from);
    expect(sent.length).toBeGreaterThan(0);
    for (const args of sent) {
      // 正向：这份负载确实是改主题发出去的那一份，查找本身没坏
      expect(args.ui.theme).toBe('midnight');
      expect(args.ui).not.toHaveProperty('locale');
    }
  });

  it('重启那一半：settings 里的主题在启动时进了 uiStore', async () => {
    // 刻意不等于 uiStore 的默认主题（vellum）与 SETTINGS 里那份（也是 vellum）
    useUiStore.setState({ theme: 'vellum' });
    const orig = BOOT.settings;
    BOOT.settings = { ...SETTINGS, ui: { ...SETTINGS.ui, theme: 'midnight' } };
    try {
      await bootstrap();
    } finally {
      BOOT.settings = orig;
    }
    expect(useUiStore.getState().theme).toBe('midnight');
  });
});

describe('阅读字号跨重启保留', () => {
  /**
   * 「关 app 重开后档位不丢」拆成两半：启动时从 settings 灌进 uiStore，改档位时经
   * `settings.update` 写回。持久化订阅比较的字段集合里漏了 readingFontSize，改字号就
   * 一次都不写盘 —— 当场界面照变，重启才打回原档。
   */
  it('启动时 settings 里的档位进了 uiStore', async () => {
    // 刻意不等于 uiStore 的默认档（medium）：撞在一起时删掉 bootstrap 那一行照样绿
    useUiStore.setState({ readingFontSize: 'medium' });
    const orig = BOOT.settings;
    BOOT.settings = { ...SETTINGS, ui: { ...SETTINGS.ui, readingFontSize: 'small' } };
    try {
      await bootstrap();
    } finally {
      BOOT.settings = orig;
    }
    expect(useUiStore.getState().readingFontSize).toBe('small');
  });

  it('改档位触发 settings.update，负载里是新档位', async () => {
    await bootstrap();
    await settle();
    expect(useUiStore.getState().readingFontSize).toBe('medium');
    const from = calls.length;

    useUiStore.getState().setReadingFontSize('large');
    await settle();

    const sent = settingsUpdatesSince(from);
    expect(sent.length).toBeGreaterThan(0);
    for (const args of sent) expect(args.ui.readingFontSize).toBe('large');
  });
});

describe('update.status 广播接进了 updateStore', () => {
  /**
   * 更新横幅唯一的数据源。自动检查、「立即检查」都只在主进程里改状态，渲染层靠这条广播
   * 跟上；只接了启动时那次 `update.getStatus` 的话，横幅永远停在启动那一刻。
   */
  it('主进程推一帧「有更新」，store 就是那一帧，横幅判据随之翻成要显示', async () => {
    useUpdateStore.setState({ status: null });
    await bootstrap();
    await settle();
    // 先证明启动那次 getStatus 已经落地、且与下面那帧不同 —— 否则「等于推来的那帧」
    // 可能只是 getStatus 的回复恰好长得一样。
    expect(useUpdateStore.getState().status).toEqual(UPDATE_IDLE);
    expect(shouldShowBanner(useUpdateStore.getState().status)).toBe(false);

    const pushed: UpdateStatus = {
      ...UPDATE_IDLE,
      check: { phase: 'ok' },
      update: { kind: 'available', candidateId: 'c1', label: 'KyDog 9.9.9' },
    };
    fire('update.status', pushed);

    expect(useUpdateStore.getState().status).toEqual(pushed);
    expect(shouldShowBanner(useUpdateStore.getState().status)).toBe(true);
  });
});
