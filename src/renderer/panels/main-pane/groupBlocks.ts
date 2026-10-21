import type { AskBlock, AssistantBlock } from '../../../shared/types';
import { researchTaskEvent, type ResearchTaskEvent } from './researchTaskAnchor';
import { xResearchTaskEvent, type XResearchTaskAnchor } from './xResearchTaskAnchor';

export type ProcessBlock =
  | Extract<AssistantBlock, { kind: 'thinking' }>
  | Extract<AssistantBlock, { kind: 'tool_call' }>;

export type Group =
  | { kind: 'text'; block: Extract<AssistantBlock, { kind: 'text' }> }
  | { kind: 'process'; blocks: ProcessBlock[] }
  | { kind: 'ask'; block: AskBlock }
  | { kind: 'error'; block: Extract<AssistantBlock, { kind: 'error' }> }
  | ResearchTaskEvent
  /** X 研究跨好几条消息：这张卡只挂在这一条里最后提到它的位置（见 `xResearchTaskAnchor`）。
   *  一张卡是一个回合（`groupKey`），卡面内容是该回合里的几段研究。 */
  | { kind: 'x_research'; groupKey: string; researchRunIds: readonly string[] };

/** 一段 blocks 里「归本消息」的 run 各自最后一次被提到的位置。
 *  web 与 x 两个研究家族共用这一条规则：一张卡跟着这一段里最新的一次提到走。 */
function latestOwnedPositions(
  events: Array<{ researchRunId: string } | null>,
  owned: ReadonlySet<string> | undefined,
): Map<string, number> {
  const latest = new Map<string, number>();
  events.forEach((event, index) => {
    if (event && (owned === undefined || owned.has(event.researchRunId))) {
      latest.set(event.researchRunId, index);
    }
  });
  return latest;
}

/** 按最后一次提到的位置排序：卡的出现次序就是事件在这条消息里发生的次序。 */
function byPosition(latest: ReadonlyMap<string, number>): string[] {
  return [...latest.entries()].sort(([, a], [, b]) => a - b).map(([researchRunId]) => researchRunId);
}

/** 这一条消息里的一批卡，按「本回合最后一次被提到」的位置定序（卡的出现次序就是事件发生的次序）。
 *  `undefined` = 这条消息里的每段研究各自一张卡：改造前就是这个行为，`MessageList` 的两条渲染
 *  分支都会显式传锚点，所以只有单独挂 `AssistantMessage` 的调用会走到这里。 */
function xResearchGroupsOf(
  blocks: AssistantBlock[], xResearchAnchors: readonly XResearchTaskAnchor[] | undefined,
): XResearchTaskAnchor[] {
  const anchors = xResearchAnchors ?? (() => {
    const ids: string[] = [];
    for (const block of blocks) {
      const event = xResearchTaskEvent(block);
      if (event && !ids.includes(event.researchRunId)) ids.push(event.researchRunId);
    }
    return ids.map((researchRunId) => ({ groupKey: researchRunId, researchRunIds: [researchRunId] }));
  })();
  const position = (anchor: XResearchTaskAnchor): number => {
    let at = -1;
    blocks.forEach((block, index) => {
      const event = xResearchTaskEvent(block);
      if (event && anchor.researchRunIds.includes(event.researchRunId)) at = index;
    });
    return at;
  };
  return [...anchors].sort((a, b) => position(a) - position(b));
}

export function groupBlocks(
  blocks: AssistantBlock[],
  researchTaskRunIds?: ReadonlySet<string>,
  xResearchAnchors?: readonly XResearchTaskAnchor[],
): Group[] {
  const events = blocks.map(researchTaskEvent);
  const latestOwnedEvent = latestOwnedPositions(events, researchTaskRunIds);
  const ownedRuns = byPosition(latestOwnedEvent);
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
  // x 研究没有报告文件那一支：卡一律收在这一条消息的内容之后。
  for (const anchor of xResearchGroupsOf(blocks, xResearchAnchors)) {
    out.push({ kind: 'x_research', groupKey: anchor.groupKey, researchRunIds: anchor.researchRunIds });
  }
  return out;
}
