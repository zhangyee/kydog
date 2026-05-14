import type { AssistantBlock } from '../../../shared/types';
import { isBuiltinCliCommand } from '../../../shared/builtinCli';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

// 协议层并行判定：必须满足
// 1. ≥2 个 tool_call
// 2. 全部共享同一个非空 parallelGroupId（即同一条 pi assistant message 的 content 数组里诞生的兄弟）
// 3. 全部命中内置 CLI 注册表（视觉聚合只对 kydog 关心的 CLI 生效，避免无关 bash 噪声）
//
// 不使用时间戳启发式：startedAt 簇内不能证明协议层并行，跨 message 的串行调用也可能时间紧贴。
export function isParallelGroup(tools: ToolBlock[]): boolean {
  if (tools.length < 2) return false;

  const groupId = tools[0].parallelGroupId;
  if (!groupId) return false;
  for (const t of tools) {
    if (t.parallelGroupId !== groupId) return false;
  }

  for (const t of tools) {
    if (t.name !== 'bash') return false;
    if (!isBuiltinCliCommand(t.command)) return false;
  }

  return true;
}
