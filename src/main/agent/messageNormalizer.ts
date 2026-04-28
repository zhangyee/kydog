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

  for (const m of messages) {
    if (m.role === 'user') {
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content as (PiTextContent | PiImageContent)[])
            .filter((c): c is PiTextContent => c.type === 'text')
            .map(c => c.text)
            .join('');
      out.push({ id: randomUUID(), role: 'user', createdAt: new Date().toISOString(), content });
    } else if (m.role === 'assistant') {
      const blocks: AssistantBlock[] = [];
      for (const c of m.content) {
        if (c.type === 'text') {
          blocks.push({ kind: 'text', text: c.text });
        } else if (c.type === 'thinking') {
          blocks.push({ kind: 'thinking', text: c.thinking });
        } else if (c.type === 'toolCall') {
          const tr = toolResults.get(c.id);
          blocks.push({
            kind: 'tool_call',
            id: c.id,
            name: c.name,
            command: typeof c.arguments?.command === 'string' ? c.arguments.command : undefined,
            chunks: tr ? [{ stream: 'stdout', data: tr.content }] : [],
            status: tr ? (tr.isError ? 'failed' : 'ok') : 'running',
          });
        }
      }
      out.push({ id: randomUUID(), role: 'assistant', createdAt: new Date().toISOString(), blocks });
    }
    // toolResult messages are consumed above; skip emitting them as top-level messages
  }
  return out;
}
