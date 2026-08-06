import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TelemetryService, TelemetrySettings } from './telemetryService';

// assemble.ts 是装配层：electron / settings / log 全部替身，只验「装出来的东西对不对」。
// vi.hoisted 是必需的 —— vi.mock 工厂被提升到 import 之前，直接引用顶层 const 会炸。
const h = vi.hoisted(() => ({
  isPackaged: true,
  version: '1.2.3',
  created: [] as Array<Record<string, unknown>>,
  warns: [] as Array<[string, string, unknown]>,
  setTelemetry: undefined as unknown as ReturnType<typeof vi.fn>,
  emitted: [] as Array<[string, unknown]>,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return h.isPackaged; },
    getVersion: () => h.version,
  },
}));

vi.mock('../log', () => ({
  logger: {
    debug: () => {}, info: () => {}, error: () => {},
    warn: (scope: string, msg: string, ctx?: unknown) => { h.warns.push([scope, msg, ctx]); },
  },
}));

vi.mock('../settings/settingsService', () => ({
  settingsService: { setTelemetry: (...args: unknown[]) => h.setTelemetry(...args) },
}));

vi.mock('../ipc/broadcaster', () => ({
  broadcaster: { emit: (topic: string, payload: unknown) => { h.emitted.push([topic, payload]); } },
}));

vi.mock('./telemetryService', () => ({
  createTelemetryService: (deps: Record<string, unknown>) => {
    h.created.push(deps);
    return {
      init: vi.fn(async () => {}),
      enable: async () => {}, disable: async () => {}, deleteMyData: async () => {},
      syncFromSettings: async () => {},
      state: () => 'undecided', currentId: () => null,
    } satisfies TelemetryService;
  },
}));

const INITIAL: TelemetrySettings = { state: 'enabled', decidedAt: '2026-08-05T00:00:00.000Z' };

const restores: Array<() => void> = [];
/** process.platform / arch 是 writable:false 但 configurable:true，只能靠 defineProperty 顶替。 */
function stubProcess(prop: 'platform' | 'arch', value: string) {
  const orig = Object.getOwnPropertyDescriptor(process, prop)!;
  Object.defineProperty(process, prop, { ...orig, value });
  restores.push(() => Object.defineProperty(process, prop, orig));
}

/** 每例都重载模块：assemble.ts 的 service / 两个闸门标志是模块级状态。 */
async function load() {
  vi.resetModules();
  return import('./assemble');
}

function lastDeps() {
  return h.created[h.created.length - 1];
}

beforeEach(() => {
  h.isPackaged = true;
  h.version = '1.2.3';
  h.created = [];
  h.warns = [];
  h.emitted = [];
  h.setTelemetry = vi.fn(async () => {});
  delete process.env.KYDOG_E2E;
  // 默认钉死在契约枚举内，别让宿主机的真实平台决定用例结果
  stubProcess('platform', 'darwin');
  stubProcess('arch', 'x64');
});

afterEach(() => {
  while (restores.length) restores.pop()!();
});

