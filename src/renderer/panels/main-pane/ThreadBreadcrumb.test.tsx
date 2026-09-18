import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type Mounted } from '../../../test-support/miniReact';

/**
 * 面包屑右侧「N 工具」要在运行中实时跟着涨。
 *
 * 一轮还在跑的时候，助手这条消息的块在 `runsStore.bufferByMessage` 里（`run.tool_call_start`
 * → `addToolCall`），要等 `run.message_end`（主进程在 agent_end 才发）才被 `takeBuffer` 挪进
 * `threadsStore.historyByThread`。只数历史的话，一轮跑多久计数就停在 0 多久，结束时一下跳上去。
 *
 * 用例喂的是真的 `applyRunEvent` —— 渲染层实际收到的那几条协议事件 —— 再挂载组件读它
 * 渲染出来的字，不是直接往 store 里摆 buffer。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 只把 React 订阅那一层换成直读，getState / setState 用真身（同 narrowMode.test.tsx）。
vi.mock('../../stores/threadsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useThreadsStore: hook };
});

vi.mock('../../stores/runsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/runsStore')>();
  const real = mod.useRunsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useRunsStore: hook };
});

const { ThreadBreadcrumb } = await import('./ThreadBreadcrumb');
const { applyRunEvent } = await import('../../runEvents');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useRunsStore } = await import('../../stores/runsStore');

const TID = 'thr-1';
const OTHER = 'thr-2';
const RID = 'run-1';
const MID = 'thr-1:msg-1';

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

function turnCount(m: Mounted<{ threadId: string }>): number {
  const match = /(\d+) 回合/.exec(textOf(m.find('thread-stats')));
  if (!match) throw new Error(`thread-stats 里没有「N 回合」：${textOf(m.find('thread-stats'))}`);
  return Number(match[1]);
}

function toolCount(m: Mounted<{ threadId: string }>): number {
  const match = /(\d+) 工具/.exec(textOf(m.find('thread-stats')));
  if (!match) throw new Error(`thread-stats 里没有「N 工具」：${textOf(m.find('thread-stats'))}`);
  return Number(match[1]);
}

beforeEach(() => {
  useRunsStore.setState(useRunsStore.getInitialState());
  useThreadsStore.setState({
    ...useThreadsStore.getInitialState(),
    threadsByProject: {
      '/p': [
        { id: TID, projectPath: '/p', title: '针灸核查', createdAt: '2026-09-17T00:00:00Z', lastActiveAt: '2026-09-17T00:00:00Z' },
        { id: OTHER, projectPath: '/p', title: '另一条', createdAt: '2026-09-17T00:00:00Z', lastActiveAt: '2026-09-17T00:00:00Z' },
      ],
    },
    historyByThread: {
      [TID]: [{ id: 'u1', role: 'user', createdAt: '2026-09-17T00:00:00Z', content: '帮我核查一下' }],
    },
  });
});

describe('面包屑的工具计数在运行中实时更新', () => {
  it('还没结束的这一轮里发起的工具立刻计入；这一轮落进历史之后不重复计', () => {
    applyRunEvent({ topic: 'run.started', payload: { threadId: TID, runId: RID } });
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: '开始核查。' } });
    const m = mount(ThreadBreadcrumb, { threadId: TID });
    expect(toolCount(m)).toBe(0);

    applyRunEvent({ topic: 'run.tool_call_start', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 'tc1', name: 'bash', command: 'fastpaper search pubmed x' } });
    applyRunEvent({ topic: 'run.tool_call_start', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 'tc2', name: 'bash', command: 'fastpaper search europepmc x' } });
    // 别的对话里在跑的工具不算进这一条
    applyRunEvent({ topic: 'run.tool_call_start', payload: { threadId: OTHER, runId: 'run-2', messageId: 'thr-2:msg-1', toolCallId: 'tc9', name: 'bash', command: 'ls' } });
    m.rerender({ threadId: TID });

    // 前提：这一轮确实还在跑，工具也确实还只在 buffer 里、不在历史里
    expect(m.query('run-status-running')).not.toBeNull();
    expect(useThreadsStore.getState().historyByThread[TID]).toHaveLength(1);
    expect(toolCount(m)).toBe(2);

    applyRunEvent({ topic: 'run.tool_call_end', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 'tc1', status: 'ok', exitCode: 0 } });
    applyRunEvent({ topic: 'run.tool_call_end', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 'tc2', status: 'ok', exitCode: 0 } });
    applyRunEvent({ topic: 'run.message_end', payload: { threadId: TID, runId: RID, messageId: MID } });
    m.rerender({ threadId: TID });

    // 前提：这一轮的两个工具块已经挪进历史，buffer 里不再有这条消息
    const history = useThreadsStore.getState().historyByThread[TID] ?? [];
    expect(history).toHaveLength(2);
    expect(useRunsStore.getState().bufferByMessage[MID]).toBeUndefined();
    expect(toolCount(m)).toBe(2);
  });
});

/**
 * 「回合」是一问一答算一次，数的是用户发出的消息。
 *
 * 以前数的是历史里的消息条数：用户那条一发出就在历史里（Composer 直接追加），助手那条要等
 * 本轮结束才进来 —— 于是运行中显示 1 回合，结束一下跳成 2，问答两轮显示 4。
 */
describe('面包屑的回合数是一问一答算一次', () => {
  it('运行中与结束后都是 1 回合；第二问发出后是 2 回合', () => {
    applyRunEvent({ topic: 'run.started', payload: { threadId: TID, runId: RID } });
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: '开始核查。' } });
    const m = mount(ThreadBreadcrumb, { threadId: TID });
    expect(m.query('run-status-running')).not.toBeNull();
    expect(turnCount(m)).toBe(1);

    applyRunEvent({ topic: 'run.message_end', payload: { threadId: TID, runId: RID, messageId: MID } });
    m.rerender({ threadId: TID });
    // 前提：助手这条已经进了历史，历史里现在有两条消息
    expect(useThreadsStore.getState().historyByThread[TID]).toHaveLength(2);
    expect(turnCount(m)).toBe(1);

    useThreadsStore.setState((s) => ({
      historyByThread: {
        ...s.historyByThread,
        [TID]: [...(s.historyByThread[TID] ?? []), { id: 'u2', role: 'user', createdAt: '2026-09-17T00:01:00Z', content: '再补一补' }],
      },
    }));
    m.rerender({ threadId: TID });
    expect(turnCount(m)).toBe(2);
  });
});
