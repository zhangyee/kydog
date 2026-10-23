import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BootstrapState, SettingsFileForRenderer } from '../shared/types';
import type { XResearchTaskSnapshot } from '../shared/xResearchTask';
import { bootstrap } from './bootstrap';
import { useXResearchTaskStore } from './stores/xResearchTaskStore';

/**
 * **`xResearch.taskUpdated` 那条广播真的接上了。**
 *
 * 快照池是卡的唯一数据源，而它只有两个入口：进对话时那次 `xResearch.taskList`，和这条广播。
 * 删掉 bootstrap 里那两行订阅，`tsc` / `lint` / 其余用例**全绿**，产品行为是卡片永远停在
 * 「读取中」—— 直到用户重开对话。所以这里照 `bootstrap.test.ts` 的做法真的跑一遍
 * `bootstrap()`，替身掉的只有 `window.kydog`，然后把一帧广播打进去看池子。
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
    browserOpen: false,
    browserWidth: 520,
    mdExport: { paper: 'a4', margin: 'standard', pageNumbers: true },
  },
  llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: 'anthropic', defaultModel: 'x' },
  skills: { disabledBuiltins: [] },
  tools: { externalBins: [] },
  research: { presets: {}, custom: [], xResearchEnabled: false },
  institution: null,
  updates: { autoCheck: true, dismissedCandidateId: null },
  telemetry: { state: 'undecided', decidedAt: null },
  onboarding: { completedAt: '2026-09-01T00:00:00.000Z' },
};

const BOOT: BootstrapState = {
  singleProjectPath: null,
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

type Listener = (payload: unknown) => void;

let listeners: Map<string, Listener[]>;

function fire(topic: string, payload: unknown): void {
  const fns = listeners.get(topic) ?? [];
  if (fns.length === 0) throw new Error(`没有人订阅 ${topic}`);
  for (const fn of fns) fn(payload);
}

function snapshot(over: Partial<XResearchTaskSnapshot> = {}): XResearchTaskSnapshot {
  return {
    researchRunId: 'xrun-a', threadId: 'thr-1', revision: 1, state: 'running',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:01.000Z',
    objective: '这段研究最初要回答的问题',
    counts: { submissions: 1, queued: 0, running: 1, done: 0, failed: 0, cancelled: 0,
      interrupted: 0, posts: 0, replies: 0, articles: 0, undelivered: 0,
      searchDone: 0, searchTotal: 1, readDone: 0, readTotal: 0 },
    budget: { scrolls: 100, expandActions: 100 },
    usage: { posts: 0, scrolls: 0, expandActions: 0 },
    search: [], read: [],
    ...over,
  };
}

beforeEach(() => {
  listeners = new Map();
  useXResearchTaskStore.setState({ snapshotsByRunId: {} });
  const replies: Record<string, unknown> = {
    'app.bootstrap': BOOT,
    'browser.getState': { revision: 0, epoch: 1, activeTabId: null, tabs: [] },
    'llm.list': { catalog: [], configured: [], customProviders: [], defaultProvider: null, defaultModel: null },
    'update.getStatus': { check: { phase: 'never' }, update: { kind: 'none' }, bannerDismissed: false,
      autoCheck: true, currentVersion: '0.0.0-test' },
    'skill.list': [],
    'skill.getSyncHealth': { state: 'ok', installedOrUpgraded: [], userSkills: [] },
    'settings.update': SETTINGS,
  };
  (globalThis as unknown as { window: unknown }).window = {
    innerWidth: 1280,
    kydog: {
      invoke: (method: string) => Promise.resolve(replies[method]),
      on: (topic: string, fn: Listener) => {
        const arr = listeners.get(topic) ?? [];
        arr.push(fn);
        listeners.set(topic, arr);
        return () => { listeners.set(topic, (listeners.get(topic) ?? []).filter((f) => f !== fn)); };
      },
    },
    addEventListener: () => {},
  };
});

afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).window; });

describe('bootstrap 把 x research 的广播接进了快照池', () => {
  it('每来一帧 taskUpdated 就整份 upsert：池里就是主进程那份快照，后来的覆盖先来的', async () => {
    await bootstrap();
    // 广播之前池子是空的：下面那条「池里有它」不能是别处塞进来的
    expect(useXResearchTaskStore.getState().snapshotsByRunId).toEqual({});

    const first = snapshot({ revision: 1 });
    fire('xResearch.taskUpdated', first);
    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-a']).toEqual(first);

    const later = snapshot({ revision: 2, state: 'completed' });
    fire('xResearch.taskUpdated', later);
    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-a']).toEqual(later);
  });
});
