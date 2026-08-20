import type { AssistantBlock } from '../../../shared/types';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

export type FileCardEntry = { path: string; size: number | null };

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

export function resolveAgainst(projectPath: string | null, rawPath: string): string | null {
  if (!rawPath) return null;
  if (isAbsolute(rawPath)) return rawPath;
  if (!projectPath) return null;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  const root = projectPath.endsWith(sep) ? projectPath.slice(0, -1) : projectPath;
  return `${root}${sep}${rawPath}`;
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

export function collectFileCards(blocks: AssistantBlock[], projectPath: string | null): FileCardEntry[] {
  const seen = new Map<string, { order: number; size: number | null }>();
  let order = 0;
  for (const b of blocks) {
    if (b.kind !== 'tool_call') continue;
    const w = extractWrite(b);
    if (w === null) continue;
    const abs = resolveAgainst(projectPath, w.raw);
    if (abs === null) continue;
    // 卡片只给「用户会想打开来看」的产物：Markdown 报告与 HTML 报告。
    // 判定与 fileTabHelpers 的 isMarkdownPath / isHtmlPath 保持一致。
    if (!/\.(md|markdown|html?)$/i.test(abs)) continue;
    seen.set(abs, { order: order++, size: w.size });
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

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
