import type { AssistantBlock } from '../../../shared/types';
import { isHtmlPath } from './markdown/fileTabHelpers';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

export type FileCardEntry = { path: string; size: number | null };

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

/**
 * 折叠 `.` / `..` 与重复分隔符。
 *
 * agent 完全可能写 `edit { path: "./report.html" }`：不折叠的话卡片路径是
 * `/proj/./report.html`，而 watcher 发的 `file.changed` 带的是
 * `/proj/report.html` —— 两串对不上，自动重载静默不触发；文件树双击还会
 * 因为 tab id 不同再开一个 tab，同一个文件出现两份。
 */
function normalizePath(p: string): string {
  const rootMatch = /^(\\\\|\/|[A-Za-z]:[\\/])/.exec(p);
  const root = rootMatch ? rootMatch[0] : '';
  // sep 必须从 root 推，不能看整串——否则 POSIX 路径里文件名字面带的反斜杠
  // 会被误判成 Windows 分隔符，把绝对路径的分隔符整个改写掉。
  const sep = root.includes('\\') || /^[A-Za-z]:/.test(root) ? '\\' : '/';
  const out: string[] = [];
  for (const seg of p.slice(root.length).split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') { out.pop(); continue; }
      if (root !== '') continue; // 已经在根上，`/..` 没有意义
    }
    out.push(seg);
  }
  return root + out.join(sep);
}

export function resolveAgainst(projectPath: string | null, rawPath: string): string | null {
  if (!rawPath) return null;
  if (isAbsolute(rawPath)) return normalizePath(rawPath);
  if (!projectPath) return null;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  const root = projectPath.endsWith(sep) ? projectPath.slice(0, -1) : projectPath;
  return normalizePath(`${root}${sep}${rawPath}`);
}

function extractWrite(tool: ToolBlock): { raw: string; size: number | null } | null {
  if (tool.name !== 'write' || tool.status !== 'ok') return null;
  if (!tool.command) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tool.command);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const a = parsed as Record<string, unknown>;
  const raw = a.file_path ?? a.path;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const size = typeof a.content === 'string' ? new TextEncoder().encode(a.content).length : null;
  return { raw, size };
}

/** edit 不带完整内容，拿不到体积；路径参数名与 write 一致（path / file_path 都收）。 */
function extractEdit(tool: ToolBlock): { raw: string; size: number | null } | null {
  if (tool.name !== 'edit' || tool.status !== 'ok') return null;
  if (!tool.command) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tool.command);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const a = parsed as Record<string, unknown>;
  const raw = a.file_path ?? a.path;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return { raw, size: null };
}

export function collectFileCards(blocks: AssistantBlock[], projectPath: string | null): FileCardEntry[] {
  const seen = new Map<string, { order: number; size: number | null }>();
  let order = 0;
  for (const b of blocks) {
    if (b.kind !== 'tool_call') continue;
    const w = extractWrite(b) ?? extractEdit(b);
    if (w === null) continue;
    const abs = resolveAgainst(projectPath, w.raw);
    if (abs === null) continue;
    // 卡片只给「用户会想打开来看」的产物：Markdown 报告与 HTML 报告。
    // 判定与 fileTabHelpers 的 isMarkdownPath / isHtmlPath 保持一致。
    if (!/\.(md|markdown|html?)$/i.test(abs)) continue;
    // edit 拿不到体积（size 为 null）；同一路径若之前已经从 write 拿到过体积，
    // 不能被后来的 edit 覆盖成空白——保留已知的那个。排序仍按最后一次触达的位置
    // （与去重前 write-only 时的顺序语义保持一致）。
    const prev = seen.get(abs);
    seen.set(abs, {
      order: order++,
      size: w.size ?? prev?.size ?? null,
    });
  }
  return [...seen.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([path, v]) => ({ path, size: v.size }));
}

export function relativePrefix(projectPath: string | null, absPath: string): string {
  if (!projectPath) return '';
  const sep = projectPath.includes('\\') ? '\\' : '/';
  const root = projectPath.endsWith(sep) ? projectPath.slice(0, -1) : projectPath;
  if (!absPath.startsWith(root + sep)) return '';
  const rel = absPath.slice(root.length + sep.length);
  const lastSep = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
  return lastSep < 0 ? '' : rel.slice(0, lastSep + 1);
}

/**
 * 卡片副标题：类型 + 体积。
 *
 * 白名单里有 .md 和 .html 两类，文案必须跟着后缀走 —— learning-deck 报告是
 * `cp` 模板再 `edit` 产出的，`edit` 拿不到内容、size 恒为 null，卡片上只剩
 * 这一句类型文案，写错就是一张写着「Markdown 文档」的 HTML 报告卡片。
 */
export function fileCardMeta(path: string, size: number | null): string {
  const kind = isHtmlPath(path) ? 'HTML 报告' : 'Markdown 文档';
  return size === null ? kind : `${kind} · ${formatBytes(size)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
