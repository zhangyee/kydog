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

/** 一段研究跨好几条消息（submit → wait → submit → wait）：卡只跟在这一段里**最后一次**
 *  提到这个 run 的消息上，否则同一个研究会在会话里长出好几张卡。 */
export function latestXResearchTaskMessages(messages: XResearchTaskMessage[]): Map<string, Set<string>> {
  const latestByRun = new Map<string, { messageId: string; messageIndex: number }>();
  messages.forEach((message, messageIndex) => {
    for (const block of message.blocks) {
      const event = xResearchTaskEvent(block);
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
