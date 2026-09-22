import type { SkillEntry } from '../../../shared/types';
import { parseMentionQuery } from './mentionSearch';

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
    // 输入法组字中的键是输入法自己的：↵ 在确认候选词、Esc 在撤销组字、方向键在挑候选。
    // 必须排在菜单接管之前 —— 否则 @ 列表开着时，确认拼音的那一下 ↵ 会被当成「插入高亮项」。
    // 菜单没开时照旧走下面：⌘↵ 组字中也发送（by spec），只有裸 ↵ 被组字挡住。
    if (args.isComposing) return { kind: 'ignore' };
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
 * [A-Za-z0-9_.-] 的字符 —— 中文「对比@dpo」要能触发，`a@b.com` 不触发。
 *
 * 两种写法（spec §3.5）：
 * - 不带引号：查询词里不含空白与 @，也不以 `"` 开头；
 * - `@"` 开头：查询词是引号之后到光标的文字（`query` 里不含引号），允许空格与 @，不跨行；
 *   打出收尾的 `"` 就结束（返回 null）。名字里有空白或 @ 的路径只能这样写。
 */
export function mentionQueryAt(textBeforeCaret: string): { query: string; start: number; quoted: boolean } | null {
  const q = /(^|[^A-Za-z0-9_.-])@"([^"\n\r]*)$/.exec(textBeforeCaret);
  if (q) return { query: q[2], start: q.index + q[1].length, quoted: true };
  const m = /(^|[^A-Za-z0-9_.-])@(?!")([^\s@]*)$/.exec(textBeforeCaret);
  if (!m) return null;
  return { query: m[2], start: m.index + m[1].length, quoted: false };
}

/**
 * 文本里从 `start`（一个 `@` 的位置）起的 @ 词 —— ComposerEditor 用它认「还是不是 Esc 关掉的那个 @」：
 * 词没变就还是它；接着打字、删字，词就变了。
 * - 不带引号：`@` 加上后面连续的非空白、非 @ 字符，与光标停在词里的哪儿无关。
 * - 引号写法：`@"` 起到光标（`caret`）为止。引号词里允许空格，除了光标没有别的界：往后找收尾的 `"`
 *   会找到正文里一个无关的引号（`@"Rel "这个"`），那段正文一改，词就「变了」。
 */
export function mentionTokenAt(text: string, start: number, caret: number): string {
  if (text.startsWith('@"', start)) return text.slice(start, Math.max(start + 2, caret));
  return /^@[^\s@]*/.exec(text.slice(start))?.[0] ?? '';
}

/**
 * 插标签时从 `@` 换到哪儿为止（spec §3.5：整段 `@"…` 一起换掉）：引号写法里、收尾的 `"` 正好在光标上时
 * 连它一起换（不在标签后面留半个引号）；否则只换到光标 —— 光标后面的字不属于这个查询词，哪怕再往后
 * 有一个 `"`（那是正文里的引号：`请看 @"Rel| "这个" 的结论`）。
 */
export function mentionReplaceEnd(text: string, caret: number, quoted: boolean): number {
  return quoted && text[caret] === '"' ? caret + 1 : caret;
}

/**
 * @ 列表里选中文件夹时，写回 `@` 之后的文字（进入下一层）：名字里有空白或 @、或者已经在引号里浏览，
 * 写成 `"<rel>/`；否则 `<rel>/`。写出来的文字要走得通整条路：`mentionQueryAt` 解析回 `<rel>/`、会话的
 * `parseMentionQuery` 再解析出目录 `<rel>` —— 名字里有 `"`（引号断掉）或 `\`（逐级浏览把它当分隔符）时
 * 走不通，返回 null（不写一个坏掉的查询词；spec：这种文件夹不支持进入）。
 */
export function folderMentionText(rel: string, quoted: boolean): string | null {
  const text = quoted || /[\s@]/.test(rel) ? `"${rel}/` : `${rel}/`;
  const back = mentionQueryAt(`@${text}`);
  if (back === null || back.query !== `${rel}/`) return null;
  const parsed = parseMentionQuery(back.query);
  return parsed.mode === 'browse' && parsed.dir === rel && parsed.leaf === '' ? text : null;
}

/**
 * 批注框的按键（spec §1.4）：只有 ⌘↵ / Ctrl↵ 添加；↵、⇧↵ 交给文本框换行；Esc 取消。
 * 输入法组字中一律不管：那一下 Esc 是撤销组字、↵ 是确认候选词，不该把写了一半的批注取消 / 交掉。
 */
export function dispatchCommentBoxKey(args: { key: string; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }): 'submit' | 'cancel' | 'none' {
  if (args.isComposing) return 'none';
  if (args.key === 'Escape') return 'cancel';
  if (args.key === 'Enter' && (args.metaKey || args.ctrlKey)) return 'submit';
  return 'none';
}
