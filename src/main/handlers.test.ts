import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RpcMethod } from '../shared/protocol';
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
  registerAllHandlers();
});

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