describe('assembleTelemetry', () => {
  it('闸门开 + 版本合法 + 平台架构在枚举内 → 两道闸全开，事实原样透传', async () => {
    stubProcess('platform', 'win32');
    stubProcess('arch', 'arm64');
    const { assembleTelemetry, telemetryStatus } = await load();
    assembleTelemetry(INITIAL);

    expect(lastDeps().canReachNetwork).toBe(true);
    expect(lastDeps().canBeacon).toBe(true);
    expect(telemetryStatus().canBeacon).toBe(true);
    expect(lastDeps().platform).toBe('win32');
    expect(lastDeps().arch).toBe('arm64');
    expect(lastDeps().appVersion).toBe('1.2.3');
    expect(lastDeps().initial).toEqual(INITIAL);
    expect(h.warns).toEqual([]);
  });

  it('未打包 → 两道闸全关（开发态连删除都不出网）', async () => {
    h.isPackaged = false;
    const { assembleTelemetry, telemetryStatus } = await load();
    assembleTelemetry(INITIAL);
    expect(lastDeps().canReachNetwork).toBe(false);
    expect(lastDeps().canBeacon).toBe(false);
    expect(telemetryStatus().canBeacon).toBe(false);
    expect(telemetryStatus().canReachNetwork).toBe(false);
  });

  it('e2e → 两道闸全关（其余全合法）', async () => {
    process.env.KYDOG_E2E = '1';
    const { assembleTelemetry, telemetryStatus } = await load();
    assembleTelemetry(INITIAL);
    expect(lastDeps().canReachNetwork).toBe(false);
    expect(lastDeps().canBeacon).toBe(false);
    expect(telemetryStatus().canBeacon).toBe(false);
  });

  // 版本 / 平台只影响 beacon 的合法性，forget 的 payload 只有 {id} —— 出网那道闸
  // 必须留着，否则这个构建的用户永远删不掉数据、永远冻在 deleting
  it('版本非 semver → canBeacon=false 但 canReachNetwork 仍为 true，并记警告', async () => {
    h.version = '1.2';
    const { assembleTelemetry, telemetryStatus } = await load();
    assembleTelemetry(INITIAL);
    expect(lastDeps().canBeacon).toBe(false);
    expect(lastDeps().canReachNetwork).toBe(true);
    expect(telemetryStatus().canBeacon).toBe(false);
    // 两道闸必须**分开**送到 UI：合成一个布尔，半开态下 state 为 enabled 的用户
    // 会被一个禁用的开关锁死，连撤回同意都做不到
    expect(telemetryStatus().canReachNetwork).toBe(true);
    expect(h.warns.some(([scope]) => scope === 'telemetry')).toBe(true);
  });

  it('版本超长 → canBeacon=false', async () => {
    h.version = `1.2.3-${'a'.repeat(40)}`;
    const { assembleTelemetry, telemetryStatus } = await load();
    assembleTelemetry(INITIAL);
    expect(lastDeps().canBeacon).toBe(false);
    expect(telemetryStatus().canBeacon).toBe(false);
  });

  it('平台不在枚举内 → 传 null 而不是占位值，canBeacon=false 并记警告', async () => {
    stubProcess('platform', 'linux');
    const { assembleTelemetry, telemetryStatus } = await load();
    assembleTelemetry(INITIAL);
    // 传 'darwin' 之类的占位值就是把编造的事实物化下去
    expect(lastDeps().platform).toBe(null);
    expect(lastDeps().arch).toBe('x64');
    expect(lastDeps().canBeacon).toBe(false);
    expect(lastDeps().canReachNetwork).toBe(true);
    expect(telemetryStatus().canBeacon).toBe(false);
    expect(h.warns.some(([scope]) => scope === 'telemetry')).toBe(true);
  });

  it('架构不在枚举内 → 传 null 而不是占位值，canBeacon=false', async () => {
    stubProcess('arch', 'ia32');
    const { assembleTelemetry, telemetryStatus } = await load();
    assembleTelemetry(INITIAL);
    expect(lastDeps().arch).toBe(null);
    expect(lastDeps().platform).toBe('darwin');
    expect(lastDeps().canBeacon).toBe(false);
    expect(telemetryStatus().canBeacon).toBe(false);
  });

  it('save 接到 settingsService.setTelemetry —— telemetry 一节的唯一写者', async () => {
    const { assembleTelemetry } = await load();
    assembleTelemetry(INITIAL);
    const next: TelemetrySettings = { state: 'disabled', decidedAt: '2026-08-06T00:00:00.000Z' };
    await (lastDeps().save as (t: TelemetrySettings) => Promise<void>)(next);
    expect(h.setTelemetry).toHaveBeenCalledWith(next);
  });

  // 启动时那次「重试未完成的删除」是 fire-and-forget，而 assembleTelemetry() 早于
  // createWindow()：窗口开出来时它可能还在飞。没有这条广播，用户点进隐私面板拿到
  // 的 deleting 就再也不会被纠正 —— 删除其实已经完成了，界面还挂着「尚未完成」。
  it('onChange 接到 telemetry.status 广播', async () => {
    const { assembleTelemetry } = await load();
    assembleTelemetry(INITIAL);
    (lastDeps().onChange as (s: { state: string; installId: string | null }) => void)(
      { state: 'disabled', installId: null },
    );
    expect(h.emitted).toEqual([
      ['telemetry.status', { state: 'disabled', installId: null, canBeacon: true, canReachNetwork: true }],
    ]);
  });

  it('广播 payload 与 telemetryStatus() 同形，闸门字段一并带上', async () => {
    h.version = '1.2';  // 半开态：canBeacon 关、canReachNetwork 开
    const { assembleTelemetry, telemetryStatus } = await load();
    assembleTelemetry(INITIAL);
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    (lastDeps().onChange as (s: { state: string; installId: string | null }) => void)(
      { state: 'enabled', installId: id },
    );
    expect(h.emitted[0][1]).toEqual({
      ...telemetryStatus(), state: 'enabled', installId: id,
    });
    expect(h.emitted[0][1]).toMatchObject({ canBeacon: false, canReachNetwork: true });
  });

  it('装配时调一次 init()', async () => {
    const { assembleTelemetry, getTelemetryService } = await load();
    assembleTelemetry(INITIAL);
    expect(getTelemetryService().init).toHaveBeenCalledTimes(1);
  });
});

describe('getTelemetryService', () => {
  it('装配前调用直接抛错，而不是返回一个假的服务', async () => {
    const { getTelemetryService } = await load();
    expect(() => getTelemetryService()).toThrow();
  });

  it('装配后返回同一实例', async () => {
    const { assembleTelemetry, getTelemetryService } = await load();
    assembleTelemetry(INITIAL);
    expect(getTelemetryService()).toBe(getTelemetryService());
  });
});
