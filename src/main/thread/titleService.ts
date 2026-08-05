import { resolveActive } from '../agent/resolveActive';
import { getProviderRegistry } from '../llm/providerRegistry';
import { loadIndex } from '../persist/indexFile';
import { threadService } from './threadService';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { KydogError } from '../../shared/errors';
import type { Thread } from '../../shared/types';

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

// ─── orchestration ────────────────────────────────────────────────────────────

const PLACEHOLDER = '无标题';
const TIMEOUT_MS = 15_000;
const FALLBACK_SLICE = 20;

const TITLE_SYSTEM_PROMPT = `You name conversations. Given the user's first message, produce a single concise title that captures what they want.

Rules:
- Match the dominant language of the user message (Chinese → Chinese, English → English).
- Length: ≤ 20 Chinese characters OR ≤ 6 English words.
- Noun phrase, not a sentence. No trailing punctuation.
- No quotes, no markdown, no prefix like "Title:".
- Output ONLY the title, nothing else.`;

// modelRuntime 的 getModel 只声明到 unknown（那份 shim 只钉了实际被调用的方法签名），
// 这里按 completeSimple 的入参类型收窄 —— 全流程唯一一处 cast。
// type-only，编译后不留 import，不影响 CJS 解析。
type PiModel = Parameters<import('@earendil-works/pi-coding-agent').ModelRuntime['completeSimple']>[0];

async function callLlm(thread: Thread, firstUser: string): Promise<string | null> {
  const { providerId, modelId } = await resolveActive(thread.id, thread.projectPath);
  const reg = getProviderRegistry();
  // ModelRuntime 自己在 completeSimple 里解析凭据，调用方不再取 apiKey / headers。
  const runtime = reg.modelRuntime;
  const model = runtime.getModel(providerId, modelId) as PiModel | undefined;
  if (!model) throw new KydogError('llm.invalid', `no model for ${providerId}/${modelId}`);

  const response = await runtime.completeSimple(
    model,
    {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: firstUser }],
        timestamp: Date.now(),
      }],
    },
    { maxTokens: 60, signal: AbortSignal.timeout(TIMEOUT_MS) },
  );

  if (response.stopReason === 'error') {
    logger.warn('title', 'llm stopReason=error', { threadId: thread.id, providerId, modelId, errorMessage: (response as { errorMessage?: string }).errorMessage });
    return null;
  }
  const text = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim();
  const parsed = parseTitle(text);
  if (parsed === null) {
    logger.warn('title', 'parseTitle rejected llm output', { threadId: thread.id, providerId, modelId, raw: text.slice(0, 200), rawLen: text.length });
  }
  return parsed;
}

export const titleService = {
  /** Fire-and-forget. Logs errors internally; never throws. */
  generateForThread(threadId: string, firstUserContent: string): void {
    void this.runGenerate(threadId, firstUserContent).catch((err) =>
      logger.warn('title', 'generate failed', { threadId, err: String(err) })
    );
  },

  /**
   * Visible for testing. Updates thread index and emits IPC on success.
   * On failure, writes `firstUserContent.slice(0, FALLBACK_SLICE)` as fallback.
   */
  async runGenerate(threadId: string, firstUserContent: string): Promise<void> {
    const idx = await loadIndex();
    const thread = idx.threads.find((t) => t.id === threadId);
    if (!thread) return;
    if (thread.title !== PLACEHOLDER) return;
    if (!firstUserContent) return;

    let title: string | null = null;
    try {
      title = await callLlm(thread, firstUserContent);
    } catch (err) {
      logger.warn('title', 'llm call failed, using fallback', { threadId, err: String(err) });
    }
    if (!title) title = firstUserContent.slice(0, FALLBACK_SLICE);

    // race re-check: user may have manually renamed in the meantime
    const after = await loadIndex();
    const thread2 = after.threads.find((t) => t.id === threadId);
    if (!thread2 || thread2.title !== PLACEHOLDER) return;

    const updated = await threadService.update({ threadId, title });
    broadcaster.emit('thread.updated', { thread: updated });
  },
};
