import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RpcMethod } from '../shared/protocol';
import type { XResearchTaskSnapshot } from '../shared/xResearchTask';

// handlers.ts 一 import 就会碰这两样：electron（模块加载期被读）、dispatcher（填注册表）。
// 其余 service 单例都是惰性的 —— 这一组用例不调它们。
const h = vi.hoisted(() => ({
  captured: {} as Partial<Record<RpcMethod, (args: unknown, evt?: { sender: unknown }) => unknown>>,
  viewState: null as null | { threadId: string | null; activeTab: 'thread' | 'file' },
  windowSender: { id: 'window-sender' } as unknown,
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', getLocale: () => 'zh-CN', isPackaged: true },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: class {
    static fromWebContents(sender: unknown) {
      return sender === h.windowSender ? {} : null;
    }
  },
}));

vi.mock('./ipc/dispatcher', () => ({
  registerHandler: (m: RpcMethod, fn: (args: unknown, evt?: { sender: unknown }) => unknown) => {
    h.captured[m] = fn;
  },
}));

vi.mock('./ui/viewState', () => ({ viewStateStore: { get: () => h.viewState, set: () => {} } }));

import { registerAllHandlers } from './handlers';
import { registerXResearchTaskService, type XResearchTaskService } from './x/xResearchTaskService';

/** 只实现 RPC 会碰的四个方法：转发的判据是「哪个方法、拿到哪些参数」，别的一律不该被调到。 */
function fakeService(overrides: Partial<Record<'list' | 'get' | 'inspect' | 'cancel', unknown>> = {}) {
  const service = {
    list: async (threadId: string) => {
      h.calls.push({ method: 'list', args: [threadId] });
      return [snapshot({ threadId })];
    },
    get: async (threadId: string, researchRunId: string) => {
      h.calls.push({ method: 'get', args: [threadId, researchRunId] });
      return snapshot({ threadId, researchRunId });
    },
    inspect: async (threadId: string, researchRunId: string, input: unknown) => {
      h.calls.push({ method: 'inspect', args: [threadId, researchRunId, input] });
      return { snapshot: snapshot({ threadId, researchRunId }), items: [] };
    },
    cancel: async (threadId: string, researchRunId: string) => {
      h.calls.push({ method: 'cancel', args: [threadId, researchRunId] });
      return snapshot({ threadId, researchRunId, state: 'cancelled' });
    },
  };
  return Object.assign(service, overrides);
}

function snapshot(over: Partial<XResearchTaskSnapshot> = {}): XResearchTaskSnapshot {
  return {
    researchRunId: 'xrun-a', threadId: 'thread-a', revision: 1, state: 'running',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:01.000Z',
    objective: '找到讨论此事的帖子', counts: {
      submissions: 1, queued: 0, running: 1, done: 0, failed: 0, cancelled: 0,
      interrupted: 0, posts: 0, replies: 0, articles: 0, undelivered: 0,
    },
    budget: { scrolls: 50, expandActions: 10 }, usage: { posts: 0, scrolls: 0, expandActions: 0 },
    search: [], read: [],
    ...over,
  };
}

function call(method: RpcMethod, args: unknown, sender: unknown = h.windowSender): Promise<unknown> {
  const fn = h.captured[method];
  if (!fn) throw new Error(`${method} 未注册`);
  // 同步抛（闸就是这样抛的）也要变成 rejection：否则 `rejects` 拿不到它，用例挂在调用行上。
  return Promise.resolve().then(() => fn(args, { sender }));
}

const THREAD = 'thread-a';
const RUN = 'xrun-a';

beforeEach(() => {
  h.captured = {};
  h.calls = [];
  h.viewState = { threadId: THREAD, activeTab: 'thread' };
  registerXResearchTaskService(undefined);
  registerAllHandlers();
});

