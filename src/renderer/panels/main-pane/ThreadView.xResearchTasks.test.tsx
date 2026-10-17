import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';
import type { XResearchTaskSnapshot } from '../../../shared/xResearchTask';

/**
 * **进对话时把 x research 的整批快照拉回来（R63）。**
 *
 * 快照池里那几行不是 journal 的一部分：它们在主进程的 x research 服务里另存一份，
 * `thread.loadHistory` 的重放带不回来。所以开对话时（渲染层唯一那条开对话生命周期，
 * 就是 ThreadView 里那次 `thread.loadHistory`）补拉一次 `xResearch.taskList`，之后靠
 * `xResearch.taskUpdated` 广播跟。
 *
 * 两条守的东西：
 *  1. 拉回来的列表**不能把更晚的广播降级** —— 列表是读盘算出来的，算它的时候广播一直在推
 *     revision（store 的 `replaceThread` 会保留更高的那份，这里守的是「代码真的走它」）；
 *  2. `taskList` 抛错不许把对话挡在「加载中」。未接线时服务答空列表，但接线回归、闸门拒绝
 *     都会真抛，那些时候历史照样得开。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 历史落地后消息列表会挂到 scrollRef 上，而 miniReact 的假元素没有 addEventListener
// （同 narrowMode.test.tsx）。这份用例只看 RPC 与池子，滚动行为整个换成 no-op。
vi.mock('./useAutoScroll', () => ({ useAutoScroll: () => ({ following: true, jumpToBottom: () => {} }) }));

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
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useRunsStore } = await import('../../stores/runsStore');
const { useAskStore } = await import('../../stores/askStore');
const { useUiStore } = await import('../../stores/uiStore');
const { useXResearchTaskStore } = await import('../../stores/xResearchTaskStore');

const TID = 'thr-1';
const HISTORY = [{ id: 'u1', role: 'user' as const, createdAt: '2026-10-16T00:00:00.000Z', content: '查一下' }];

function snapshot(over: Partial<XResearchTaskSnapshot> = {}): XResearchTaskSnapshot {
  return {
    researchRunId: 'xrun-a', threadId: TID, revision: 1, state: 'running',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:01.000Z',
    objective: 'Qwen3.8 27B 量化版在 agentic 任务上的实际表现',
    counts: { submissions: 1, queued: 0, running: 1, done: 0, failed: 0, cancelled: 0,
      interrupted: 0, posts: 0, replies: 0, articles: 0, undelivered: 0,
      searchDone: 0, searchTotal: 1, readDone: 0, readTotal: 0 },
    budget: { scrolls: 100, expandActions: 100 },
    usage: { posts: 0, scrolls: 0, expandActions: 0 },
    search: [], read: [],
    ...over,
  };
}

const calls = vi.hoisted(() => [] as Array<{ method: string; args: unknown }>);
const taskListReply = vi.hoisted(() => ({ resolve: [] as unknown[], reject: null as Error | null }));

beforeEach(() => {
  calls.length = 0;
  taskListReply.resolve = [];
  taskListReply.reject = null;
  useThreadsStore.setState(useThreadsStore.getInitialState());
  useRunsStore.setState(useRunsStore.getInitialState());
  useAskStore.setState(useAskStore.getInitialState());
  useUiStore.setState(useUiStore.getInitialState());
  useXResearchTaskStore.setState({ snapshotsByRunId: {} });
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, args?: unknown) => {
        calls.push({ method, args });
        if (method === 'thread.loadHistory') return Promise.resolve(HISTORY);
        if (method === 'xResearch.taskList') {
          return taskListReply.reject === null ? Promise.resolve(taskListReply.resolve) : Promise.reject(taskListReply.reject);
        }
        return Promise.resolve(undefined);
      },
      on: () => () => {},
    },
  };
});

const taskListCalls = () => calls.filter((c) => c.method === 'xResearch.taskList');

describe('ThreadView 进对话时拉 x research 的整批快照', () => {
  it('历史落地后拉一次 taskList，把整个列表铺进池；更晚的广播那份不被旧列表降级（R60）', async () => {
    // 广播先到：rev 5。列表是同一时刻读盘算出来的旧版（rev 3）——replaceThread 要保住 rev 5。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 5, state: 'completed' }));
    const stale = snapshot({ revision: 3 });
    const other = snapshot({ researchRunId: 'xrun-b', revision: 1 });
    taskListReply.resolve = [stale, other];

    const m = mount(ThreadView, { threadId: TID });
    await m.settle();

    expect(taskListCalls()).toEqual([{ method: 'xResearch.taskList', args: { threadId: TID } }]);
    expect(useThreadsStore.getState().historyByThread[TID]).toEqual(HISTORY);
    const pool = useXResearchTaskStore.getState().snapshotsByRunId;
    expect(pool['xrun-a'].revision).toBe(5);
    // 列表里新出现的行照样铺进来（整批替换的成员关系只由入参决定，不是只挑已有的）
    expect(pool['xrun-b']).toEqual(other);

    // 同一次开对话里再渲染一遍：不许多拉一次（列表只在开对话那一刻拉）。
    m.rerender({ threadId: TID });
    await m.settle();
    expect(taskListCalls()).toHaveLength(1);
  });

  it('taskList 抛错被吞掉：对话照样开（历史落地、界面进到消息列表），池子保持原样', async () => {
    taskListReply.reject = new Error('research.not_found');

    const m = mount(ThreadView, { threadId: TID });
    await m.settle();
    // 重渲染才看得见历史（miniReact 不订阅 store）：没有抛错本身就是「没被挡在加载中」。
    m.rerender({ threadId: TID });

    expect(taskListCalls()).toHaveLength(1);
    expect(useThreadsStore.getState().historyByThread[TID]).toEqual(HISTORY);
    expect(useXResearchTaskStore.getState().snapshotsByRunId).toEqual({});
    // 界面真的进到了消息列表，不是停在「加载中…」
    expect(findAllWhere(m.tree, (el) => el.type === MessageList)).toHaveLength(1);
  });
});
