import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type FakeElement } from '../../../test-support/miniReact';

/**
 * **MessageList 交给 `useAutoScroll` 的 tailSignal。**
 *
 * 替代 e2e/29-auto-scroll 的「接线」那一半：跳底 override 由 tailSignal 变化触发
 * （判定本身见 useAutoScroll.test.ts），而 tailSignal 由 MessageList 数出来 ——
 * user message 与 kind:'text' block 各算 1。e2e 那条的主张落在这里就是：
 * - 工具在跑（tool_call 块进来、输出一块块追加）时 tailSignal **不变** —— 所以翻走的用户不被拽回底部；
 * - 工具之后的新一段文字（一个新的 text block）让它 **+1** —— 所以那一刻跳底；
 * - 同一个 text block 上继续追加 delta 不变（否则流式输出每个字都跳底，free-read 形同虚设）。
 *
 * 喂的是真的 `applyRunEvent`（渲染层实际收到的协议事件），再挂载 MessageList，
 * 读它**真的传给 hook 的那个数**；hook 本身换成记录参数的替身（miniReact 的假 ref 元素
 * 没有 addEventListener，同 narrowMode.test.tsx）。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const seen = vi.hoisted(() => [] as Array<{ ref: { current: unknown }; tailSignal: number; threadId: string }>);

vi.mock('./useAutoScroll', () => ({
  useAutoScroll: (ref: { current: unknown }, tailSignal: number, threadId: string) => { seen.push({ ref, tailSignal, threadId }); },
}));

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

vi.mock('../../stores/askStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/askStore')>();
  const real = mod.useAskStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useAskStore: hook };
});

vi.mock('../../stores/identityStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/identityStore')>();
  const real = mod.useIdentityStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useIdentityStore: hook };
});

vi.mock('../../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

const { MessageList } = await import('./MessageList');
const { applyRunEvent } = await import('../../runEvents');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useRunsStore } = await import('../../stores/runsStore');

const TID = 'thr-1';
const OTHER = 'thr-2';
const RID = 'run-1';
const MID = 'thr-1:msg-1';

/** 最近一次渲染交给 hook 的 tailSignal。先断言这次渲染真的发生了（hook 真的被调用了）。 */
function tailAfter(render: () => void): number {
  const n = seen.length;
  render();
  expect(seen.length).toBeGreaterThan(n);
  const last = seen[seen.length - 1];
  expect(last.threadId).toBe(TID);
  return last.tailSignal;
}

function blockKinds(): string[] {
  return (useRunsStore.getState().bufferByMessage[MID]?.blocks ?? []).map((b) => b.kind);
}

beforeEach(() => {
  seen.length = 0;
  useRunsStore.setState(useRunsStore.getInitialState());
  useThreadsStore.setState({
    ...useThreadsStore.getInitialState(),
    historyByThread: {
      [TID]: [{ id: 'u1', role: 'user', createdAt: '2026-09-18T00:00:00Z', content: 'test' }],
    },
  });
});

describe('MessageList 交给 useAutoScroll 的 tailSignal', () => {
  it('工具在跑时不变、工具之后的新一段文字 +1；同一段文字续写不变；进历史后不重复计', () => {
    applyRunEvent({ topic: 'run.started', payload: { threadId: TID, runId: RID } });
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: 'PHASE1_START\n' } });
    const m = mount(MessageList, { threadId: TID });
    // 交给 hook 的 ref 挂在真正滚动的那个容器上（miniReact 挂 ref 时记下了它的 testid）
    expect((seen[seen.length - 1].ref.current as FakeElement | null)?.testId).toBe('message-list');
    // user message 1 + text block 1
    expect(seen[seen.length - 1].tailSignal).toBe(2);

    // 同一个 text block 上续写：块数不变，tailSignal 不变
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: 'PHASE1_END' } });
    expect(blockKinds()).toEqual(['text']);
    expect(tailAfter(() => m.rerender({ threadId: TID }))).toBe(2);

    // 工具阶段：块在长、tailSignal 不动
    applyRunEvent({ topic: 'run.tool_call_start', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 't1', name: 'bash', command: 'find .' } });
    applyRunEvent({ topic: 'run.tool_call_chunk', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 't1', stream: 'stdout', chunk: 'tool-output-1\n' } });
    // 前提：工具块真的进了 buffer（不然「不变」是因为什么都没发生）
    expect(blockKinds()).toEqual(['text', 'tool_call']);
    expect(tailAfter(() => m.rerender({ threadId: TID }))).toBe(2);
    applyRunEvent({ topic: 'run.tool_call_end', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 't1', status: 'ok', exitCode: 0 } });
    expect(tailAfter(() => m.rerender({ threadId: TID }))).toBe(2);

    // 别的对话里冒出来的文字不算进这一条
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: OTHER, runId: 'run-2', messageId: 'thr-2:msg-1', delta: '别处' } });
    expect(tailAfter(() => m.rerender({ threadId: TID }))).toBe(2);

    // 工具之后的新一段文字 = 新的 text block → +1（这一刻跳底）
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: 'PHASE2_TEXT' } });
    expect(blockKinds()).toEqual(['text', 'tool_call', 'text']);
    expect(tailAfter(() => m.rerender({ threadId: TID }))).toBe(3);

    // 这一轮落进历史：buffer 里没了、历史里有了，只计一次
    applyRunEvent({ topic: 'run.message_end', payload: { threadId: TID, runId: RID, messageId: MID } });
    expect(useRunsStore.getState().bufferByMessage[MID]).toBeUndefined();
    expect(useThreadsStore.getState().historyByThread[TID]).toHaveLength(2);
    expect(tailAfter(() => m.rerender({ threadId: TID }))).toBe(3);
  });

  it('用户发出新的一条 → +1', () => {
    const m = mount(MessageList, { threadId: TID });
    expect(seen[seen.length - 1].tailSignal).toBe(1);

    useThreadsStore.setState((s) => ({
      historyByThread: {
        ...s.historyByThread,
        [TID]: [...(s.historyByThread[TID] ?? []), { id: 'u2', role: 'user', createdAt: '2026-09-18T00:01:00Z', content: '再来' }],
      },
    }));
    expect(tailAfter(() => m.rerender({ threadId: TID }))).toBe(2);
  });
});
