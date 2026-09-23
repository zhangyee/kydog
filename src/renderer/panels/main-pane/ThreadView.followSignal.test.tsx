import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere } from '../../../test-support/miniReact';

/**
 * **ThreadView 交给 `useAutoScroll` 的 jumpSignal，以及「跳到最新」那颗按钮的出现条件。**
 *
 * 跳底的 override 由 jumpSignal 变化触发（判定本身见 useAutoScroll.test.ts）。这个数**只算
 * 用户自己发出的消息**：按了发送就该看到它落在最新。助手那边无论吐多少段文字、跑多少个工具，
 * 这个数一动不动 —— 正在往回翻的人不会被弹回底部，贴着底的人照旧由 `afterRender` 跟随。
 *
 * 2026-09-23 之前它连 assistant 的 text block 一起数，于是 skill 跑长活时每落一段新文字就跳一次底，
 * 用户翻回去看前面的输出根本看不住。下面第一条用例就是那次行为的回归点。
 *
 * 喂的是真的 `applyRunEvent`（渲染层实际收到的协议事件），再挂载 ThreadView，读它**真的传给
 * hook 的那个数**；hook 本身换成记录参数的替身（miniReact 的假 ref 元素没有 addEventListener，
 * 同 narrowMode.test.tsx），顺便用它的返回值控制按钮该不该出现。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const seen = vi.hoisted(() => [] as Array<{ ref: { current: unknown }; jumpSignal: number; threadId: string }>);
const follow = vi.hoisted(() => ({ following: true, jumpToBottom: () => {} }));

vi.mock('./useAutoScroll', () => ({
  useAutoScroll: (ref: { current: unknown }, jumpSignal: number, threadId: string) => {
    seen.push({ ref, jumpSignal, threadId });
    return follow;
  },
}));

function directRead<M extends Record<string, unknown>>(mod: M, key: keyof M & string): M {
  const real = mod[key] as unknown as { getState: () => unknown };
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as M[typeof key];
  Object.assign(hook as object, real);
  return { ...mod, [key]: hook };
}

vi.mock('../../stores/threadsStore', async (o) => directRead(await o<typeof import('../../stores/threadsStore')>(), 'useThreadsStore'));
vi.mock('../../stores/runsStore', async (o) => directRead(await o<typeof import('../../stores/runsStore')>(), 'useRunsStore'));
vi.mock('../../stores/askStore', async (o) => directRead(await o<typeof import('../../stores/askStore')>(), 'useAskStore'));
vi.mock('../../stores/uiStore', async (o) => directRead(await o<typeof import('../../stores/uiStore')>(), 'useUiStore'));

const { ThreadView } = await import('./ThreadView');
const { MessageList } = await import('./MessageList');
const { JumpToLatest } = await import('./JumpToLatest');
const { applyRunEvent } = await import('../../runEvents');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useRunsStore } = await import('../../stores/runsStore');

const TID = 'thr-1';
const RID = 'run-1';
const MID = 'thr-1:msg-1';

/** 最近一次渲染交给 hook 的 jumpSignal。先断言这次渲染真的发生了（hook 真的被调用了）。 */
function signalAfter(render: () => void): number {
  const n = seen.length;
  render();
  expect(seen.length).toBeGreaterThan(n);
  const last = seen[seen.length - 1];
  expect(last.threadId).toBe(TID);
  return last.jumpSignal;
}

function blockKinds(): string[] {
  return (useRunsStore.getState().bufferByMessage[MID]?.blocks ?? []).map((b) => b.kind);
}

beforeEach(() => {
  seen.length = 0;
  follow.following = true;
  follow.jumpToBottom = () => {};
  useRunsStore.setState(useRunsStore.getInitialState());
  useThreadsStore.setState({
    ...useThreadsStore.getInitialState(),
    historyByThread: {
      [TID]: [{ id: 'u1', role: 'user', createdAt: '2026-09-18T00:00:00Z', content: 'test' }],
    },
  });
});

describe('ThreadView 交给 useAutoScroll 的 jumpSignal', () => {
  it('助手吐文字、跑工具、整轮落进历史，都不改变它', () => {
    const m = mount(ThreadView, { threadId: TID });
    expect(seen[seen.length - 1].jumpSignal).toBe(1);   // 只有那条 user 消息

    applyRunEvent({ topic: 'run.started', payload: { threadId: TID, runId: RID } });
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: 'PHASE1' } });
    // 前提：文字真的进了 buffer（不然「不变」是因为什么都没发生）
    expect(blockKinds()).toEqual(['text']);
    expect(signalAfter(() => m.rerender({ threadId: TID }))).toBe(1);

    applyRunEvent({ topic: 'run.tool_call_start', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 't1', name: 'bash', command: 'find .' } });
    applyRunEvent({ topic: 'run.tool_call_chunk', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 't1', stream: 'stdout', chunk: 'out\n' } });
    applyRunEvent({ topic: 'run.tool_call_end', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: 't1', status: 'ok', exitCode: 0 } });
    expect(signalAfter(() => m.rerender({ threadId: TID }))).toBe(1);

    // 工具之后的新一段文字：这正是旧实现会跳底的那一刻
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: 'PHASE2' } });
    expect(blockKinds()).toEqual(['text', 'tool_call', 'text']);
    expect(signalAfter(() => m.rerender({ threadId: TID }))).toBe(1);

    // 整轮落进历史：历史里多了一条 assistant 消息（含两个 text block），照样不算
    applyRunEvent({ topic: 'run.message_end', payload: { threadId: TID, runId: RID, messageId: MID } });
    expect(useThreadsStore.getState().historyByThread[TID]).toHaveLength(2);
    expect(signalAfter(() => m.rerender({ threadId: TID }))).toBe(1);
  });

  it('用户发出新的一条 → +1（上一条用例的正向对照：这个数不是恒定不动的）', () => {
    const m = mount(ThreadView, { threadId: TID });
    expect(seen[seen.length - 1].jumpSignal).toBe(1);

    useThreadsStore.setState((s) => ({
      historyByThread: {
        ...s.historyByThread,
        [TID]: [...(s.historyByThread[TID] ?? []), { id: 'u2', role: 'user', createdAt: '2026-09-18T00:01:00Z', content: '再来' }],
      },
    }));
    expect(signalAfter(() => m.rerender({ threadId: TID }))).toBe(2);
  });

  it('交给 hook 的 ref 就是交给 MessageList 的那一个（同一个对象，不是等价物）', () => {
    const m = mount(ThreadView, { threadId: TID });
    const list = findAllWhere(m.tree as never, (el) => el.type === MessageList)[0];
    expect(list).toBeDefined();
    expect(list.props.scrollRef).toBe(seen[seen.length - 1].ref);
  });
});

describe('「跳到最新」按钮', () => {
  const buttons = (tree: unknown) => findAllWhere(tree as never, (el) => el.type === JumpToLatest);

  it('没贴底才出现；贴底时不在场', () => {
    follow.following = false;
    const away = mount(ThreadView, { threadId: TID });
    expect(buttons(away.tree)).toHaveLength(1);

    follow.following = true;
    const atBottom = mount(ThreadView, { threadId: TID });
    expect(buttons(atBottom.tree)).toHaveLength(0);
  });

  it('按钮点下去调的就是 hook 给的 jumpToBottom', () => {
    const jump = vi.fn();
    follow.following = false;
    follow.jumpToBottom = jump;
    const m = mount(ThreadView, { threadId: TID });
    buttons(m.tree)[0].props.onClick();
    expect(jump).toHaveBeenCalledTimes(1);
  });
});
