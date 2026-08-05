import { ASK_TOOL_NAME } from '../../shared/askQuestion';

export const BATCH_BLOCK_REASON =
  'ask_user_question 必须单独调用，不能与其他工具放在同一批 tool call 里。请只发起这一个工具调用。';

type ToolCallLike = { type?: string; id?: string; name?: string };

/**
 * 批次独占守卫。
 *
 * 集合是「当前批次」快照，每次 assistant message_end 整体替换，不累加。
 * 不能靠「拦下一个删一个」维护：pi 的 emitToolCall 在第一个返回 block 的
 * handler 处就 return，排在前面的扩展先 block 了的话，本扩展根本收不到那次
 * tool_call。而且 toolCallId 在 session 内不保证唯一，累加既会涨也会污染后续批次。
 */
export function createAskBatchGuard() {
  let illegal = new Set<string>();

  return {
    onAssistantMessageEnd(content: unknown): void {
      const next = new Set<string>();
      if (Array.isArray(content)) {
        const calls = (content as ToolCallLike[]).filter((c) => c?.type === 'toolCall');
        const hasAsk = calls.some((c) => c.name === ASK_TOOL_NAME);
        if (hasAsk && calls.length !== 1) {
          for (const c of calls) if (typeof c.id === 'string') next.add(c.id);
        }
      }
      illegal = next;
    },

    shouldBlock(toolCallId: string): boolean {
      return illegal.has(toolCallId);
    },

    reset(): void {
      illegal = new Set<string>();
    },
  };
}

export type AskBatchGuard = ReturnType<typeof createAskBatchGuard>;
