import type { AssistantBlock } from '../../../shared/types';

export type ResearchTaskEvent =
  | { kind: 'research_task'; researchRunId: string }
  | { kind: 'report_file'; researchRunId: string; path: string };

type ResearchTaskMessage = { messageId: string; blocks: AssistantBlock[] };

/** Persisted successful tool results are the cards' stable conversation anchors. */
export function researchTaskEvent(block: AssistantBlock): ResearchTaskEvent | null {
  if (block.kind !== 'tool_call' || block.name !== 'web_research_task' || block.status !== 'ok') return null;
  const output = block.chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.data).join('');
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (value.kind !== 'web_research_task') return null;
    const researchRunId = typeof value.researchRunId === 'string' ? value.researchRunId : '';
    if (value.action === 'complete' && value.completed === true &&
      researchRunId && typeof value.reportPath === 'string' && value.reportPath)
      return { kind: 'report_file', researchRunId, path: value.reportPath };
    if (typeof value.action === 'string' && researchRunId)
      return { kind: 'research_task', researchRunId };
  } catch { /* Partial/live tool output cannot anchor a card. */ }
  return null;
}

/** Assign each run's single live card to the message containing its latest progress result. */
export function latestResearchTaskMessages(messages: ResearchTaskMessage[]): Map<string, Set<string>> {
  const latestByRun = new Map<string, { messageId: string; messageIndex: number }>();
  messages.forEach((message, messageIndex) => {
    for (const block of message.blocks) {
      const event = researchTaskEvent(block);
      if (event) {
        latestByRun.set(event.researchRunId, { messageId: message.messageId, messageIndex });
      }
    }
  });

  const byMessage = new Map<string, Set<string>>();
  const ordered = [...latestByRun.entries()].sort(([, a], [, b]) => a.messageIndex - b.messageIndex);
  for (const [researchRunId, { messageId }] of ordered) {
    const runIds = byMessage.get(messageId) ?? new Set<string>();
    runIds.add(researchRunId);
    byMessage.set(messageId, runIds);
  }
  return byMessage;
}
