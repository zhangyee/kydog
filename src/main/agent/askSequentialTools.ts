import { ASK_TOOL_NAME } from '../../shared/askQuestion';

/**
 * KyDog 注册的 executionMode: 'sequential' 工具。加新的记得同步。
 *
 * 名字写成字面量而不是从 `browserTools.ts` import：那个模块 import
 * `browserService`，而 `browserService` import 的是 electron 的
 * `WebContentsView` / `session` —— 本模块被 `AgentService` 与一堆纯逻辑用例引用，
 * 不该为四个字符串把整条 electron 依赖拖进来。**两边不漂由用例守**：
 * `sessionFactory.browserTools.test.ts` 拿真正交给 pi 的那份 `customTools`
 * 与本名单做双向比对（少登记、以及登记了却没注册，都会红）。
 */
export const SEQUENTIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  ASK_TOOL_NAME,
  'browser_open',
  'browser_act',
  'browser_read',
  'browser_login',
  'browser_download',
]);

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
