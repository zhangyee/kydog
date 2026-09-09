import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BootstrapState, SettingsFileForRenderer } from '../shared/types';
import { bootstrap } from './bootstrap';
import { useBrowserStore } from './panels/browser/browserStore';

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
  }],
};

type Listener = (payload: unknown) => void;

/** 按发生次序记下来的「装配轨迹」：`on:<topic>` 与 `invoke:<method>`。 */
let trace: string[] = [];
let listeners: Map<string, Listener[]>;

function fire(topic: string, payload: unknown): void {
  const fns = listeners.get(topic) ?? [];
  if (fns.length === 0) throw new Error(`没有人订阅 ${topic}`);
  for (const fn of fns) fn(payload);
}

beforeEach(() => {
  trace = [];
  listeners = new Map();
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
  };
});

afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).window; });

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
