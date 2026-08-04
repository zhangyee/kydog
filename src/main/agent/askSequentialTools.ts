import { ASK_TOOL_NAME } from '../../shared/askQuestion';

/** KyDog 注册的 executionMode: 'sequential' 工具。加新的记得同步。 */
export const SEQUENTIAL_TOOL_NAMES: ReadonlySet<string> = new Set([ASK_TOOL_NAME]);

type ContentLike = { type?: string; id?: string; name?: string };

/** 从一条 assistant message 的 content 里取出全部 toolCall。 */
export function toolCallsOf(content: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(content)) return [];
  return (content as ContentLike[])
    .filter((c) => c?.type === 'toolCall' && typeof c.id === 'string')
    .map((c) => ({ id: c.id as string, name: typeof c.name === 'string' ? c.name : '' }));
}

/**
 * 这一批是否真的并行执行。
 *
 * pi：`toolCalls.some(t => t.executionMode === 'sequential')` 为真时整批串行
 * （agent-loop.js:256）。所以只数个数是不够的。
 */
export function isParallelBatch(content: unknown): boolean {
  const calls = toolCallsOf(content);
  if (calls.length < 2) return false;
  return !calls.some((c) => SEQUENTIAL_TOOL_NAMES.has(c.name));
}
