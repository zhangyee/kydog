import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
// 替身掉整个 browserService：真的那一个 import 的是 electron 的 WebContentsView / session。
vi.mock('../browser/browserService', () => ({
  browserService: { disposeForRun: vi.fn() },
}));

import { agentService } from './AgentService';
import { browserService } from '../browser/browserService';

type Listener = (evt: { type: string; [k: string]: unknown }) => void;

const disposeForRun = browserService.disposeForRun as unknown as ReturnType<typeof vi.fn>;

/**
 * 造一个假 session 并挂上订阅。手法照 AgentService.parallel.test.ts —— 直接往私有
 * map 里塞 bound。**runs 故意不预置**：本文件考的正是 runId 从 `send()` 铸出来之后
 * 一路活到 `agent_settled` 这条链。
 */
function attach(threadId: string) {
  let listener: Listener = () => undefined;
  const bound = {
    threadId, providerId: 'anthropic', modelId: 'm', cwd: '/x',
    activeMessageId: null as string | null,
    askOpened: new Set<string>(),
    askArgs: new Map<string, { toolName: string; args: unknown }>(),
    runJournal: [],
    runStartIndex: null,
    runId: null as string | null,
    session: {
      prompt: vi.fn(async () => {}),
      abort: vi.fn(),
      dispose: vi.fn(),
      subscribe: (l: Listener) => { listener = l; return () => undefined; },
      state: { messages: [] as unknown[] },
    },
  };
  (agentService as any).sessions.set(threadId, bound);
  (agentService as any).subscribe(bound);
  return { bound, fire: (evt: { type: string; [k: string]: unknown }) => listener(evt) };
}

/** 一次正常收尾的 agent_end（pi 的载荷形状）。 */
const AGENT_END = { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'endTurn' }] };

beforeEach(() => {
  (agentService as any).sessions.clear();
  (agentService as any).runs.clear();
  disposeForRun.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * **这一条是本批最容易「悄悄不工作」的地方。**
 *
 * `agent_settled` 不带任何载荷（`agent-session.d.ts`：`{ type: "agent_settled" }`），
 * 而它在 `_runAgentPrompt` 的 `finally` 里发（`agent-session.js:755`），**严格排在
 * 最后一次 `agent_end` 之后**。KyDog 的 `agent_end` 分支已经把 `runs` 置回 idle，
 * 所以这一刻现算 runId 会算成 `'unknown'` —— `disposeForRun('unknown')` 拿它去比
 * `ownerRunId` 一个都命中不了：**不抛、不红、什么都不回收**，标签只增不减直到撞满上限。
 */
describe('agent_settled → 回收本轮 agent 开的标签', () => {
  it('回收用的是 send() 铸出来的那个 runId，不是 agent_end 之后现算的 unknown', async () => {
    const { fire } = attach('t1');
    const { runId } = await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    // agent_end 已经把 runs 置回 idle —— 现算就是这里出错的那一步。
    expect(agentService.getRunState('t1').status).toBe('idle');

    fire({ type: 'agent_settled' });
    expect(disposeForRun.mock.calls).toEqual([[runId]]);
    expect(runId).not.toBe('unknown');
  });

  it('agent_end 还不回收 —— pi 在它之后仍可能自动重试', async () => {
    const { fire } = attach('t1');
    await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    expect(disposeForRun).not.toHaveBeenCalled();
  });

  it('自动重试：agent_end → 再一轮 agent_start/agent_end → settled，回收的仍是同一个 runId', async () => {
    const { fire } = attach('t1');
    const { runId } = await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    // pi 的 _handlePostAgentRun → agent.continue()：又一轮低层 run，KyDog 的 runs 仍是 idle。
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    fire({ type: 'agent_settled' });
    expect(disposeForRun.mock.calls).toEqual([[runId]]);
  });

  it('abort 收尾也回收 —— pi 的 finally 照发 agent_settled', async () => {
    const { fire } = attach('t1');
    const { runId } = await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] });
    fire({ type: 'agent_settled' });
    expect(disposeForRun.mock.calls).toEqual([[runId]]);
  });

  it('没 send 过就收到 settled → 一次都不调（不许拿 unknown / null 去空跑一遍）', () => {
    const { fire } = attach('t1');
    fire({ type: 'agent_settled' });
    expect(disposeForRun).not.toHaveBeenCalled();
  });

  it('settled 来第二次不再回收 —— 本轮 runId 已经作废', async () => {
    const { fire } = attach('t1');
    await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    fire({ type: 'agent_settled' });
    fire({ type: 'agent_settled' });
    expect(disposeForRun).toHaveBeenCalledTimes(1);
  });

  it('两条 thread 各回收各的', async () => {
    const a = attach('t1');
    const b = attach('t2');
    const ra = await agentService.send('t1', '/x', '甲');
    const rb = await agentService.send('t2', '/x', '乙');
    expect(ra.runId).not.toBe(rb.runId);

    a.fire({ type: 'agent_start' });
    a.fire(AGENT_END);
    a.fire({ type: 'agent_settled' });
    expect(disposeForRun.mock.calls).toEqual([[ra.runId]]);

    b.fire({ type: 'agent_start' });
    b.fire(AGENT_END);
    b.fire({ type: 'agent_settled' });
    expect(disposeForRun.mock.calls).toEqual([[ra.runId], [rb.runId]]);
  });
});

/**
 * `currentRunIdFor` 是浏览器工具给新标签盖的那个戳（`ownerRunId`）。它与上面的
 * `disposeForRun` **必须读同一个事实**，否则开标签用 A、回收用 B，回收永远命中不了。
 *
 * 所以它读的是 `bound.runId` 而不是现算 `runs` —— pi 自动重试那一段 `runs` 已经是
 * idle，现算会得到 `null`，那期间新开的标签会被记成**用户的**，回合结束永不回收。
 */
describe('currentRunIdFor：浏览器工具给标签盖的戳', () => {
  it('run 在飞时 = send() 铸出的 runId', async () => {
    attach('t1');
    const { runId } = await agentService.send('t1', '/x', '你好');
    expect(agentService.currentRunIdFor('t1')).toBe(runId);
  });

  it('agent_end 之后（pi 的重试窗口）仍是同一个 runId —— 这段时间开的标签也归本轮', async () => {
    const { fire } = attach('t1');
    const { runId } = await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    expect(agentService.getRunState('t1').status).toBe('idle');
    expect(agentService.currentRunIdFor('t1')).toBe(runId);
  });

  it('settled 之后回 null —— 此后开的标签是用户的', async () => {
    const { fire } = attach('t1');
    await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    fire({ type: 'agent_settled' });
    expect(agentService.currentRunIdFor('t1')).toBeNull();
  });

  it('没有这条 session → null，不抛', () => {
    expect(agentService.currentRunIdFor('没见过的 thread')).toBeNull();
  });

  it('开标签的戳与回收的判据是同一个值', async () => {
    const { fire } = attach('t1');
    await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    const stamped = agentService.currentRunIdFor('t1');
    fire(AGENT_END);
    fire({ type: 'agent_settled' });
    expect(disposeForRun.mock.calls).toEqual([[stamped]]);
  });
});
