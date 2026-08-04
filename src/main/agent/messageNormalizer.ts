import { randomUUID } from 'node:crypto';
import type { Message, AssistantBlock } from '../../shared/types';
import { isParallelBatch } from './askSequentialTools';
import { ASK_TOOL_NAME, isAskOutcome, type AskQuestion } from '../../shared/askQuestion';

// Real pi-ai shapes (from @earendil-works/pi-ai)
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
  /** 工具自定义的结构化载荷。ask_user_question 把 AskOutcome 放在这里。 */
  details?: unknown;
  timestamp?: number;
};

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export function normalizePiMessages(messages: PiMessage[]): Message[] {
  const out: Message[] = [];
  const toolResults = new Map<string, { content: string; isError: boolean; details?: unknown }>();

  // Collect all tool results first
  for (const m of messages) {
    if (m.role === 'toolResult') {
      const text = m.content
        .filter((c): c is PiTextContent => c.type === 'text')
        .map(c => c.text)
        .join('');
      toolResults.set(m.toolCallId, { content: text, isError: m.isError, details: m.details });
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
      // 与实时路径同一条规则：含 sequential 工具的批次实际是串行的，不能判为并行。
      const groupId = isParallelBatch(m.content) ? randomUUID() : undefined;
      for (const c of m.content) {
        if (c.type === 'text') {
          pendingBlocks.push({ kind: 'text', text: c.text });
        } else if (c.type === 'thinking') {
          pendingBlocks.push({ kind: 'thinking', text: c.thinking, status: 'done' });
        } else if (c.type === 'toolCall') {
          const tr = toolResults.get(c.id);
          if (c.name === ASK_TOOL_NAME) {
            const restored = restoreAskBlock(c.id, c.arguments, tr?.details);
            if (restored) { pendingBlocks.push(restored); continue; }
            // details 不是合法 AskOutcome（校验失败 / 批次非法留下的 error
            // toolResult，details 是 {}）→ 落到下面按普通失败工具渲染。
          }
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

/**
 * 从 toolCall + toolResult 还原 ask block。
 *
 * questions 存在 details 里（工具返回时一并写入），因为 toolCall.arguments 是
 * 模型的原始形状，没有主进程分配的 id。没有 toolResult 时退化到 arguments，
 * 只为把问题文本显示出来——那种情况本来就没有答案可对齐。
 *
 * 返回 null 表示「这不是一个可还原的 ask」，调用方应按普通失败工具渲染。
 */
function restoreAskBlock(
  toolCallId: string,
  args: Record<string, unknown> | undefined,
  details: unknown,
): AssistantBlock | null {
  // 没有 toolResult：进程在挂起时退出，留下一个永远等不到答案的提问。
  if (details === undefined) {
    return { kind: 'ask', toolCallId, questions: rawQuestionsAsFallback(args), status: 'unanswered' };
  }
  if (!isAskOutcome(details)) return null;

  const questions = (details as { questions?: AskQuestion[] }).questions ?? rawQuestionsAsFallback(args);
  if (details.kind === 'answered') {
    return { kind: 'ask', toolCallId, questions, status: 'answered', answers: details.answers };
  }
  return { kind: 'ask', toolCallId, questions, status: details.kind };
}

/** toolResult 缺失时的降级：用模型的原始问题，按下标补上 id 只为渲染。 */
function rawQuestionsAsFallback(args: Record<string, unknown> | undefined): AskQuestion[] {
  const raw = (args as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((q, qi) => {
    const rq = q as { question?: string; header?: string; multiSelect?: boolean; options?: unknown };
    const options = Array.isArray(rq.options) ? rq.options : [];
    return {
      id: `q${qi}`,
      question: typeof rq.question === 'string' ? rq.question : '',
      header: typeof rq.header === 'string' ? rq.header : '',
      ...(rq.multiSelect === true ? { multiSelect: true as const } : {}),
      options: options.map((o, oi) => {
        const ro = o as { label?: string; description?: string; recommended?: boolean };
        return {
          id: `q${qi}o${oi}`,
          label: typeof ro.label === 'string' ? ro.label : '',
          description: typeof ro.description === 'string' ? ro.description : '',
          ...(ro.recommended === true ? { recommended: true as const } : {}),
        };
      }),
    };
  });
}
