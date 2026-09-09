import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
vi.mock('./resolveActive', () => ({
  resolveActive: vi.fn().mockResolvedValue({ providerId: 'anthropic', modelId: 'm' }),
}));
vi.mock('./sessionFactory', () => ({ createSession: vi.fn() }));

import { broadcaster } from '../ipc/broadcaster';
import { createSession } from './sessionFactory';
import { agentService } from './AgentService';
import { ASK_TOOL_NAME, type AskQuestion } from '../../shared/askQuestion';
import type { AskSharedState } from './askUserQuestionTool';

type Listener = (evt: { type: string; [k: string]: unknown }) => void;

const QUESTIONS: AskQuestion[] = [{
  id: 'q1', question: '走哪条路？', header: '路线',
  options: [
    { id: 'o1', label: 'A', description: '第一条' },
    { id: 'o2', label: 'B', description: '第二条' },
  ],
}];

/**
 * 走真的 ensureSession，这样拿到的是 AgentService 自己造的 askShared——
 * 工具的上行回调是本任务的核心，不能用测试里手写的替身冒充。
 */
async function setup(threadId = 't1') {
  let listener: Listener = () => undefined;
  let askShared!: AskSharedState;
  (createSession as any).mockImplementation(async (opts: { askShared: AskSharedState }) => {
    askShared = opts.askShared;
    return {
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
      subscribe: (l: Listener) => { listener = l; return () => undefined; },
    };
  });
  const bound = await agentService.ensureSession(threadId, '/p');
  bound.activeMessageId = `${threadId}:msg`;
  (agentService as any).runs.set(threadId, { status: 'running', runId: 'r1', abortRequested: false });
  (broadcaster.emit as any).mockClear();
  return { bound, askShared, fire: (evt: { type: string; [k: string]: unknown }) => listener(evt) };
}

function emitted(topic: string) {
  return (broadcaster.emit as any).mock.calls.filter((c: unknown[]) => c[0] === topic);
}

const askStart = (toolCallId: string, args: unknown) => ({
  type: 'tool_execution_start', toolCallId, toolName: ASK_TOOL_NAME, args,
});

const askEnd = (toolCallId: string, text: string) => ({
  type: 'tool_execution_end', toolCallId, toolName: ASK_TOOL_NAME,
  isError: true, result: { content: [{ type: 'text', text }] },
});

