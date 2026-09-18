import type { AssistantBlock } from '../../../shared/types';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

export function toolLabel(tool: ToolBlock): string {
  return tool.name || 'tool';
}

function commandLabel(command?: string): string | null {
  const token = command?.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : null;
}

export function groupToolLabel(tool: ToolBlock): string {
  if (tool.name === 'bash') return commandLabel(tool.command) ?? tool.name;
  return toolLabel(tool);
}

/** 展开了、但工具还没返回时，输出区的位置上显示这句。 */
export const RUNNING_OUTPUT_PLACEHOLDER = '运行中，结果回来后显示在这里';

/**
 * 能不能展开：有输出，或者有命令。
 *
 * 命令在工具开始那一刻就随 `run.tool_call_start` 到了，输出要等工具结束才一次性发过来
 * （AgentService 不转发 tool_execution_update）。只看输出的话，跑着的工具点不开 ——
 * 一批并行调用全显示成同一个命令头，哪条卡住了看不出来。
 */
export function toolExpandable(tool: ToolBlock): boolean {
  return tool.chunks.length > 0 || !!tool.command;
}

export function toolStatusLabel(status: ToolBlock['status']): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'failed':
      return '失败';
    default:
      return '完成';
  }
}

export function groupToolLabelSummary(tools: ToolBlock[], limit = 3): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const label = groupToolLabel(tool);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const labels = Array.from(counts.entries()).map(([label, count]) =>
    count > 1 ? `${label} ×${count}` : label
  );

  if (labels.length <= limit) return labels.join(' · ');
  return `${labels.slice(0, limit).join(' · ')} +${labels.length - limit}`;
}

export function groupStatusSummary(tools: ToolBlock[]): string {
  const counts = { running: 0, ok: 0, failed: 0 };
  for (const tool of tools) counts[tool.status] += 1;
  if (counts.ok === tools.length) return '全部完成';
  if (counts.failed === tools.length) return '全部失败';
  if (counts.running === tools.length) return '全部运行中';
  const parts: string[] = [];
  if (counts.running) parts.push(`运行中 ${counts.running}`);
  if (counts.ok) parts.push(`完成 ${counts.ok}`);
  if (counts.failed) parts.push(`失败 ${counts.failed}`);
  return parts.join(' · ');
}
