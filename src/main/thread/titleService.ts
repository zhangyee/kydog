import type { Message } from '../../shared/types';

/**
 * Returns the trimmed/cleaned title, or null if it fails validation.
 *
 * Why this exists: LLMs sometimes ignore the "no quotes / no prefix" instructions
 * in the system prompt, and a malformed title is worse than the fallback slice.
 */
export function parseTitle(raw: string): string | null {
  let t = raw.trim();
  // strip a single layer of wrapping quotes — both ASCII and CJK curly forms
  t = t.replace(/^[""'']/, '').replace(/[""'']$/, '').trim();
  // strip a leading "Title:" preamble (case-insensitive, optional whitespace)
  t = t.replace(/^title:\s*/i, '').trim();
  if (!t) return null;
  // Count Unicode codepoints (not UTF-16 units) — 30 covers both ≤20 CJK and ≤6 Eng words.
  const codepoints = [...t];
  if (codepoints.length > 30) return null;
  return t;
}

/** Returns the textual content of the first message matching `role`, or null. */
export function extractFirstText(
  history: Message[],
  role: 'user' | 'assistant',
): string | null {
  const msg = history.find((m) => m.role === role);
  if (!msg) return null;
  if (msg.role === 'user') return msg.content;
  // assistant: join only `text` blocks (skip thinking + tool_call)
  const text = msg.blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('');
  return text.length > 0 ? text : null;
}
