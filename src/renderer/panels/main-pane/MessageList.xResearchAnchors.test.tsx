import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';
import type { AssistantBlock } from '../../../shared/types';

/**
 * **`MessageList` 真的把 `xResearchAnchors` 交给了 `AssistantMessage`。**
 *
 * 这条 prop 此前只有评审在看着：拼错成别的名字不会有任何用例红，而它的语义是
 * `undefined` = 这条消息里的研究各自一张卡 —— 于是每一条消息都会长出所有研究的卡，
 * 或者一张都不长，取决于拼错的那一侧。子组件在这里不展开，所以断言的是**交给它的
 * 那个 prop 本身**（按身份找到 `AssistantMessage` 节点再读 props，同
 * ThreadView.followSignal.test.tsx）。
 *
 * 两条渲染分支各一个：已落定的历史消息，和还在 buffer 里的在途消息。两个调用点
 * 都在 MessageList 里，漏掉哪一处都只会在用户看不到的那一类消息上出错。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 滚动监听要真的 DOM（miniReact 的假元素没有 addEventListener），这条用例只看传下去的 prop。
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
vi.mock('../../stores/identityStore', async (o) => directRead(await o<typeof import('../../stores/identityStore')>(), 'useIdentityStore'));
vi.mock('../../stores/xResearchTaskStore', async (o) => directRead(await o<typeof import('../../stores/xResearchTaskStore')>(), 'useXResearchTaskStore'));

const { MessageList } = await import('./MessageList');
const { AssistantMessage } = await import('./AssistantMessage');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useRunsStore } = await import('../../stores/runsStore');
const { useAskStore } = await import('../../stores/askStore');
const { useUiStore } = await import('../../stores/uiStore');
const { useIdentityStore } = await import('../../stores/identityStore');
const { useXResearchTaskStore } = await import('../../stores/xResearchTaskStore');

const TID = 'thr-1';

/** 一个 `x_research` 的动作壳：协议键在 stdout 的 JSON 里（判据见 xResearchTaskAnchor.ts）。 */
function xResearchShell(researchRunId: string): AssistantBlock {
  return {
    kind: 'tool_call', id: `call-${researchRunId}`, name: 'x_research', status: 'ok',
    chunks: [{ stream: 'stdout', data: JSON.stringify({ kind: 'x_research', researchRunId }) }],
  };
}

beforeEach(() => {
  useThreadsStore.setState(useThreadsStore.getInitialState());
  useRunsStore.setState(useRunsStore.getInitialState());
  useAskStore.setState(useAskStore.getInitialState());
  useUiStore.setState(useUiStore.getInitialState());
  useIdentityStore.setState(useIdentityStore.getInitialState());
  useXResearchTaskStore.setState({ snapshotsByRunId: {} });
});

describe('MessageList → AssistantMessage 的 x research 锚点', () => {
  it('历史与在途两条分支各自把自己那段研究的卡交下去（拼错 prop 名就是没有卡）', () => {
    useThreadsStore.setState({
      historyByThread: {
        [TID]: [
          { id: 'm-1', role: 'assistant', createdAt: '2026-10-16T00:00:00.000Z', blocks: [xResearchShell('xrun-a')] },
        ],
      },
    });
    useRunsStore.setState({
      bufferByMessage: { 'm-live': { threadId: TID, blocks: [xResearchShell('xrun-b')] } },
    });

    const m = mount(MessageList, { threadId: TID, scrollRef: { current: null } });
    const settled = findAllWhere(m.tree, (el) => el.type === AssistantMessage && el.props.messageId === 'm-1');
    const live = findAllWhere(m.tree, (el) => el.type === AssistantMessage && el.props.messageId === 'm-live');

    expect(settled).toHaveLength(1);
    expect(live).toHaveLength(1);
    expect(settled[0].props.xResearchAnchors)
      .toEqual([{ groupKey: 'xrun-a', researchRunIds: ['xrun-a'] }]);
    expect(live[0].props.xResearchAnchors)
      .toEqual([{ groupKey: 'xrun-b', researchRunIds: ['xrun-b'] }]);
  });
});
