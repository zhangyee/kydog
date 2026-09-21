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

export type PasteRoute = { kind: 'files'; files: File[] } | { kind: 'text'; text: string } | { kind: 'none' };

/**
 * 粘贴的分流（裁定 2）：带磁盘路径的文件 > 文字 > 无路径的图片。
 * 表格软件会同时给文字和一张没有路径的渲染图 —— 文字赢；截图只有图 —— 图进托盘；
 * 访达里复制的文件若 Chromium 给得出路径就按附件收，给不出就退化成插文件名文字。
 */
export function routePaste(text: string, files: readonly File[], pathForFile: (f: File) => string): PasteRoute {
  const onDisk = files.filter((f) => pathForFile(f) !== '');
  if (onDisk.length > 0) return { kind: 'files', files: onDisk };
  if (text !== '') return { kind: 'text', text };
  if (files.length > 0) return { kind: 'files', files: [...files] };
  return { kind: 'none' };
}

/**
 * 光标前那一段里，最后一个「@查询词」（裁定 3）。@ 前面必须是开头、空白，或不属于
 * [A-Za-z0-9_.-] 的字符 —— 中文「对比@dpo」要能触发，`a@b.com` 不触发。查询词里不含空白与 @。
 */
export function mentionQueryAt(textBeforeCaret: string): { query: string; start: number } | null {
  const m = /(^|[^A-Za-z0-9_.-])@([^\s@]*)$/.exec(textBeforeCaret);
  if (!m) return null;
  return { query: m[2], start: m.index + m[1].length };
}

/** 批注框的按键（spec §1.4）：只有 ⌘↵ / Ctrl↵ 添加；↵、⇧↵ 交给文本框换行；Esc 取消。 */
export function dispatchCommentBoxKey(args: { key: string; metaKey: boolean; ctrlKey: boolean }): 'submit' | 'cancel' | 'none' {
  if (args.key === 'Escape') return 'cancel';
  if (args.key === 'Enter' && (args.metaKey || args.ctrlKey)) return 'submit';
  return 'none';
}
