import type { AssistantBlock } from '../../../shared/types';
import { isBuiltinCliCommand } from '../../../shared/builtinCli';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

const PARALLEL_DISPATCH_WINDOW_MS = 500;

export function isParallelGroup(tools: ToolBlock[]): boolean {
  if (tools.length < 2) return false;

  for (const t of tools) {
    if (t.name !== 'bash') return false;
    if (!isBuiltinCliCommand(t.command)) return false;
  }

  const starts = tools
    .map((t) => t.startedAt)
    .filter((x): x is number => Number.isFinite(x));
  if (starts.length === tools.length) {
    const spread = Math.max(...starts) - Math.min(...starts);
    if (spread > PARALLEL_DISPATCH_WINDOW_MS) return false;
  }
  // 时间戳全缺（历史会话）时，仅靠"连续 + 内置 CLI"判定，宽松地视为并行

  return true;
}
