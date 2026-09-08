import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
// 替身掉整个 browserService：真的那一个 import 的是 electron 的 WebContentsView / session。
vi.mock('../browser/browserService', () => ({
  browserService: { disposeForRun: vi.fn() },
}));

import { agentService } from './AgentService';
import { browserService } from '../browser/browserService';
import { logger } from '../log';

type Listener = (evt: { type: string; [k: string]: unknown }) => void;

const disposeForRun = browserService.disposeForRun as unknown as ReturnType<typeof vi.fn>;

/**
 * 造一个假 session 并挂上订阅。手法照 AgentService.parallel.test.ts —— 直接往私有
 * map 里塞 bound。**runs 故意不预置**：本文件考的正是 runId 从 `send()` 铸出来之后
 * 一路活到 `agent_settled` 这条链。
 */
function attach(threadId: string, opts: {
  /** 默认立刻 resolve。传一个会 reject / 迟迟不落地的，用来考 send() 的错误出口。 */
  prompt?: () => Promise<void>;
  /** 传了才有 cleanup（AgentService 优先用它、否则回退 dispose）。用来撑开 await 窗口。 */
  cleanup?: () => Promise<void>;
} = {}) {
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
      prompt: vi.fn(opts.prompt ?? (async () => {})),
      cleanup: opts.cleanup,
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

/** 把挂在 promise 上的 catch 回调放出来跑完（宏任务一轮，微任务队列必然清空）。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

/**
 * **同一族的第三个洞。**
 *
 * `disposeForRun` 全仓只有 `agent_settled` 一个触发点，而 `agent_settled` 是 pi 的 session
 * 发的 —— session 一拆，本轮就再也不会 settle。两条真实入口都能落进 pi 的重试窗口
 * （`agent_end` 之后、`agent_settled` 之前，那一刻 `runs` 已经是 idle）：
 *  · `threadService.delete` 无条件 `dispose(threadId)`；
 *  · `localeSet` 通过 `disposeAllSessions()`。
 * 不在 `dispose` 里补一次回收，那些标签的 `ownerRunId` 就再也没人 settle，
 * 此后任何一轮的 `disposeForRun` 都命中不了，它们占着 MAX_TABS 的名额活到进程退出。
 */
describe('dispose(thread)：session 拆了，本轮标签在这里最后回收一次', () => {
  it('pi 的重试窗口里 dispose（删线程 / 切语言都走这条）→ 回收的是本轮那个 runId', async () => {
    const { fire } = attach('t1');
    const { runId } = await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    // 这一刻现算 runId 是 'unknown'（runs 已回 idle）—— 正是前两个洞的那一步。
    expect(agentService.getRunState('t1').status).toBe('idle');

    await agentService.dispose('t1');
    expect(disposeForRun.mock.calls).toEqual([[runId]]);
  });

  it('run 正在飞时 dispose 也回收（abort 之后立刻删线程）', async () => {
    attach('t1');
    const { runId } = await agentService.send('t1', '/x', '你好');
    await agentService.dispose('t1');
    expect(disposeForRun.mock.calls).toEqual([[runId]]);
  });

  it('回收用的戳与浏览器工具盖的是同一个值', async () => {
    const { fire } = attach('t1');
    await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    const stamped = agentService.currentRunIdFor('t1');
    fire(AGENT_END);
    await agentService.dispose('t1');
    expect(disposeForRun.mock.calls).toEqual([[stamped]]);
  });

  it('settled 已经回收过了，再 dispose 不重复回收', async () => {
    const { fire } = attach('t1');
    const { runId } = await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    fire({ type: 'agent_settled' });
    await agentService.dispose('t1');
    expect(disposeForRun.mock.calls).toEqual([[runId]]);
  });

  it('没 send 过的 session dispose 一次都不调（不许拿 null 空跑一遍）', async () => {
    attach('t1');
    await agentService.dispose('t1');
    expect(disposeForRun).not.toHaveBeenCalled();
  });

  it('没见过的 thread dispose：不抛也不回收', async () => {
    await agentService.dispose('没见过的 thread');
    expect(disposeForRun).not.toHaveBeenCalled();
  });

  /**
   * `dispose` 里那句 `bound.runId = null` 防的就是这一格：它排在
   * `await bound.session.cleanup()` **之前**，所以 cleanup 还没落地、订阅还挂着的那段时间里
   * 打进来的 `agent_settled` 读到的已经是 null，不会再回收第二次。
   * （账本层本来就幂等，所以这是一道防御线；没有这条用例它零守护。）
   */
  it('cleanup 那个 await 窗口里 settled 打进来 → 只回收一次，不重复', async () => {
    let finishCleanup!: () => void;
    const { fire } = attach('t1', { cleanup: () => new Promise<void>((res) => { finishCleanup = res; }) });
    const { runId } = await agentService.send('t1', '/x', '你好');
    const pending = agentService.dispose('t1');
    fire({ type: 'agent_settled' });
    finishCleanup();
    await pending;
    expect(disposeForRun.mock.calls).toEqual([[runId]]);
  });

  it('disposeAllSessions（切界面语言那条路）：两条 thread 各回收各的', async () => {
    const a = attach('t1');
    attach('t2');
    const ra = await agentService.send('t1', '/x', '甲');
    const rb = await agentService.send('t2', '/x', '乙');
    // t1 落在 pi 的重试窗口里（runs 已回 idle），t2 还在飞 —— 两种都要回收。
    a.fire({ type: 'agent_start' });
    a.fire(AGENT_END);

    await agentService.disposeAllSessions();
    expect([...disposeForRun.mock.calls].sort()).toEqual([[ra.runId], [rb.runId]].sort());
  });
});

/**
 * `locale.set` 那道闸（`localeSet.ts` 的 `deps.hasActiveRun()`）读的必须也是 `bound.runId`。
 * 读现算的 `runs`，用户在 pi 自动重试期间切语言就会被放行 —— 而那段代码的注释写明
 * 前提是「切换时没有 run 在跑」，此时 pi 手上那一轮还在飞。
 */
describe('hasActiveRun：闸读的是 bound.runId，不是现算的 runs', () => {
  it('重试窗口里仍算「有 run 在飞」—— 那一刻 runs 已经是 idle', async () => {
    const { fire } = attach('t1');
    await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    expect(agentService.getRunState('t1').status).toBe('idle');
    expect(agentService.hasActiveRun()).toBe(true);
  });

  it('settled 之后才算没有 —— 与回收是同一时刻', async () => {
    const { fire } = attach('t1');
    await agentService.send('t1', '/x', '你好');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    fire({ type: 'agent_settled' });
    expect(agentService.hasActiveRun()).toBe(false);
  });

  it('从没 send 过的 session 不算', () => {
    attach('t1');
    expect(agentService.hasActiveRun()).toBe(false);
  });
});

/**
 * **同一族的第四个洞：`prompt()` 一 reject，`bound.runId` 就再也没人清。**
 *
 * pi 那侧不会兜底：`agent_settled` 唯一的发出点是 `_emitAgentSettled()`，只在
 * `_runAgentPrompt` 的 `finally` 里调（`agent-session.js:755`），而 `prompt()` 的 catch
 * （`:792`）排在 `_runAgentPrompt` 被 await 之前 —— 没选模型（`:844`）、OAuth 凭据过期
 * （`:851`）、没有 API key（`:856`）、压缩失败（`:861`）、`before_agent_start` 扩展抛错
 * （`:884`）这几条路径都是「reject 了但 session 从没 settle 过」。
 * **不是边角**：首次运行没配好 key、token 过期都是日常路径。
 *
 * 所以本轮必须在 `send()` 的 catch 里就地落地，与另外两个出口（`agent_settled`、
 * `dispose`）同形：清掉戳、回收本轮的标签。漏了这一手，`hasActiveRun()` 会永远为真，
 * 用户此后在设置里切界面语言一律被拒（提示「有任务正在运行」而根本没有任务在跑），
 * 只能靠重发一条 / 删线程 / 重启应用恢复。
 */
describe('send() 的 prompt reject：pi 不补发 agent_settled，本轮在这里落地', () => {
  beforeEach(() => { vi.spyOn(logger, 'error').mockImplementation(() => undefined); });

  it('reject 之后闸开得回来 —— 否则切界面语言从此永久被拒', async () => {
    const { bound } = attach('t1', { prompt: async () => { throw new Error('no API key'); } });
    await agentService.send('t1', '/x', '你好');
    await flush();
    // KyDog 这一侧已经判定这轮结束了（界面上是一条错误、没有转圈）……
    expect(agentService.getRunState('t1').status).toBe('error');
    // ……那么闸与戳就必须跟着落地。
    expect(bound.runId).toBeNull();
    expect(agentService.hasActiveRun()).toBe(false);
    expect(agentService.currentRunIdFor('t1')).toBeNull();
  });

  it('本轮的标签在这里回收 —— settled 永远不会来，这是最后一次机会', async () => {
    attach('t1', { prompt: async () => { throw new Error('OAuth 凭据已过期'); } });
    const { runId } = await agentService.send('t1', '/x', '你好');
    await flush();
    expect(disposeForRun.mock.calls).toEqual([[runId]]);
  });

  it('迟到的 reject 只清自己那一轮，不许把下一轮的戳一起抹掉', async () => {
    const rejects: Array<(e: Error) => void> = [];
    const { fire } = attach('t1', { prompt: () => new Promise<void>((_, rj) => { rejects.push(rj); }) });
    const first = await agentService.send('t1', '/x', '甲');
    fire({ type: 'agent_start' });
    fire(AGENT_END);
    fire({ type: 'agent_settled' });                             // 第一轮正常收尾，标签已回收
    const second = await agentService.send('t1', '/x', '乙');     // 新一轮盖上新戳
    expect(second.runId).not.toBe(first.runId);

    rejects[0](new Error('迟到的 reject'));                       // 第一轮那条 promise 现在才落地
    await flush();
    expect(agentService.currentRunIdFor('t1')).toBe(second.runId);
    expect(agentService.hasActiveRun()).toBe(true);
    expect(disposeForRun.mock.calls).toEqual([[first.runId]]);    // 没顺手把第二轮的标签也收了
  });
});
