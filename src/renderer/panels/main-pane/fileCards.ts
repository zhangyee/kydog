import type { AssistantBlock } from '../../../shared/types';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

export function resolveAgainst(projectPath: string | null, rawPath: string): string | null {
  if (!rawPath) return null;
  if (isAbsolute(rawPath)) return rawPath;
  if (!projectPath) return null;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  const root = projectPath.endsWith(sep) ? projectPath.slice(0, -1) : projectPath;
  return `${root}${sep}${rawPath}`;
}

function extractWritePath(tool: ToolBlock): string | null {
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
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export function collectFileCards(blocks: AssistantBlock[], projectPath: string | null): string[] {
  const seen = new Map<string, number>();
  let order = 0;
  for (const b of blocks) {
    if (b.kind !== 'tool_call') continue;
    const raw = extractWritePath(b);
    if (raw === null) continue;
    const abs = resolveAgainst(projectPath, raw);
    if (abs === null) continue;
    if (!abs.toLowerCase().endsWith('.md')) continue;
    seen.set(abs, order);
    order++;
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
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
