import { describe, expect, it } from 'vitest';
import type { AssistantBlock } from '../../../shared/types';
import { latestXResearchTaskMessages, xResearchTaskEvent } from './xResearchTaskAnchor';

const toolText = (text: string, over: Partial<Extract<AssistantBlock, { kind: 'tool_call' }>> = {}):
AssistantBlock => ({ kind: 'tool_call', id: 'call-1', name: 'x_research', status: 'ok',
  chunks: [{ stream: 'stdout', data: text }], ...over });
const envelope = (over: Record<string, unknown> = {}): AssistantBlock =>
  toolText(JSON.stringify({ kind: 'x_research', researchRunId: 'xrun-a', ...over }));

describe('xResearchTaskEvent', () => {
  it('anchors every action shell, including the ones that carry no delivery', () => {
    const shells = [
      { action: 'submit', status: 'running', snapshot: { researchRunId: 'xrun-a' } },
      { action: 'inspect', status: 'running', inspect: { view: 'rows', items: [] } },
      { action: 'cancel', status: 'cancelled', snapshot: { researchRunId: 'xrun-a' } },
      // 真交付的 wait 也一样锚得住：`delivery` 不是判据。
      { action: 'wait', status: 'running', delivery: { deliveryCallId: 'call-2' } },
    ];
    expect(shells.map((shell) => xResearchTaskEvent(envelope(shell))))
      .toEqual(shells.map(() => ({ researchRunId: 'xrun-a' })));
  });

  it('ignores tool output without the protocol keys', () => {
    const ignored = [
      // 半截 JSON：流里真实出现过的中间片段。
      toolText('{"kind":"x_research","action":"submit","researchRunId":"xrun-a"'),
      // 能解析成标量的输出没有协议键。
      toolText('null'),
      toolText(''),
      toolText('boom', { status: 'failed' }),
      // 壳还没落定（工具在跑），没有 runId 可锚。
      toolText(JSON.stringify({ kind: 'x_research', action: 'submit' }), { status: 'running' }),
      // kind 是协议键，空串 runId 不是一段研究。
      toolText(JSON.stringify({ kind: 'x_research', researchRunId: '' })),
      // 别的工具（web_research_task 也有 researchRunId 这个同名字段）。
      toolText(JSON.stringify({ kind: 'web_research_task', action: 'submit', researchRunId: 'task-1' })),
      toolText(JSON.stringify({ kind: 'x_research', researchRunId: 'xrun-a' }), { name: 'bash' }),
      // 改版前的平铺结果：XResearchResult 本体，没有 `kind`，也没有 `researchRunId`。
      toolText(JSON.stringify({ operation: 'search', objective: 'qwen3 量化',
        queries: [{ id: 'q1', query: 'qwen3 27b' }], budgetUsage: { scrolls: 3 } })),
    ];
    expect(ignored.map(xResearchTaskEvent)).toEqual(ignored.map(() => null));
    // 同一条用例里的正对照：同一份文本带上协议键就锚得住，上面的 null 不是判据坏掉。
    expect(xResearchTaskEvent(envelope({ action: 'submit' }))).toEqual({ researchRunId: 'xrun-a' });
  });

  it('assigns each research to the assistant message that mentioned it last', () => {
    const anchors = latestXResearchTaskMessages([
      { messageId: 'submit', blocks: [envelope({ action: 'submit' })] },
      { messageId: 'other', blocks: [envelope({ researchRunId: 'xrun-b' })] },
      // 只提到「跑着呢」的 inspect 也算提到：卡跟着最新一次提到走。
      { messageId: 'wait', blocks: [envelope({ action: 'wait', delivery: { deliveryCallId: 'c2' } })] },
      { messageId: 'inspect', blocks: [envelope({ action: 'inspect', inspect: { view: 'rows', items: [] } })] },
    ]);
    expect([...anchors.entries()].map(([messageId, ids]) => [messageId, [...ids]])).toEqual([
      ['other', ['xrun-b']],
      ['inspect', ['xrun-a']],
    ]);
  });

  it('keeps two researches on the messages that mentioned each one last', () => {
    const anchors = latestXResearchTaskMessages([
      { messageId: 'both', blocks: [envelope({ action: 'submit' }),
        envelope({ researchRunId: 'xrun-b', action: 'submit' })] },
      { messageId: 'only-b', blocks: [envelope({ researchRunId: 'xrun-b', action: 'wait' })] },
    ]);
    expect([...anchors.entries()].map(([messageId, ids]) => [messageId, [...ids]])).toEqual([
      ['both', ['xrun-a']],
      ['only-b', ['xrun-b']],
    ]);
  });

  it('lifts no anchor out of a transcript written before the envelope', () => {
    // 改版前：submit / wait 的结果直接是采集层的结果本体。
    const legacy = (result: Record<string, unknown>): AssistantBlock =>
      toolText(JSON.stringify(result));
    const messages = [
      { messageId: 'legacy-submit', blocks: [legacy({ operation: 'search', objective: 'qwen3' })] },
      { messageId: 'legacy-wait', blocks: [legacy({ operation: 'read', objective: 'qwen3' })] },
    ];
    expect([...latestXResearchTaskMessages(messages)]).toEqual([]);
    // 正对照：同一批位置上换成协议壳，卡就有了。
    expect([...latestXResearchTaskMessages([
      { messageId: 'envelope-submit', blocks: [envelope({ action: 'submit' })] },
      { messageId: 'envelope-wait', blocks: [envelope({ action: 'wait' })] },
    ])].map(([messageId, ids]) => [messageId, [...ids]]))
      .toEqual([['envelope-wait', ['xrun-a']]]);
  });
});