describe('x research task RPC 的可见性闸', () => {
  // 四条都是「主窗口正在看这个对话才回答」。判据与 webResearch.task* 逐字同一条：
  // 换一个对话、换一个窗口、停在别的标签上都答 research.not_found。
  const CALLS: Array<[RpcMethod, Record<string, unknown>]> = [
    ['xResearch.taskList', { threadId: THREAD }],
    ['xResearch.taskGet', { threadId: THREAD, researchRunId: RUN }],
    ['xResearch.taskInspect', { threadId: THREAD, researchRunId: RUN, view: 'rows' }],
    ['xResearch.taskCancel', { threadId: THREAD, researchRunId: RUN }],
  ];

  // 正控：同一个 sender 看自己的对话时，服务真的被调到。没有这一句，下面每个
  // 「一次都没碰到服务」都可能只是转发根本没通（本仓点名的假绿形态）。
  async function proveWiring(): Promise<void> {
    await expect(call('xResearch.taskList', { threadId: THREAD })).resolves.toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    h.calls = [];
  }

  it('别的对话的线程 id 一律拒绝，且一次都没碰到服务', async () => {
    registerXResearchTaskService(fakeService() as unknown as XResearchTaskService);
    await proveWiring();
    for (const [method, args] of CALLS) {
      await expect(call(method, { ...args, threadId: 'thread-b' }))
        .rejects.toMatchObject({ code: 'research.not_found' });
    }
    expect(h.calls).toEqual([]);
  });

  it('不是主窗口的 sender 一律拒绝', async () => {
    registerXResearchTaskService(fakeService() as unknown as XResearchTaskService);
    await proveWiring();
    for (const [method, args] of CALLS) {
      await expect(call(method, args, { id: 'hidden' }))
        .rejects.toMatchObject({ code: 'research.not_found' });
    }
    expect(h.calls).toEqual([]);
  });

  it('停在文件标签（而不是对话）上也拒绝', async () => {
    registerXResearchTaskService(fakeService() as unknown as XResearchTaskService);
    await proveWiring();
    h.viewState = { threadId: THREAD, activeTab: 'file' };
    for (const [method, args] of CALLS) {
      await expect(call(method, args)).rejects.toMatchObject({ code: 'research.not_found' });
    }
    expect(h.calls).toEqual([]);
  });

  it('看着这个对话时四条都放行', async () => {
    registerXResearchTaskService(fakeService() as unknown as XResearchTaskService);
    for (const [method, args] of CALLS) {
      await expect(call(method, args)).resolves.toBeTruthy();
    }
    expect(h.calls.map((entry) => entry.method)).toEqual(['list', 'get', 'inspect', 'cancel']);
  });
});

describe('x research task RPC 转发到 service 上对应的那一个', () => {
  beforeEach(() => {
    registerXResearchTaskService(fakeService() as unknown as XResearchTaskService);
  });

  it('taskList 递 threadId 并回服务给的列表', async () => {
    await expect(call('xResearch.taskList', { threadId: THREAD }))
      .resolves.toEqual([snapshot({ threadId: THREAD })]);
    expect(h.calls).toEqual([{ method: 'list', args: [THREAD] }]);
  });

  it('taskGet 递 threadId + researchRunId', async () => {
    await expect(call('xResearch.taskGet', { threadId: THREAD, researchRunId: RUN }))
      .resolves.toMatchObject({ researchRunId: RUN });
    expect(h.calls).toEqual([{ method: 'get', args: [THREAD, RUN] }]);
  });

  it('taskInspect 只把 view / cursor / pageSize 交给服务（协议外的字段不许当输入用）', async () => {
    await call('xResearch.taskInspect', {
      threadId: THREAD, researchRunId: RUN, view: 'failures', cursor: 'o20', pageSize: 5,
      // 渲染层发来的东西一律当输入看：这两个键不在 inspect 的入参上，漏进来也不能生效。
      unexpected: 'ignored',
    });
    expect(h.calls).toEqual([
      { method: 'inspect', args: [THREAD, RUN, { view: 'failures', cursor: 'o20', pageSize: 5 }] },
    ]);
  });

  it('taskInspect 省略的 cursor / pageSize 不造出 undefined 键（服务的省缺判据看的是「写没写」）', async () => {
    await call('xResearch.taskInspect', { threadId: THREAD, researchRunId: RUN, view: 'rows' });
    const input = h.calls[0]?.args[2] as Record<string, unknown>;
    expect(input).toEqual({ view: 'rows' });
    expect(Object.keys(input)).toEqual(['view']);
  });

  it('taskCancel 走的是服务上那个唯一的 cancel（与工具 cancel 动作同一处实现）', async () => {
    await expect(call('xResearch.taskCancel', { threadId: THREAD, researchRunId: RUN }))
      .resolves.toMatchObject({ state: 'cancelled' });
    expect(h.calls).toEqual([{ method: 'cancel', args: [THREAD, RUN] }]);
  });
});

/**
 * 未接线（x research 关闭 / 这个进程还没建过会话）时：`taskList` 答空列表，其余三条答
 * `research.not_found`。这是 null 分支唯一的钉子 —— 生产里它只在启动早期可达。
 */
describe('未接线时 x research task RPC 的答案', () => {
  it('taskList 答空列表（渲染层开对话就会调它，没有东西可显示不是错误）', async () => {
    await expect(call('xResearch.taskList', { threadId: THREAD })).resolves.toEqual([]);
  });

  it('taskGet / taskInspect / taskCancel 答 research.not_found', async () => {
    for (const method of ['xResearch.taskGet', 'xResearch.taskInspect', 'xResearch.taskCancel'] as const) {
      await expect(call(method, { threadId: THREAD, researchRunId: RUN, view: 'rows' }))
        .rejects.toMatchObject({ code: 'research.not_found' });
    }
  });
});
