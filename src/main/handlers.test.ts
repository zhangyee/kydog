import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RPC_METHODS, type RpcMethod } from '../shared/protocol';
import type { TelemetryService, TelemetrySettings } from './telemetry/telemetryService';

// 替身五个模块就能干净 import handlers.ts：electron（模块加载期就会被读）、
// dispatcher（截下注册表）、telemetry/assemble（被测的那条接线），以及
// onboardingService + settingsService —— 这两个会去读写真实的 ~/.kydog。
// 剩下的 service 单例都是惰性的，import 时不碰磁盘也不出网。
const h = vi.hoisted(() => ({
  captured: {} as Partial<Record<RpcMethod, (args: unknown) => unknown>>,
  calls: [] as string[],
  canBeacon: false,
  canReachNetwork: false,
  state: 'enabled' as 'undecided' | 'enabled' | 'deleting' | 'disabled',
  installId: null as string | null,
  // onboarding → 遥测同步那条接线用：结果由用例摆布，同步进去的值记在 synced 里
  onboardingOk: true,
  telemetry: { state: 'enabled', decidedAt: '2026-08-05T00:00:00.000Z' } as TelemetrySettings,
  synced: [] as TelemetrySettings[],
  settings: {} as SettingsFile,
  /** 浏览器与机构两条新路上，handler 到底转发了什么。 */
  browser: [] as Array<{ m: string; args: unknown }>,
  institution: [] as Array<{ m: string; args: unknown }>,
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', getLocale: () => 'zh-CN', isPackaged: true },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {},
}));

vi.mock('./ipc/dispatcher', () => ({
  registerHandler: (m: RpcMethod, fn: (args: unknown) => unknown) => { h.captured[m] = fn; },
}));

vi.mock('./telemetry/assemble', () => ({
  telemetryStatus: () => ({
    state: h.state, installId: h.installId, canBeacon: h.canBeacon, canReachNetwork: h.canReachNetwork,
  }),
  getTelemetryService: (): TelemetryService => ({
    init: async () => {},
    enable: async () => { h.calls.push('enable'); },
    disable: async () => { h.calls.push('disable'); },
    deleteMyData: async () => { h.calls.push('deleteMyData'); },
    syncFromSettings: async (next: TelemetrySettings) => { h.calls.push('syncFromSettings'); h.synced.push(next); },
    state: () => h.state,
    currentId: () => h.installId,
  }),
}));

// onboarding 那两个入口要替身，否则会去读写真实的 ~/.kydog。settingsService 同理：
// syncTelemetryFromSettings() 会读它拿 telemetry 字段。
vi.mock('./harness/onboardingService', () => ({
  onboardingService: {
    complete: async () => (h.onboardingOk ? { ok: true } : { ok: false, code: 'model-missing', message: '' }),
    resume: async () => (h.onboardingOk ? { ok: true } : { ok: false, code: 'manifest-corrupt', message: '' }),
  },
}));
// toRendererSettings 用**真的那一个** —— 替身一个「看起来会删字段」的假货，
// 这组用例就退化成在测自己写的替身。
vi.mock('./settings/settingsService', async (orig) => ({
  ...(await orig<typeof import('./settings/settingsService')>()),
  settingsService: {
    get: async () => ({ ...h.settings, telemetry: h.telemetry }),
    update: async () => ({ ...h.settings, telemetry: h.telemetry }),
  },
}));

// app.bootstrap 会去读这几样真实磁盘状态，测密文出口时全部替身掉。
vi.mock('./project/projectService', () => ({ projectService: { list: async () => [] } }));
vi.mock('./thread/threadService', () => ({ threadService: { listAll: async () => [] } }));
vi.mock('./harness/identityService', () => ({ getIdentity: async () => ({ userName: '老张', agentName: 'KyDog' }) }));
vi.mock('./harness/manifest', () => ({
  readManifest: async () => ({ status: 'none' }),
  deleteManifest: async () => {},
  discardCorruptManifest: async () => {},
}));
vi.mock('./ui/viewState', () => ({ viewStateStore: { get: () => null, set: () => {} } }));

