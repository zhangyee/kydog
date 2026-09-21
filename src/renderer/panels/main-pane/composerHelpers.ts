import type { SkillEntry } from '../../../shared/types';

/**
 * Returns the skills that match a slash-command query.
 *
 * The text starts with "/" and may continue with the skill name; anything
 * after the first whitespace is treated as arguments and is NOT part of the
 * filter query. This matches Codex/Claude-style slash menus: typing "/ word"
 * still surfaces every skill (empty filter), and "/fr extra" filters by "fr".
 *
 * Returns [] when the text doesn't start with "/" or contains a literal
 * newline (multi-line content is never a slash command).
 */
export function filterSkillEntries(items: readonly SkillEntry[], text: string): SkillEntry[] {
  if (!text.startsWith('/')) return [];
  if (text.includes('\n')) return [];
  const afterSlash = text.slice(1);
  const wsMatch = afterSlash.match(/\s/);
  const token = wsMatch ? afterSlash.slice(0, wsMatch.index) : afterSlash;
  const q = token.toLowerCase();
  if (q.length === 0) return [...items];
  return items.filter((it) => it.name.toLowerCase().startsWith(q));
}

export type KeyAction =
  | { kind: 'send' }
  | { kind: 'newline' }
  | { kind: 'slash-up' }
  | { kind: 'slash-down' }
  | { kind: 'slash-commit' }
  | { kind: 'slash-close' }
  | { kind: 'ignore' };

export function dispatchInputKey(args: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  slashMenuOpen: boolean;
}): KeyAction {
  if (args.slashMenuOpen) {
    if (args.key === 'Enter' || args.key === 'Tab') return { kind: 'slash-commit' };
    if (args.key === 'ArrowDown') return { kind: 'slash-down' };
    if (args.key === 'ArrowUp') return { kind: 'slash-up' };
    if (args.key === 'Escape') return { kind: 'slash-close' };
    return { kind: 'ignore' };
  }
  if (args.key !== 'Enter') return { kind: 'ignore' };
  if (args.metaKey || args.ctrlKey) return { kind: 'send' };
  if (args.isComposing) return { kind: 'ignore' };
  if (args.shiftKey) return { kind: 'newline' };
  return { kind: 'send' };
}

/**
 * 输入框预先拦「有图但当前模型不读图」（spec §3.6）。渲染层**不认识**当前模型时不拦 ——
 * 交给主进程按会话实际的模型判，别在这里替它猜。
 */
export function imageInputBlocked(args: {
  hasImages: boolean;
  entry: { modelIds: string[]; imageInputModelIds: string[] } | undefined;
  modelId: string | null;
}): boolean {
  if (!args.hasImages || !args.entry || !args.modelId) return false;
  if (!args.entry.modelIds.includes(args.modelId)) return false;
  return !args.entry.imageInputModelIds.includes(args.modelId);
}
