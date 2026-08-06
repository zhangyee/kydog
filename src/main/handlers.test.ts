import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RpcMethod } from '../shared/protocol';
import type { TelemetryService } from './telemetry/telemetryService';

// 只替身三个模块就能干净 import handlers.ts：electron（模块加载期就会被读）、
// dispatcher（截下注册表）、telemetry/assemble（被测的那条接线）。
// 剩下的 service 单例都是惰性的，import 时不碰磁盘也不出网。
const h = vi.hoisted(() => ({
  captured: {} as Partial<Record<RpcMethod, (args: unknown) => unknown>>,
  calls: [] as string[],
  gateOpen: false,
  state: 'enabled' as 'undecided' | 'enabled' | 'deleting' | 'disabled',
  installId: null as string | null,
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
  telemetryGateOpen: () => h.gateOpen,
  getTelemetryService: (): TelemetryService => ({
    init: async () => {},
    enable: async () => { h.calls.push('enable'); },
    disable: async () => { h.calls.push('disable'); },
    deleteMyData: async () => { h.calls.push('deleteMyData'); },
    state: () => h.state,
    currentId: () => h.installId,
  }),
}));

import { registerAllHandlers } from './handlers';
import type { TelemetryStatus } from '../shared/types';

function invoke(method: RpcMethod, args?: unknown) {
  const fn = h.captured[method];
  if (!fn) throw new Error(`${method} 未注册`);
  return fn(args) as Promise<TelemetryStatus> | TelemetryStatus;
}

beforeEach(() => {
  h.captured = {};
  h.calls = [];
  h.gateOpen = false;
  h.state = 'enabled';
  h.installId = null;
  registerAllHandlers();
});

describe('telemetry IPC 接线', () => {
  it('三个方法都注册了', () => {
    for (const m of ['telemetry.getStatus', 'telemetry.setEnabled', 'telemetry.deleteMyData'] as const) {
      expect(h.captured[m], `${m} 未注册`).toBeTypeOf('function');
    }
  });

  // 要害：allowed 必须取最终闸门（含版本与平台自检）。写死 true 的话，
  // 版本非法时 UI 会显示开关可用而实际静默不报
  it('getStatus 的 allowed 取自 telemetryGateOpen()，不是写死的', async () => {
    h.installId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(await invoke('telemetry.getStatus')).toEqual({
      state: 'enabled',
      installId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      allowed: false,
    });

    h.gateOpen = true;
    expect((await invoke('telemetry.getStatus')).allowed).toBe(true);
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
      expect(r, m).toEqual({ state: 'deleting', installId: h.installId, allowed: false });
    }
  });
});