/**
 * 浏览器与机构两个服务替身掉：真的那两个 import 的是 electron 的
 * `WebContentsView` / `session` / `safeStorage`，在这个文件的 electron 替身里
 * 一个都没有 —— 不替身掉，整份 handlers.ts 连加载都加载不了。
 *
 * **`newEpoch` / `getState` 例外，接的是真的 `TabRegistry`**（那个模块是纯记账、
 * 不碰 electron）：`browser.getState` 顺带签发新 epoch 这条接线，只有让它去动
 * 一个真账本，「epoch 推了、revision 也推了」才不是在测替身自己。
 */
vi.mock('./browser/browserService', async () => {
  const { TabRegistry } = await import('./browser/tabRegistry');
  const reg = new TabRegistry();
  return {
    browserService: {
      _registry: reg,
      open: (args: unknown) => { h.browser.push({ m: 'open', args }); return Promise.resolve({ tabId: 'tab-1', nav: null }); },
      close: (id: string) => { h.browser.push({ m: 'close', args: id }); },
      keep: (id: string) => { h.browser.push({ m: 'keep', args: id }); },
      activate: (id: string) => { h.browser.push({ m: 'activate', args: id }); },
      navControl: (id: string, action: string) => { h.browser.push({ m: 'navControl', args: { id, action } }); return Promise.resolve(); },
      // 记下**签发出去的那个值**：m2 那条用例要拿它和快照里的 epoch 比，
      // 「两次不相等」挡不住顺序反了（反了也是两个不同的值）。
      newEpoch: () => { const ep = reg.newEpoch(); h.browser.push({ m: 'newEpoch', args: ep }); return ep; },
      getState: () => { h.browser.push({ m: 'getState', args: undefined }); return reg.toState(); },
      syncView: (args: unknown) => { h.browser.push({ m: 'syncView', args }); },
      disposeForRun: () => {},
    },
  };
});

vi.mock('./institution/institutionService', () => ({
  institutionService: {
    get: async () => { h.institution.push({ m: 'get', args: undefined }); return { name: '北京大学', entityID: 'https://idp.pku.edu.cn/idp/shibboleth', username: '2100012345', hasPassword: true, confirmedLogin: null }; },
    save: async (args: unknown) => { h.institution.push({ m: 'save', args }); return { name: '北京大学', entityID: 'https://idp.pku.edu.cn/idp/shibboleth', username: '2100012345', hasPassword: true, confirmedLogin: null }; },
    clear: async () => { h.institution.push({ m: 'clear', args: undefined }); },
    reveal: async () => { h.institution.push({ m: 'reveal', args: undefined }); return { password: 'hunter2' }; },
    listIdps: async (args: unknown) => { h.institution.push({ m: 'listIdps', args }); return { entries: [], fetchedAt: '2026-09-08T00:00:00.000Z', stale: false }; },
  },
}));
// locale.set 那条出口要走真正注册的 handler，而 localeSet 的 listSkills 接的是
// skillsService.listUnlocked() —— 它会 mkdir 真实的 ~/.kydog/skills 并读整棵树。
vi.mock('./skills/skillsService', () => ({ skillsService: { listUnlocked: async () => [] } }));

import { registerAllHandlers } from './handlers';
import { defaultSettings } from './persist/settingsFile';
import type { SettingsFile, TelemetryStatus } from '../shared/types';

function invoke(method: RpcMethod, args?: unknown) {
  const fn = h.captured[method];
  if (!fn) throw new Error(`${method} 未注册`);
  return fn(args) as Promise<TelemetryStatus> | TelemetryStatus;
}

const SENTINEL = 'SENTINEL-CIPHERTEXT';
const PKU = 'https://idp.pku.edu.cn/idp/shibboleth';

function settingsWithSecret(): SettingsFile {
  const s = defaultSettings();
  s.institution = {
    name: '北京大学', entityID: PKU, username: '2100012345',
    passwordEnc: SENTINEL,
    confirmedLogin: { entityID: PKU, origin: 'https://iaaa.pku.edu.cn' },
  };
  return s;
}

beforeEach(() => {
  h.captured = {};
  h.calls = [];
  h.canBeacon = false;
  h.canReachNetwork = false;
  h.state = 'enabled';
  h.installId = null;
  h.onboardingOk = true;
  h.telemetry = { state: 'enabled', decidedAt: '2026-08-05T00:00:00.000Z' };
  h.synced = [];
  h.settings = settingsWithSecret();
  h.browser = [];
  h.institution = [];
  registerAllHandlers();
});

