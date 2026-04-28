import { randomUUID } from 'node:crypto';
import type { Message, AssistantBlock } from '../../shared/types';

export type PiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: { command?: string } & Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type PiMessage =
  | { role: 'user'; content: string | PiContentBlock[] }
  | { role: 'assistant'; content: PiContentBlock[] }
  | { role: 'tool'; content: PiContentBlock[] };

export function normalizePiMessages(messages: PiMessage[]): Message[] {
  const out: Message[] = [];
  const toolResults = new Map<string, { content: string; isError: boolean }>();

  for (const m of messages) {
    if (m.role === 'tool') {
      for (const c of m.content) {
        if (c.type === 'tool_result') {
          toolResults.set(c.tool_use_id, { content: c.content, isError: !!c.is_error });
        }
      }
    }
  }

  for (const m of messages) {
    if (m.role === 'user') {
      const content = typeof m.content === 'string'
        ? m.content
        : m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('');
      out.push({ id: randomUUID(), role: 'user', createdAt: new Date().toISOString(), content });
    } else if (m.role === 'assistant') {
      const blocks: AssistantBlock[] = [];
      for (const c of m.content) {
        if (c.type === 'text') blocks.push({ kind: 'text', text: c.text });
        else if (c.type === 'tool_use') {
          const tr = toolResults.get(c.id);
          blocks.push({
            kind: 'tool_call',
            id: c.id,
            name: c.name,
            command: typeof c.input.command === 'string' ? c.input.command : undefined,
            chunks: tr ? [{ stream: 'stdout', data: tr.content }] : [],
            status: tr ? (tr.isError ? 'failed' : 'ok') : 'running',
            exitCode: tr ? (tr.isError ? 1 : 0) : undefined,
          });
        }
      }
      out.push({ id: randomUUID(), role: 'assistant', createdAt: new Date().toISOString(), blocks });
    }
  }
  return out;
}
