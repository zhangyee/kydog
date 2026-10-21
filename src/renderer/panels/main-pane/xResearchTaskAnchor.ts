import type { AssistantBlock } from '../../../shared/types';

type XResearchTaskMessage = { messageId: string; blocks: AssistantBlock[] };

/**
 * `x_research` 的对话锚点：工具结果壳（`XResearchDeliveryEnvelope`）的 `kind` 与 `researchRunId`
 * 是协议面，落进 transcript 的 stdout 文本就是它。
 *
 * 不看 `delivery`：submit / inspect / cancel 的壳没有交付，但它们是同一段研究的进度，
 * 卡要在这些消息上照样跟过去（wait 只有真交出一份结果时才带 `delivery`）。
 */
export function xResearchTaskEvent(block: AssistantBlock): { researchRunId: string } | null {
  if (block.kind !== 'tool_call' || block.name !== 'x_research' || block.status !== 'ok') return null;
  const output = block.chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.data).join('');
  try {
    const value: unknown = JSON.parse(output);
    // 流里的半截 JSON 能解析成标量（`null` / 数字 / 字符串），它们没有协议键。
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const envelope = value as Record<string, unknown>;
    if (envelope.kind !== 'x_research') return null;
    const researchRunId = typeof envelope.researchRunId === 'string' ? envelope.researchRunId : '';
    return researchRunId ? { researchRunId } : null;
  } catch { /* 半截/还在流的工具输出锚不住一张卡。 */ }
  return null;
}

/** 一条消息上的一张卡：分组键（回合）加上这一回合在会话里提到过的研究。
 *  `researchRunIds` 是卡去补快照的那份名单（锚点自己能看见的只有研究 id，看不见快照）；
 *  次序是第一次被提到的次序，卡片按 `createdAt` 重排，不依赖它。 */
export type XResearchTaskAnchor = {
  groupKey: string;
  researchRunIds: string[];
};

/** `researchRunId` → 分组键。渲染层从快照池给出这一层映射（`xResearchTaskGroupKey`）：
 *  锚点里只有研究 id，而「这几段研究是不是同一个回合」只有快照知道。 */
export type XResearchGroupKeyOf = (researchRunId: string) => string;

/**
 * 一次会话里的卡落位：**一个回合一张卡**（R81b），落在提到这个回合里任何一段研究的**最后一条**
 * 消息上 —— 否则同一个回合里的第二段研究会在会话里再长出一张卡。
 *
 * 不给 `groupKeyOf` 时每段研究自成一组（`groupKey = researchRunId`）：单独挂 `AssistantMessage`
 * 的调用与改造前一样，旧 transcript 的卡片也照旧一段一张。
 */
export function latestXResearchTaskMessages(
  messages: XResearchTaskMessage[],
  groupKeyOf: XResearchGroupKeyOf = (researchRunId) => researchRunId,
): Map<string, XResearchTaskAnchor[]> {
  const latestByGroup = new Map<string, { messageId: string; messageIndex: number }>();
  const researchesByGroup = new Map<string, string[]>();
  messages.forEach((message, messageIndex) => {
    for (const block of message.blocks) {
      const event = xResearchTaskEvent(block);
      if (!event) continue;
      const groupKey = groupKeyOf(event.researchRunId);
      // 后提到的消息接手整张卡：同一组的每一段研究都把它往最新一处推。
      latestByGroup.set(groupKey, { messageId: message.messageId, messageIndex });
      const researches = researchesByGroup.get(groupKey) ?? [];
      if (!researches.includes(event.researchRunId)) researches.push(event.researchRunId);
      researchesByGroup.set(groupKey, researches);
    }
  });

  const byMessage = new Map<string, XResearchTaskAnchor[]>();
  const ordered = [...latestByGroup.entries()].sort(([, a], [, b]) => a.messageIndex - b.messageIndex);
  for (const [groupKey, { messageId }] of ordered) {
    const anchors = byMessage.get(messageId) ?? [];
    anchors.push({ groupKey, researchRunIds: researchesByGroup.get(groupKey) ?? [] });
    byMessage.set(messageId, anchors);
  }
  return byMessage;
}