/** 任意一条 RPC，返回值不收窄 —— 上面那个 invoke 的返回类型是给遥测那组用的。 */
function call(method: RpcMethod, args?: unknown): Promise<unknown> {
  const fn = h.captured[method];
  if (!fn) throw new Error(`${method} 未注册`);
  return Promise.resolve(fn(args));
}

/**
 * protocol.ts 上写着「密码只会 渲染层 → 主进程 单向流动，连密文也不回传」。
 * 那句话以前是假的：institution.get 那条窄接口是装饰性的，真正的出口在这三条老 RPC 上 ——
 * 它们回整份 SettingsFile，每次启动就把 passwordEnc 交给 useSettingsStore。
 *
 * 现在由类型挡着（SettingsFileForRenderer 里没有 passwordEnc，主进程收口处必须转换），
 * 这几条用例守的是「转换真的发生了」。
 */
describe('密文不过河', () => {
  it('哨兵确实在源里 —— 少了这条，下面几句 not.toContain 什么都证明不了', () => {
    expect(JSON.stringify(h.settings)).toContain(SENTINEL);
  });

  // 四条出口一条都不能少。locale.set 从前只有类型闸没有行为断言 —— 哪天有人顺手把
  // LocaleSetResult.settings 也换成 SettingsFileForRenderer「统一」一下，这条出口就
  // 同时失去了类型闸和用例闸，而它回的同样是整份 settings。
  // 传 locale: 'zh' 走的是 localeSet 的 unchanged 分支（h.settings 本来就是 zh）：
  // 不碰 skill 树、不 dispose session，测的正是返回值那一次投影。
  for (const [method, args] of [
    ['app.bootstrap', undefined],
    ['settings.get', undefined],
    ['settings.update', { ui: { theme: 'sepia' } }],
    ['locale.set', { locale: 'zh' }],
  ] as const) {
    it(`${method} 的返回里没有密文`, async () => {
      const out = await invoke(method, args);
      expect(JSON.stringify(out), method).not.toContain(SENTINEL);
    });
  }

  it('该过河的照常过河：机构名 / 学号 / hasPassword', async () => {
    const out = await invoke('settings.get') as unknown as { institution: unknown };
    expect(out.institution).toEqual({
      name: '北京大学', entityID: PKU, username: '2100012345',
      hasPassword: true,
      confirmedLogin: { entityID: PKU, origin: 'https://iaaa.pku.edu.cn' },
    });
  });
});

describe('telemetry IPC 接线', () => {
  it('三个方法都注册了', () => {
    for (const m of ['telemetry.getStatus', 'telemetry.setEnabled', 'telemetry.deleteMyData'] as const) {
      expect(h.captured[m], `${m} 未注册`).toBeTypeOf('function');
    }
  });

  // 要害：状态整份取自 assemble 的 telemetryStatus()，这里不许自己拼一份 ——
  // 闸门字段（含版本与平台自检）写死或漏掉，UI 就会显示开关可用而实际静默不报
  it('getStatus 原样返回 telemetryStatus()，不是自己拼的', async () => {
    h.installId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(await invoke('telemetry.getStatus')).toEqual({
      state: 'enabled',
      installId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      canBeacon: false,
      canReachNetwork: false,
    });

    // 两道闸分开送到 UI：半开态（发不出 beacon 但出得了网）下用户必须还能关掉统计
    h.canReachNetwork = true;
    expect(await invoke('telemetry.getStatus')).toMatchObject({ canBeacon: false, canReachNetwork: true });
  });

  // 对调了就是「用户点开启实际执行关闭」，一路静默到人工验收
  it('setEnabled(true) 调 enable，setEnabled(false) 调 disable', async () => {
    await invoke('telemetry.setEnabled', { enabled: true });
    expect(h.calls).toEqual(['enable']);
    await invoke('telemetry.setEnabled', { enabled: false });
    expect(h.calls).toEqual(['enable', 'disable']);
  });

  it('deleteMyData 转发到服务同名方法', async () => {
    await invoke('telemetry.deleteMyData');
    expect(h.calls).toEqual(['deleteMyData']);
  });

  // 三个方法都返回完整状态：用户点「关闭」后拿回 state:'enabled' 就意味着「什么都没发生」
  it('三个方法都返回操作后的当前状态', async () => {
    h.state = 'deleting';
    h.installId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    for (const [m, args] of [
      ['telemetry.getStatus', undefined],
      ['telemetry.setEnabled', { enabled: false }],
      ['telemetry.deleteMyData', undefined],
    ] as const) {
      const r = await invoke(m, args);
      expect(r, m).toEqual({
        state: 'deleting', installId: h.installId, canBeacon: false, canReachNetwork: false,
      });
    }
  });
});

