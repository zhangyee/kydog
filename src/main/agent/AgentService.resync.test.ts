import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));

import { broadcaster } from '../ipc/broadcaster';
import { agentService } from './AgentService';
import type { RunEvent } from '../../shared/protocol';

type Listener = (evt: { type: string; [k: string]: unknown }) => void;
type PiMsg = { role: string; [k: string]: unknown };

/**
 * 假 session：messages 就是 pi 的 transcript，测试里手动推进它，模拟 pi 在
 * message_end 时把消息 push 进 state 的行为。
 */
function attach(threadId: string, runId = 'r1') {
  let listener: Listener = () => undefined;
  const messages: PiMsg[] = [];
  const bound = {
    threadId, providerId: 'anthropic', modelId: 'm', cwd: '/x',
    activeMessageId: null as string | null,
    askOpened: new Set<string>(),
    askArgs: new Map<string, { toolName: string; args: unknown }>(),
    runJournal: [] as RunEvent[],
    runStartIndex: null as number | null,
    session: {
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
      state: { messages },
      subscribe: (l: Listener) => { listener = l; return () => undefined; },
    },
  };
  (agentService as any).sessions.set(threadId, bound);
  (agentService as any).runs.set(threadId, { status: 'running', runId, abortRequested: false });
  (agentService as any).subscribe(bound);
  return {
    bound, messages,
    fire: (evt: { type: string; [k: string]: unknown }) => listener(evt),
  };
}

const userMsg = (text: string): PiMsg => ({ role: 'user', content: [{ type: 'text', text }] });
const assistantWithCalls = (ids: string[]): PiMsg => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: `fastpaper ${id}` } })),
});

describe('AgentService — 在途 run 的重放', () => {
  beforeEach(() => {
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
    (broadcaster.emit as any).mockClear();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('并行批次里已结束的工具，终态留在 journal 里 —— transcript 上还看不出来', () => {
    const { bound, messages, fire } = attach('t1');
    fire({ type: 'agent_start' });
    messages.push(userMsg('查一下'));
    const batch = ['a', 'b', 'c'];
    messages.push(assistantWithCalls(batch));
    fire({ type: 'message_end', message: assistantWithCalls(batch) });
    for (const id of batch) fire({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: `fastpaper ${id}` } });
    // pi 的并行分支：每个工具各自 tool_execution_end，但 toolResult 消息要等整批 settle
    // 才追加 —— 所以此刻 transcript 上三个工具都还是「没有 toolResult」。
    fire({ type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', isError: false, result: 'ok-a' });
    fire({ type: 'tool_execution_end', toolCallId: 'b', toolName: 'bash', isError: true, result: 'boom-b' });

    const ends = bound.runJournal.filter((e) => e.topic === 'run.tool_call_end');
    expect(ends.map((e) => (e.payload as { toolCallId: string }).toolCallId)).toEqual(['a', 'b']);
    expect(ends.map((e) => (e.payload as { status: string }).status)).toEqual(['ok', 'failed']);
    // 归属信息在源头就带上了
    expect(ends.every((e) => (e.payload as { messageId: string }).messageId === bound.activeMessageId)).toBe(true);
  });

  it('loadHistory 摘掉 in-flight turn，并把 resync + journal 按序重放给调用方', async () => {
    const { bound, messages, fire } = attach('t1');
    // 上一轮已经落定
    messages.push(userMsg('第一问'), { role: 'assistant', content: [{ type: 'text', text: '第一答' }] });

    fire({ type: 'agent_start' });
    expect(bound.runStartIndex).toBe(2);
    messages.push(userMsg('第二问'));
    messages.push(assistantWithCalls(['a']));
    fire({ type: 'message_end', message: assistantWithCalls(['a']) });
    fire({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: { command: 'fastpaper a' } });

    const replayed: RunEvent[] = [];
    const history = await agentService.loadHistory('t1', '/x', (e) => replayed.push(e as RunEvent));

    // 历史只到本轮的 user 消息为止：assistant 那半截由重放的事件在渲染层重建
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(history[2]).toMatchObject({ role: 'user', content: '第二问' });

    // 重放的第一帧是 resync，随后是本轮 journal 的原样序列
    expect(replayed[0].topic).toBe('run.resync');
    expect(replayed[0].payload).toEqual({ threadId: 't1', runId: 'r1' });
    // 重放的事件本身带着归属，渲染层不必从 resync 里猜是哪一轮
    expect(replayed[2].payload).toMatchObject({ messageId: bound.activeMessageId });
    expect(replayed.slice(1).map((e) => e.topic)).toEqual(['run.started', 'run.tool_call_start']);
  });

  it('没有 run 在飞时，loadHistory 返回完整历史、不重放', async () => {
    const { messages } = attach('t1');
    (agentService as any).runs.set('t1', { status: 'idle' });
    messages.push(userMsg('问'), { role: 'assistant', content: [{ type: 'text', text: '答' }] });

    const replayed: RunEvent[] = [];
    const history = await agentService.loadHistory('t1', '/x', (e) => replayed.push(e as RunEvent));

    expect(replayed).toEqual([]);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('journal 绑在一轮 run 上：agent_start 清空，agent_end 清空', () => {
    const { bound, fire } = attach('t1');
    fire({ type: 'agent_start' });
    fire({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: {} });
    expect(bound.runJournal.length).toBeGreaterThan(0);

    fire({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });
    expect(bound.runJournal).toEqual([]);
    expect(bound.runStartIndex).toBeNull();
    // run.ended 本身不进 journal
    expect((broadcaster.emit as any).mock.calls.some((c: unknown[]) => c[0] === 'run.ended')).toBe(true);

    fire({ type: 'agent_start' });
    expect(bound.runJournal.map((e) => e.topic)).toEqual(['run.started']);
  });

  it('归一化的 message id 是确定性的：同一份 transcript 两次得到同一批 id', async () => {
    const { messages } = attach('t1');
    (agentService as any).runs.set('t1', { status: 'idle' });
    messages.push(userMsg('问'), { role: 'assistant', content: [{ type: 'text', text: '答' }] });

    const a = await agentService.loadHistory('t1', '/x');
    const b = await agentService.loadHistory('t1', '/x');
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
    expect(a.map((m) => m.id)).toEqual(['t1#0', 't1#1']);
  });
});
