import { describe, expect, it } from 'vitest';
import type { AssistantBlock } from '../../../shared/types';
import * as researchTaskAnchor from './researchTaskAnchor';
import { normalizePiMessages, type PiMessage } from '../../../main/agent/messageNormalizer';

const tool = (text: string): AssistantBlock => ({ kind: 'tool_call', id: 'call-1',
  name: 'web_research_task', status: 'ok', chunks: [{ stream: 'stdout', data: text }] });
const { researchTaskEvent } = researchTaskAnchor;

describe('researchTaskEvent', () => {
  it('restores the task anchor from a persisted pi tool result', () => {
    const result = '{"kind":"web_research_task","action":"submit","created":true,"researchRunId":"task-1"}';
    const transcript: PiMessage[] = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'web_research_task',
        arguments: { action: 'submit' } }] },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'web_research_task',
        content: [{ type: 'text', text: result }], isError: false },
    ];
    const restored = normalizePiMessages(transcript).find((message) => message.role === 'assistant');
    expect(restored?.role).toBe('assistant');
    if (restored?.role !== 'assistant') throw new Error('assistant transcript missing');
    expect(restored.blocks.map(researchTaskEvent).filter(Boolean))
      .toEqual([{ kind: 'research_task', researchRunId: 'task-1' }]);
  });

  it('treats every successful non-complete task result as a movable progress anchor', () => {
    const blocks: AssistantBlock[] = [
      tool('{"kind":"web_research_task","action":"submit","created":true,"researchRunId":"task-1"}'),
      tool('{"kind":"web_research_task","action":"submit","created":false,"researchRunId":"task-1"}'),
      tool('{"kind":"web_research_task","action":"inspect","researchRunId":"task-1"}'),
    ];
    expect(blocks.map(researchTaskEvent).filter(Boolean))
      .toEqual([
        { kind: 'research_task', researchRunId: 'task-1' },
        { kind: 'research_task', researchRunId: 'task-1' },
        { kind: 'research_task', researchRunId: 'task-1' },
      ]);
  });

  it('anchors a separate report file only after complete succeeds', () => {
    const completed = tool('{"kind":"web_research_task","action":"complete",' +
      '"researchRunId":"task-1","completed":true,"reportPath":"/project/report.md"}');
    expect(researchTaskEvent(completed)).toEqual({ kind: 'report_file', researchRunId: 'task-1',
      path: '/project/report.md' });
    if (completed.kind !== 'tool_call') throw new Error('tool block expected');
    expect(researchTaskEvent({ ...completed, status: 'failed' })).toBeNull();
  });

  it('keeps an unsuccessful complete attempt as live task progress', () => {
    expect(researchTaskEvent(tool('{"kind":"web_research_task","action":"complete",' +
      '"researchRunId":"task-1","completed":false,"validationErrors":[]}')))
      .toEqual({ kind: 'research_task', researchRunId: 'task-1' });
  });

  it('assigns each run to the assistant message containing its latest progress result', () => {
    const latest = (researchTaskAnchor as unknown as { latestResearchTaskMessages?:
      (messages: Array<{ messageId: string; blocks: AssistantBlock[] }>) => Map<string, Set<string>> })
      .latestResearchTaskMessages;
    expect(latest).toBeTypeOf('function');
    if (!latest) return;
    const anchors = latest([
      { messageId: 'old', blocks: [tool('{"kind":"web_research_task","action":"submit",' +
        '"created":true,"researchRunId":"run-a"}')] },
      { messageId: 'other', blocks: [tool('{"kind":"web_research_task","action":"submit",' +
        '"created":true,"researchRunId":"run-b"}')] },
      { messageId: 'new', blocks: [tool('{"kind":"web_research_task","action":"wait",' +
        '"researchRunId":"run-a"}')] },
      { messageId: 'completed', blocks: [tool('{"kind":"web_research_task","action":"complete",' +
        '"researchRunId":"run-a","completed":true,"reportPath":"/project/report.md"}')] },
    ]);
    expect([...anchors.entries()].map(([messageId, ids]) => [messageId, [...ids]])).toEqual([
      ['other', ['run-b']],
      ['completed', ['run-a']],
    ]);
  });
});