describe('onboarding 完成后同步遥测状态', () => {
  // 遥测服务在启动时装配，那会儿状态还是 undecided。少了这条同步，用户在向导里勾的
  // 选项本次会话完全不生效：不起调度、不生成 ID，设置页还显示成未勾选。
  it('complete 成功后把 settings.telemetry 同步进服务', async () => {
    h.telemetry = { state: 'enabled', decidedAt: '2026-08-05T00:00:00.000Z' };
    await invoke('onboarding.complete', {});
    expect(h.calls).toEqual(['syncFromSettings']);
    // 取自 settings 而不是 args：manifest/settings 里的 decidedAt 才是权威值
    expect(h.synced).toEqual([{ state: 'enabled', decidedAt: '2026-08-05T00:00:00.000Z' }]);
  });

  it('resume 成功后同样同步（选择记在 manifest 里）', async () => {
    h.telemetry = { state: 'disabled', decidedAt: '2026-08-05T00:00:00.000Z' };
    await invoke('onboarding.resume');
    expect(h.synced).toEqual([{ state: 'disabled', decidedAt: '2026-08-05T00:00:00.000Z' }]);
  });

  // 失败时 settings 根本没被改写，同步进去的会是上一轮的旧值
  it('失败时不同步', async () => {
    h.onboardingOk = false;
    await invoke('onboarding.complete', {});
    await invoke('onboarding.resume');
    expect(h.calls).toEqual([]);
    expect(h.synced).toEqual([]);
  });
});

/**
 * **注册穷尽性闸（最终评审 I5）。**
 *
 * `dispatcher.ts` 的 `handlers[method] = …` 是运行时填表：往 `RpcCall` 加一条而不注册
 * handler **不会编译报错、不会有任何用例红**，只在运行时回一句 `no handler for …`。
 * 这条盲区不是本分支引入的，但本分支一次把它从 0 条放大到 12 条 ——
 * Task 6 漏注册一两条不会有任何东西提醒。
 *
 * 所以每一条 RPC 都得有个交代：要么注册了，要么明确写在下面这份名单里。
 */
const PENDING_REGISTRATION: RpcMethod[] = [
  // 空的。Task 6 把 browser.* 七条与 institution.* 五条都接上了。
  // 这份名单留着不删：往 RpcCall 加一条而不注册 handler 仍然不会编译报错，
  // 下一次「先加协议、后接线」的批次仍要在这里交代自己。
];

describe('每一条 RPC 都有交代：注册了，或明确登记成「尚未接线」', () => {
  it('协议里没有一条是「谁都没管、也没人知道」的', () => {
    const registered = new Set(Object.keys(h.captured));
    const pending = new Set<string>(PENDING_REGISTRATION);
    // 加了一条 RpcCall、既没注册 handler 也没写进上面的名单 → 这里红。
    expect(RPC_METHODS.filter((m) => !registered.has(m) && !pending.has(m))).toEqual([]);
  });

  it('「尚未接线」名单不许过期 —— 接上了就要从名单里划掉', () => {
    const registered = new Set(Object.keys(h.captured));
    // Task 6 把 browser.* 注册上却忘了删这里 → 这里红，名单不会烂在库里。
    expect(PENDING_REGISTRATION.filter((m) => registered.has(m))).toEqual([]);
  });

  it('注册的都是协议里真有的方法，没有拼错的名字', () => {
    const known = new Set<string>(RPC_METHODS);
    expect(Object.keys(h.captured).filter((m) => !known.has(m))).toEqual([]);
  });

  // 上面三条合起来才是穷尽的：没有这一条，一份「什么都没注册」的空表也能全绿。
  it('确实注册到了东西 —— 钉住上面几条不是空绿', () => {
    expect(Object.keys(h.captured).length).toBe(RPC_METHODS.length - PENDING_REGISTRATION.length);
  });
});

