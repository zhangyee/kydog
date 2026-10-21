import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';
import type { AssistantBlock } from '../../../shared/types';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});
vi.mock('../../stores/threadsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  const hook = ((selector: (state: ReturnType<typeof real.getState>) => unknown) =>
    selector(real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useThreadsStore: hook };
});
vi.mock('../../stores/identityStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/identityStore')>();
  const real = mod.useIdentityStore;
  const hook = ((selector: (state: ReturnType<typeof real.getState>) => unknown) =>
    selector(real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useIdentityStore: hook };
});

const { AssistantMessage } = await import('./AssistantMessage');
const { MarkdownBlock } = await import('./MarkdownBlock');
const { ProcessGroup } = await import('./ProcessGroup');
const { XResearchProgressCard } = await import('./XResearchProgressCard');
const { latestXResearchTaskMessages } = await import('./xResearchTaskAnchor');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useIdentityStore } = await import('../../stores/identityStore');

const toolText = (text: string, id = 'call-1'): AssistantBlock => ({
  kind: 'tool_call', id, name: 'x_research', status: 'ok',
  chunks: [{ stream: 'stdout', data: text }],
});
const shell = (result: Record<string, unknown>, id = 'call-1'): AssistantBlock =>
  toolText(JSON.stringify({ kind: 'x_research', ...result }), id);
const text = (value: string): AssistantBlock => ({ kind: 'text', text: value });

/** 把「哪张卡 / 哪段过程 / 哪段文字、按什么次序」压成一串：卡的 runId 跟着走，因为
 *  「两张卡各是哪一段研究」与「卡在这一条消息的哪里」都是这条用例的判据。 */
const layout = (tree: unknown): string[] => findAllWhere(tree, (element) =>
  [XResearchProgressCard, ProcessGroup, MarkdownBlock].includes(element.type as typeof XResearchProgressCard))
  .map((element) => element.type === XResearchProgressCard ? `x:${String(element.props.groupKey)}` :
    element.type === ProcessGroup ? 'process' : 'text');
const xCards = (tree: unknown) =>
  findAllWhere(tree, (element) => element.type === XResearchProgressCard);

beforeEach(() => {
  useThreadsStore.setState(useThreadsStore.getInitialState());
  useIdentityStore.setState(useIdentityStore.getInitialState());
});

describe('AssistantMessage x research cards', () => {
  it('renders the card after the content it belongs to, bound to that run', () => {
    const rendered = mount(AssistantMessage, { threadId: 'thread-1', messageId: 'message-1',
      settled: false, blocks: [shell({ action: 'submit', researchRunId: 'xrun-a' }),
        text('继续调研'), shell({ action: 'wait', researchRunId: 'xrun-a', delivery: { deliveryCallId: 'c2' } }, 'call-2')] });
    expect(layout(rendered.tree)).toEqual(['process', 'text', 'process', 'x:xrun-a']);
    // 卡拿到的就是这一段研究所在的那条对话，与消息上的 threadId 是同一个。
    expect(xCards(rendered.tree)[0].props).toMatchObject({
      threadId: 'thread-1', groupKey: 'xrun-a', researchRunIds: ['xrun-a'],
    });
  });

  it('keeps two researches on two cards, ordered by their last mention', () => {
    const rendered = mount(AssistantMessage, { threadId: 'thread-1', messageId: 'message-1',
      settled: true, blocks: [
        shell({ action: 'submit', researchRunId: 'xrun-a' }, 'a-1'),
        shell({ action: 'submit', researchRunId: 'xrun-b' }, 'b-1'),
        shell({ action: 'wait', researchRunId: 'xrun-a', delivery: { deliveryCallId: 'a-2' } }, 'a-2'),
      ] });
    expect(layout(rendered.tree)).toEqual(['process', 'x:xrun-b', 'x:xrun-a']);
  });

  it('renders a card only on the message that mentioned the run last', () => {
    // 同一条研究跨两条消息：submit 在那条、wait 在这条。
    const submitMessage = { messageId: 'old', blocks: [shell({ action: 'submit', researchRunId: 'xrun-a' })] };
    const waitMessage = { messageId: 'new', blocks: [shell({ action: 'wait', researchRunId: 'xrun-a' })] };
    const anchors = latestXResearchTaskMessages([submitMessage, waitMessage]);
    const render = (message: { messageId: string; blocks: AssistantBlock[] }) =>
      mount(AssistantMessage, { threadId: 'thread-1', messageId: message.messageId, settled: true,
        blocks: message.blocks,
        xResearchAnchors: anchors.get(message.messageId) ?? [] });
    expect(layout(render(submitMessage).tree)).toEqual(['process']);
    expect(layout(render(waitMessage).tree)).toEqual(['process', 'x:xrun-a']);
  });

  it('renders no card whose run is owned by a newer message', () => {
    const submit = shell({ action: 'submit', researchRunId: 'xrun-a' });
    const owned = mount(AssistantMessage, { threadId: 'thread-1', messageId: 'message-1',
      settled: true, blocks: [submit],
      xResearchAnchors: [{ groupKey: 'xrun-a', researchRunIds: ['xrun-a'] }] });
    expect(layout(owned.tree)).toEqual(['process', 'x:xrun-a']);
    // 正对照在同一条用例里：同一个块、run 归了更新的那条消息，卡就不该出现在这里。
    const stale = mount(AssistantMessage, { threadId: 'thread-1', messageId: 'message-1',
      settled: true, blocks: [submit], xResearchAnchors: [] });
    expect(layout(stale.tree)).toEqual(['process']);
  });

  it('renders no card for tool output that does not carry the protocol keys', () => {
    const legacy = mount(AssistantMessage, { threadId: 'thread-1', messageId: 'message-1', settled: true,
      blocks: [
        // 改版前的平铺结果（结果本体，没有 kind）。
        toolText(JSON.stringify({ operation: 'search', objective: 'qwen3 量化', budgetUsage: {} })),
        // 还在流的半截 JSON。
        toolText('{"kind":"x_research","action":"submit","researchRunId":"xrun-a"', 'call-2'),
      ] });
    expect(layout(legacy.tree)).toEqual(['process']);
    // 正对照：同一批位置上换成协议壳就出卡，上面的空结果不是查找本身坏了。
    const enveloped = mount(AssistantMessage, { threadId: 'thread-1', messageId: 'message-1',
      settled: true, blocks: [shell({ action: 'submit', researchRunId: 'xrun-a' })] });
    expect(layout(enveloped.tree)).toEqual(['process', 'x:xrun-a']);
  });
});
