import { agentService } from '../agent/AgentService';
import { resolveActive } from '../agent/resolveActive';
import { getProviderRegistry } from '../llm/providerRegistry';
import { loadIndex } from '../persist/indexFile';
import { threadService } from './threadService';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { KydogError } from '../../shared/errors';
import type { Message, Thread } from '../../shared/types';

/**
 * Returns the trimmed/cleaned title, or null if it fails validation.
 *
 * Why this exists: LLMs sometimes ignore the "no quotes / no prefix" instructions
 * in the system prompt, and a malformed title is worse than the fallback slice.
 */
export function parseTitle(raw: string): string | null {
  let t = raw.trim();
  // strip a single layer of wrapping quotes — both ASCII and CJK curly forms
  t = t.replace(/^["“'']/, '').replace(/["”'']$/, '').trim();
  // strip a leading "Title:" preamble (case-insensitive, optional whitespace)
  t = t.replace(/^title:\s*/i, '').trim();
  if (!t) return null;
  // Count Unicode codepoints (not UTF-16 units) — 30 covers both ≤20 CJK and ≤6 Eng words.
  const codepoints = [...t];
  if (codepoints.length > 30) return null;
  return t;
}

/**
 * Returns the textual content for the first user message, OR the concatenated
 * text from ALL assistant messages (joined by '\n'), or null.
 *
 * For assistant: we concatenate across messages because tool-heavy turns produce
 * multiple assistant messages (one per tool round); the actual answer text
 * usually lives in a LATER message, not the first one. Taking the first one
 * alone would miss the answer when the first message is [thinking, tool_call].
 * Text blocks within a single message are joined with '' (no separator).
 */
export function extractFirstText(
  history: Message[],
  role: 'user' | 'assistant',
): string | null {
  if (role === 'user') {
    const msg = history.find((m) => m.role === 'user');
    return msg?.role === 'user' ? msg.content : null;
  }
  // assistant: collect per-message text (joining blocks within a message with ''),
  // then join across messages with '\n'.
  const perMessage: string[] = [];
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    const msgText = msg.blocks
      .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
      .map((b) => b.text)
      .join('');
    if (msgText.length > 0) perMessage.push(msgText);
  }
  const text = perMessage.join('\n');
  return text.length > 0 ? text : null;
}

// ─── orchestration ────────────────────────────────────────────────────────────

const PLACEHOLDER = '无标题';
const TIMEOUT_MS = 15_000;
const MAX_ASSISTANT_CHARS = 2_000;
const FALLBACK_SLICE = 20;

const TITLE_SYSTEM_PROMPT = `You name conversations. Given the first user message and the first assistant reply, produce a single concise title.

Rules:
- Match the dominant language of the user message (Chinese → Chinese, English → English).
- Length: ≤ 20 Chinese characters OR ≤ 6 English words.
- Noun phrase, not a sentence. No trailing punctuation.
- No quotes, no markdown, no prefix like "Title:".
- Output ONLY the title, nothing else.`;

function buildUserContent(firstUser: string, firstAssistant: string): string {
  return `First user message:
"""
${firstUser}
"""

First assistant reply:
"""
${firstAssistant}
"""`;
}

async function callLlm(thread: Thread, firstUser: string, firstAssistant: string): Promise<string | null> {
  const { providerId, modelId } = await resolveActive(thread.id, thread.projectPath);
  const reg = getProviderRegistry();
  const model = reg.modelRegistry.find(providerId, modelId);
  if (!model) throw new KydogError('llm.invalid', `no model for ${providerId}/${modelId}`);
  const auth = await (reg.modelRegistry as any).getApiKeyAndHeaders(model);
  if (!auth.ok) throw new KydogError('llm.invalid', auth.error);
  const { apiKey, headers } = auth;

  const { completeSimple } = await import('@mariozechner/pi-ai');
  const truncated = firstAssistant.length > MAX_ASSISTANT_CHARS
    ? firstAssistant.slice(0, MAX_ASSISTANT_CHARS) + '…'
    : firstAssistant;

  const response = await completeSimple(
    model as Parameters<typeof completeSimple>[0],
    {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildUserContent(firstUser, truncated) }],
        timestamp: Date.now(),
      }],
    },
    { apiKey, headers, maxTokens: 60, signal: AbortSignal.timeout(TIMEOUT_MS) },
  );

  if (response.stopReason === 'error') return null;
  const text = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim();
  return parseTitle(text);
}

export const titleService = {
  /** Fire-and-forget. Logs errors internally; never throws. */
  generateForThread(threadId: string): void {
    void this.runGenerate(threadId).catch((err) =>
      logger.warn('title', 'generate failed', { threadId, err: String(err) })
    );
  },

  /**
   * Visible for testing. Returns void; updates thread index and emits IPC on success.
   * On any failure, writes `firstUser.slice(0, FALLBACK_SLICE)` as a fallback title.
   */
  async runGenerate(threadId: string): Promise<void> {
    const idx = await loadIndex();
    const thread = idx.threads.find((t) => t.id === threadId);
    if (!thread) return;
    if (thread.title !== PLACEHOLDER) return;

    const history = await agentService.loadHistory(threadId, thread.projectPath);
    const firstUser = extractFirstText(history, 'user');
    const firstAssistant = extractFirstText(history, 'assistant');
    if (!firstUser || !firstAssistant) return;

    let title: string | null = null;
    try {
      title = await callLlm(thread, firstUser, firstAssistant);
    } catch (err) {
      logger.warn('title', 'llm call failed, using fallback', { threadId, err: String(err) });
    }
    if (!title) title = firstUser.slice(0, FALLBACK_SLICE);

    // race re-check: user may have manually renamed in the meantime
    const after = await loadIndex();
    const thread2 = after.threads.find((t) => t.id === threadId);
    if (!thread2 || thread2.title !== PLACEHOLDER) return;

    const updated = await threadService.update({ threadId, title });
    broadcaster.emit('thread.updated', { thread: updated });
  },
};
