import type { AskBlock, AssistantBlock } from '../../../shared/types';
import { researchTaskEvent, type ResearchTaskEvent } from './researchTaskAnchor';

export type ProcessBlock =
  | Extract<AssistantBlock, { kind: 'thinking' }>
  | Extract<AssistantBlock, { kind: 'tool_call' }>;

export type Group =
  | { kind: 'text'; block: Extract<AssistantBlock, { kind: 'text' }> }
  | { kind: 'process'; blocks: ProcessBlock[] }
  | { kind: 'ask'; block: AskBlock }
  | { kind: 'error'; block: Extract<AssistantBlock, { kind: 'error' }> }
  | ResearchTaskEvent;

export function groupBlocks(blocks: AssistantBlock[], researchTaskRunIds?: ReadonlySet<string>): Group[] {
  const events = blocks.map(researchTaskEvent);
  const latestOwnedEvent = new Map<string, number>();
  events.forEach((event, index) => {
    if (event && (researchTaskRunIds === undefined || researchTaskRunIds.has(event.researchRunId))) {
      latestOwnedEvent.set(event.researchRunId, index);
    }
  });
  const ownedRuns = [...latestOwnedEvent.entries()].sort(([, a], [, b]) => a - b)
    .map(([researchRunId]) => researchRunId);
  const anchoredBeforeReport = new Set<string>();
  const out: Group[] = [];
  let buf: ProcessBlock[] = [];
  const flush = () => {
    if (buf.length) {
      out.push({ kind: 'process', blocks: buf });
      buf = [];
    }
  };
  for (const [index, b] of blocks.entries()) {
    if (b.kind === 'text') {
      flush();
      out.push({ kind: 'text', block: b });
    } else if (b.kind === 'ask') {
      // 问答是一张整幅卡片，不属于工具/思考那条过程流。
      flush();
      out.push({ kind: 'ask', block: b });
    } else if (b.kind === 'error') {
      // 错误是这一轮的收场，不属于工具/思考那条过程流。
      flush();
      out.push({ kind: 'error', block: b });
    } else {
      const parsed = events[index];
      if (parsed?.kind === 'report_file') {
        flush();
        if (latestOwnedEvent.has(parsed.researchRunId)) {
          out.push({ kind: 'research_task', researchRunId: parsed.researchRunId });
          anchoredBeforeReport.add(parsed.researchRunId);
        }
        buf.push(b);
        flush();
        out.push(parsed);
      } else {
        buf.push(b);
      }
    }
  }
  flush();
  for (const researchRunId of ownedRuns) {
    if (!anchoredBeforeReport.has(researchRunId)) out.push({ kind: 'research_task', researchRunId });
  }
  return out;
}
