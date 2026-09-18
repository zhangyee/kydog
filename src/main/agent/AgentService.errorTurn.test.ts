import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
// agent_end 在错误收场时会 logger.error 一条 —— 换成空实现。不换的话这份用例会往开发机
// 真实的 ~/.kydog/logs/main.log 里写一行假的 provider 报错，排查真实故障时会被它误导。
vi.mock('../log', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../log')>();
  return { ...mod, logger: new Proxy({}, { get: () => () => undefined }) };
});

import { broadcaster } from '../ipc/broadcaster';
import { agentService } from './AgentService';
import type { RunEvent } from '../../shared/protocol';

type Listener = (evt: { type: string; [k: string]: unknown }) => void;

/** 与 AgentService.resync.test.ts 同一个假 session 形态。 */
function attach(threadId: string, runId = 'r1') {
  let listener: Listener = () => undefined;
  const bound = {
    threadId, providerId: 'anthropic', modelId: 'm', cwd: '/x',
    activeMessageId: null as string | null,
    askOpened: new Set<string>(),
    askArgs: new Map<string, { toolName: string; args: unknown }>(),
    runJournal: [] as RunEvent[],
    runStartIndex: null as number | null,
    session: {
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
      state: { messages: [] as unknown[] },
      subscribe: (l: Listener) => { listener = l; return () => undefined; },
    },
  };
  (agentService as any).sessions.set(threadId, bound);
  (agentService as any).runs.set(threadId, { status: 'running', runId, abortRequested: false });
  (agentService as any).subscribe(bound);
  return { fire: (evt: { type: string; [k: string]: unknown }) => listener(evt) };
}

const payloadsOf = (topic: string): Array<Record<string, unknown>> =>
  (broadcaster.emit as unknown as { mock: { calls: Array<[string, Record<string, unknown>]> } })
    .mock.calls.filter(([t]) => t === topic).map(([, p]) => p);

/**
 * 以错误结束的一轮（2026-09-14 修的 bug）：错误原文要随这一轮的 `run.message_end` 交出去。
 *
 * `run.ended` 虽然也带 errorMessage，但它是**线程级**的收场信号，而且排在 message_end
 * 之后到达 —— 渲染层处理 message_end、把这一轮落进历史的那一刻还不知道它出错了。
 * 错误是这一轮的事实，就该跟这一轮的 message_end 一起走。
 */
describe('AgentService — 以错误结束的一轮，错误原文随 run.message_end 交给这一轮', () => {
  beforeEach(() => {
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
    (broadcaster.emit as any).mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // 两条 thread 放在同一条用例里：先证明「出错的那一轮带着 errorMessage」，再断「正常
  // 结束的一轮连这个键都没有」。只写后一半的话，「从来不带」这种坏实现也会让它绿。
  it('出错的一轮 run.message_end 带 errorMessage；正常结束的一轮连这个键都没有', () => {
    const failed = attach('t1');
    failed.fire({ type: 'agent_start' });
    failed.fire({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider rejected (test)' }],
    });

    const ok = attach('t2');
    ok.fire({ type: 'agent_start' });
    ok.fire({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '好的' }], stopReason: 'stop' }],
    });

    const byThread = new Map(payloadsOf('run.message_end').map((p) => [p.threadId, p]));
    expect(byThread.get('t1')).toMatchObject({ errorMessage: 'provider rejected (test)' });
    // 键不在，而不只是值为 undefined：journal 与重放按原样转发这份 payload。
    expect(byThread.get('t2')).toBeDefined();
    expect('errorMessage' in (byThread.get('t2') as object)).toBe(false);
  });

  // 判「这一轮出错了」看的是 stopReason，不是原文在不在。只在原文存在时才带这个键的话，
  // pi 没给原文的那种失败又会变回界面上什么都不显示。
  it('出错但 pi 没给原文：run.message_end 仍然带着 errorMessage 这个键', () => {
    const f = attach('t3');
    f.fire({ type: 'agent_start' });
    f.fire({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'error' }] });
    const p = payloadsOf('run.message_end').find((x) => x.threadId === 't3');
    expect(p).toHaveProperty('errorMessage');
  });
});
