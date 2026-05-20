import { randomUUID } from 'node:crypto';
import type { Message, AssistantBlock } from '../../shared/types';

// Real pi-ai shapes (from @mariozechner/pi-ai)
export type PiTextContent = { type: 'text'; text: string };
export type PiThinkingContent = { type: 'thinking'; thinking: string };
export type PiToolCall = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
export type PiImageContent = { type: 'image'; [k: string]: unknown };

export type PiAssistantMessage = {
  role: 'assistant';
  content: (PiTextContent | PiThinkingContent | PiToolCall)[];
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  [k: string]: unknown;
};

export type PiUserMessage = {
  role: 'user';
  content: string | (PiTextContent | PiImageContent)[];
  timestamp?: number;
};

export type PiToolResultMessage = {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (PiTextContent | PiImageContent)[];
  isError: boolean;
  timestamp?: number;
};

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export function normalizePiMessages(messages: PiMessage[]): Message[] {
  const out: Message[] = [];
  const toolResults = new Map<string, { content: string; isError: boolean }>();

  // Collect all tool results first
  for (const m of messages) {
    if (m.role === 'toolResult') {
      const text = m.content
        .filter((c): c is PiTextContent => c.type === 'text')
        .map(c => c.text)
        .join('');
      toolResults.set(m.toolCallId, { content: text, isError: m.isError });
    }
  }

  // 聚合连续的 pi assistant message 为一条 KyDog Message，user 与循环末尾为边界。
  // 与实时模式（AgentService 的 per-run activeMessageId）的合并语义对齐：
  // pi 协议把"assistant→tool→toolResult→assistant→..."拆成多条 assistant，但语义上属于同一个 turn。
  let pendingBlocks: AssistantBlock[] = [];
  const flushAssistant = () => {
    if (pendingBlocks.length === 0) return;
    out.push({ id: randomUUID(), role: 'assistant', createdAt: new Date().toISOString(), blocks: pendingBlocks });
    pendingBlocks = [];
  };

  for (const m of messages) {
    if (m.role === 'user') {
      flushAssistant();
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content as (PiTextContent | PiImageContent)[])
            .filter((c): c is PiTextContent => c.type === 'text')
            .map(c => c.text)
            .join('');
      out.push({ id: randomUUID(), role: 'user', createdAt: new Date().toISOString(), content });
    } else if (m.role === 'assistant') {
      // 协议层并行：当且仅当本条 pi assistant message 的 content 里 ≥2 个 toolCall 时，
      // 它们共享同一个 parallelGroupId。跨 message 永不共享。
      const toolCallCount = m.content.filter((c) => c.type === 'toolCall').length;
      const groupId = toolCallCount >= 2 ? randomUUID() : undefined;
      for (const c of m.content) {
        if (c.type === 'text') {
          pendingBlocks.push({ kind: 'text', text: c.text });
        } else if (c.type === 'thinking') {
          pendingBlocks.push({ kind: 'thinking', text: c.thinking, status: 'done' });
        } else if (c.type === 'toolCall') {
          const tr = toolResults.get(c.id);
          pendingBlocks.push({
            kind: 'tool_call',
            id: c.id,
            name: c.name,
            command: typeof c.arguments?.command === 'string' ? c.arguments.command : JSON.stringify(c.arguments ?? {}),
            chunks: tr ? [{ stream: 'stdout', data: tr.content }] : [],
            status: tr ? (tr.isError ? 'failed' : 'ok') : 'running',
            parallelGroupId: groupId,
          });
        }
      }
    }
    // toolResult messages are consumed above; skip emitting them as top-level messages
  }
  flushAssistant();
  return out;
}