/**
 * **浏览器七条：接错了不会编译报错，只会「悄悄不工作」。**
 *
 * 这一层全是转发，所以要守的正是转发本身：调的是不是那个方法、参数有没有对调、
 * 有没有把渲染层发来的东西整个递下去。上面那三条穷尽性断言只管「注册了没有」，
 * 管不了「注册的那个函数干的是不是这件事」——
 * `registerHandler('browser.close', (a) => browserService.keep(a.tabId))` 照样全绿。
 */
describe('browser.* 七条转发到 browserService 上对应的那一个', () => {
  it('open 只递协议上写明的 url / tabId', async () => {
    await call('browser.open', { url: 'https://x.example/p', tabId: 't7' });
    expect(h.browser).toEqual([{ m: 'open', args: { url: 'https://x.example/p', tabId: 't7' } }]);
  });

  /**
   * `BrowserService.open` 还收一个 `ownerRunId` —— 「这个标签属于哪一轮 run、
   * 回合结束回收它」的记账字段。渲染层在类型上给不出它，但**类型挡不住运行时**：
   * 把 args 整个递下去的话，一条伪造的 RPC 就能开出一个「属于某轮 run」的标签，
   * 而那一轮 settle 时它会被连页面一起收走 —— 用户的页面无声消失。
   */
  it('open 不认渲染层塞进来的 ownerRunId —— 这条路开的标签永远是用户的', async () => {
    await call('browser.open', { url: 'https://x.example/p', ownerRunId: 'run-伪造' });
    expect(h.browser[0].args).toEqual({ url: 'https://x.example/p', tabId: undefined });
    expect(JSON.stringify(h.browser)).not.toContain('run-伪造');
  });

  it('close / keep / activate 各调各的，参数是 tabId', async () => {
    await call('browser.close', { tabId: 't1' });
    await call('browser.keep', { tabId: 't2' });
    await call('browser.activate', { tabId: 't3' });
    expect(h.browser).toEqual([
      { m: 'close', args: 't1' },
      { m: 'keep', args: 't2' },
      { m: 'activate', args: 't3' },
    ]);
  });

  it('navControl 把 action 原样带下去（四个动作都试一遍）', async () => {
    for (const action of ['back', 'forward', 'reload', 'stop'] as const) {
      await call('browser.navControl', { tabId: 't1', action });
    }
    expect(h.browser).toEqual([
      { m: 'navControl', args: { id: 't1', action: 'back' } },
      { m: 'navControl', args: { id: 't1', action: 'forward' } },
      { m: 'navControl', args: { id: 't1', action: 'reload' } },
      { m: 'navControl', args: { id: 't1', action: 'stop' } },
    ]);
  });

  /**
   * **四种布尔组合各递一次。**
   *
   * `visible`（侧栏开没开）与 `occluded`（被浮层盖住）是两件事，协议注释专门写了
   * 「别合成一个」。只用一组 fixture 的话，`toEqual(stage)` 挡不住「把某个布尔钉到
   * fixture 那个值上」：handler 写成 `syncView({ ...args, visible: true })` 照样全绿，
   * 而产品行为是用户收起侧栏之后，原生 WebContentsView 仍按最后一次几何盖在 UI 上。
   * 两个 false / 两个 true 那两组之外还要有一真一假的两组 —— 否则把两个字段**对调**
   * 也测不出来。bounds 每组不同，顺带钉住「递的是这一次的那份，不是上一次的」。
   */
  it('syncView 把整份舞台几何原样递下去 —— 两个布尔的四种组合都不许被钉死或对调', async () => {
    const stages = [
      { epoch: 3, visible: true, occluded: false, bounds: { x: 1, y: 2, width: 300, height: 400 } },
      { epoch: 4, visible: false, occluded: false, bounds: { x: 5, y: 6, width: 301, height: 401 } },
      { epoch: 5, visible: true, occluded: true, bounds: { x: 7, y: 8, width: 302, height: 402 } },
      { epoch: 6, visible: false, occluded: true, bounds: { x: 9, y: 10, width: 303, height: 403 } },
    ];
    for (const stage of stages) await call('browser.syncView', stage);
    expect(h.browser).toEqual(stages.map((args) => ({ m: 'syncView', args })));
  });
});

