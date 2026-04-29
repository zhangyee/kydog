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