describe('AgentService 的 ask_user_question 事件分派', () => {
  beforeEach(() => {
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
    (broadcaster.emit as any).mockClear();
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('tool_execution_start 不产生任何对外事件——此时还没校验、broker 也没注册', async () => {
    const { fire } = await setup();
    fire(askStart('tc1', { questions: [] }));
    expect((broadcaster.emit as any).mock.calls).toHaveLength(0);
  });

  it('工具的 onOpened 才发 run.ask_start，带上 runId / messageId', async () => {
    const { askShared, bound } = await setup();
    askShared.onOpened('tc1', QUESTIONS);
    const starts = emitted('run.ask_start');
    expect(starts).toHaveLength(1);
    expect(starts[0][1]).toMatchObject({
      threadId: 't1', runId: 'r1', messageId: 't1:msg', toolCallId: 'tc1', questions: QUESTIONS,
    });
    expect(bound.askOpened.has('tc1')).toBe(true);
  });

  /**
   * 人机交接口（spec §4.5）。**不带的时候连这个键都不该出现** —— 一个值为
   * `undefined` 的键会原样进 run journal，重放时那一帧的形状与直播时不一样。
   */
  it('onOpened 给了 browserTabId 就带进 run.ask_start', async () => {
    const { askShared } = await setup();
    askShared.onOpened('tc1', QUESTIONS, 'tab_abc12345');
    expect(emitted('run.ask_start')[0][1]).toMatchObject({ browserTabId: 'tab_abc12345' });
  });

  it('没给 browserTabId 时载荷里根本没有这个键', async () => {
    const { askShared } = await setup();
    askShared.onOpened('tc1', QUESTIONS);
    expect('browserTabId' in (emitted('run.ask_start')[0][1] as object)).toBe(false);
  });

  it('工具的 onClosed 发 run.ask_end', async () => {
    const { askShared } = await setup();
    askShared.onOpened('tc1', QUESTIONS);
    askShared.onClosed('tc1', { kind: 'cancelled' });
    const ends = emitted('run.ask_end');
    expect(ends).toHaveLength(1);
    expect(ends[0][1]).toMatchObject({
      threadId: 't1', runId: 'r1', messageId: 't1:msg', toolCallId: 'tc1',
      outcome: { kind: 'cancelled' },
    });
  });

  it('开过提问的 tool_execution_end 不补发工具事件——结束已由 onClosed 发出', async () => {
    const { askShared, fire } = await setup();
    fire(askStart('tc1', { questions: [] }));
    askShared.onOpened('tc1', QUESTIONS);
    askShared.onClosed('tc1', { kind: 'answered', answers: [] });
    (broadcaster.emit as any).mockClear();
    fire(askEnd('tc1', 'whatever'));
    expect((broadcaster.emit as any).mock.calls).toHaveLength(0);
  });

  it('从没开过的 tool_execution_end 补发 start → chunk → end(failed)', async () => {
    const { fire } = await setup();
    fire(askStart('tc1', { questions: [{ question: '坏参数' }] }));
    fire(askEnd('tc1', 'questions[0].options 至少 2 项'));

    const starts = emitted('run.tool_call_start');
    expect(starts).toHaveLength(1);
    expect(starts[0][1]).toMatchObject({ toolCallId: 'tc1', name: ASK_TOOL_NAME });
    // 补发的 command 必须来自 start 缓存的 args——tool_execution_end 不带 args。
    expect(starts[0][1].command).toBe(JSON.stringify({ questions: [{ question: '坏参数' }] }));

    const chunks = emitted('run.tool_call_chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0][1]).toMatchObject({
      toolCallId: 'tc1', stream: 'stderr', chunk: 'questions[0].options 至少 2 项',
    });

    const ends = emitted('run.tool_call_end');
    expect(ends).toHaveLength(1);
    expect(ends[0][1]).toMatchObject({ toolCallId: 'tc1', status: 'failed' });
  });

  it('agent_end 清空 askOpened / askArgs，条目不跨轮残留', async () => {
    const { askShared, fire, bound } = await setup();
    fire(askStart('tc1', { questions: [] }));
    askShared.onOpened('tc1', QUESTIONS);
    expect(bound.askOpened.size).toBe(1);
    expect(bound.askArgs.size).toBe(1);

    fire({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });

    expect(bound.askOpened.size).toBe(0);
    expect(bound.askArgs.size).toBe(0);
  });

  it('tool_execution_end 从未到达时，agent_end 兜底清掉缓存的 args', async () => {
    // run 异常退出的形态：pi 发了 start 就没了下文，正常的清理点不会触发。
    const { fire, bound } = await setup();
    fire(askStart('tc1', { questions: [] }));
    expect(bound.askArgs.size).toBe(1);

    fire({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'boom' }] });

    expect(bound.askArgs.size).toBe(0);
  });

  it('普通工具照旧走 start / chunk / end，不受 ask 分支影响', async () => {
    const { fire } = await setup();
    fire({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'ls' } });
    fire({
      type: 'tool_execution_end', toolCallId: 'b1', toolName: 'bash',
      isError: false, result: { content: [{ type: 'text', text: 'out' }] },
    });
    expect(emitted('run.tool_call_start')[0][1]).toMatchObject({ toolCallId: 'b1', command: 'ls' });
    expect(emitted('run.tool_call_chunk')[0][1]).toMatchObject({ stream: 'stdout', chunk: 'out' });
    expect(emitted('run.tool_call_end')[0][1]).toMatchObject({ status: 'ok' });
  });
});