/**
 * **`browser.getState` 顺带签发新 epoch。**
 *
 * 协议上没有第二条 RPC 能给渲染层新 epoch。漏了这一下不会有任何报错：
 * 渲染层拿着旧 epoch 上报 bounds → 主进程一律判过期丢弃 → 侧栏里那块网页永远
 * 拿不到几何、一直不可见，直到下一次真实标签变更才恢复。
 */
describe('browser.getState 顺带签发新 epoch', () => {
  it('每调一次都换一个 epoch', async () => {
    const a = await call('browser.getState') as { epoch: number };
    const b = await call('browser.getState') as { epoch: number };
    expect(b.epoch).toBeGreaterThan(a.epoch);
  });

  /**
   * 上面那条只量「两次不相等」—— 顺序反了（先取快照、后签发）它照样绿，因为两次
   * 拿到的仍是两个不同的值。真正要钉的是**返回的那一份带的就是这一次签发的那个**，
   * 所以拿 `newEpoch()` 的返回值直接和快照里的 epoch 比。
   */
  it('返回的那一份带的就是这一次签发的那个 epoch，不是上一个', async () => {
    const a = await call('browser.getState') as { epoch: number };
    const b = await call('browser.getState') as { epoch: number };
    const issued = h.browser.filter((c) => c.m === 'newEpoch').map((c) => c.args);
    expect(issued).toEqual([a.epoch, b.epoch]);
  });

  it('签发排在取快照之前 —— 顺序反了返回的是上一个 epoch', async () => {
    await call('browser.getState');
    expect(h.browser.map((c) => c.m)).toEqual(['newEpoch', 'getState']);
  });

  /**
   * epoch 变了 revision 必须跟着变（tabRegistry 那条注释说的就是这件事）：
   * 渲染层按 revision 去旧，同 revision 的那一帧会被整帧丢掉、继续用旧 epoch。
   * 这里接的是真的 TabRegistry，所以这条断言真的在量那件事。
   */
  it('epoch 推进时 revision 也推进', async () => {
    const a = await call('browser.getState') as { epoch: number; revision: number };
    const b = await call('browser.getState') as { epoch: number; revision: number };
    expect(b.revision).toBeGreaterThan(a.revision);
  });
});

/**
 * 机构五条。`institution.revealPassword` 对应的方法叫 `reveal()` —— 名字对不上
 * 是继承的，照名字猜就会写成 `institutionService.revealPassword()`（运行时才炸）。
 */
describe('institution.* 五条转发到 institutionService 上对应的那一个', () => {
  it('五条各调各的，revealPassword 走的是 reveal()', async () => {
    await call('institution.get');
    await call('institution.clear');
    await call('institution.revealPassword');
    expect(h.institution.map((c) => c.m)).toEqual(['get', 'clear', 'reveal']);
  });

  /**
   * save 的 args 要原样到底。少递一个 `password`，界面上是「保存成功」而密码
   * 根本没换 —— 用户下次登录才发现，且没有任何错误可查。
   */
  it('save 原样递整份 args（含 password 与 confirmedLogin 那两档）', async () => {
    const args = {
      name: '北京大学', entityID: PKU, username: '2100012345',
      password: 'hunter2', confirmedLogin: null,
    };
    await call('institution.save', args);
    expect(h.institution).toEqual([{ m: 'save', args }]);
  });

  it('listIdps 把 refresh 带下去；不给 args 也不炸（当作不刷新）', async () => {
    await call('institution.listIdps', { refresh: true });
    await call('institution.listIdps', undefined);
    expect(h.institution).toEqual([
      { m: 'listIdps', args: { refresh: true } },
      { m: 'listIdps', args: { refresh: undefined } },
    ]);
  });

  it('revealPassword 是明文唯一的出口，其余四条的返回里没有密码', async () => {
    expect(await call('institution.revealPassword')).toEqual({ password: 'hunter2' });
    for (const [m, args] of [
      ['institution.get', undefined],
      ['institution.save', { name: 'x', entityID: 'https://a/b', username: 'u', password: 'hunter2' }],
      ['institution.clear', undefined],
      ['institution.listIdps', undefined],
    ] as const) {
      expect(JSON.stringify(await call(m, args) ?? null), m).not.toContain('hunter2');
    }
  });
});
