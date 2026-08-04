import { createAskBatchGuard, BATCH_BLOCK_REASON, type AskBatchGuard } from './askBatchGuard';

type PiExtensionApi = {
  on(event: string, handler: (evt: unknown) => unknown): void;
};

/**
 * 把批次守卫接到 pi 的扩展事件上。
 *
 * pi 的 `beforeToolCall` 被 coding-agent 接给了扩展的 `tool_call` 事件
 * （agent-session.js:179），返回 `{ block: true }` 会阻止执行并产出 error
 * toolResult。它在 execute 之前对批次内每个调用都跑，所以兄弟工具一个都不会执行。
 *
 * 返回 guard 仅供测试断言；生产代码不需要持有它。
 */
export function createAskBatchExtension(): {
  guard: AskBatchGuard;
  factory: (pi: PiExtensionApi) => void;
} {
  const guard = createAskBatchGuard();

  const factory = (pi: PiExtensionApi) => {
    pi.on('message_end', (evt) => {
      const message = (evt as { message?: { role?: string; content?: unknown } })?.message;
      if (message?.role !== 'assistant') return;
      guard.onAssistantMessageEnd(message.content);
    });

    pi.on('tool_call', (evt) => {
      const id = (evt as { toolCallId?: string })?.toolCallId;
      if (typeof id === 'string' && guard.shouldBlock(id)) {
        return { block: true, reason: BATCH_BLOCK_REASON };
      }
      return undefined;
    });

    pi.on('agent_end', () => guard.reset());
  };

  return { guard, factory };
}
