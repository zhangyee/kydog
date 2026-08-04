import { validateAnswers } from './askValidate';
import type { AskAnswer, AskOutcome, AskQuestion } from '../../shared/askQuestion';

type Pending = {
  toolCallId: string;
  questions: AskQuestion[];
  resolve: (outcome: AskOutcome) => void;
  detach: () => void;
};

/**
 * 持有挂起的提问 Promise。只做这一件事——不发事件、不碰 session。
 * 事件由 AgentService 统一生产（只有它持有 runId 和 messageId）。
 */
export class QuestionBroker {
  private pending = new Map<string, Pending>();

  /**
   * 注册一个 pending 并返回挂起的 Promise。
   *
   * abort 走 resolve 而不是 reject：reject 会被 pi catch 成 `details: {}` 的
   * error toolResult，事后分辨不出「用户按了停止」和「参数非法」。
   */
  ask(
    threadId: string,
    toolCallId: string,
    questions: AskQuestion[],
    signal: AbortSignal | undefined,
  ): Promise<AskOutcome> {
    if (this.pending.has(threadId)) {
      throw new Error(`thread ${threadId} 已有挂起的提问`);
    }
    return new Promise<AskOutcome>((resolve) => {
      if (signal?.aborted) { resolve({ kind: 'aborted' }); return; }

      const onAbort = () => this.settle(threadId, { kind: 'aborted' });
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(threadId, {
        toolCallId,
        questions,
        resolve,
        detach: () => signal?.removeEventListener('abort', onAbort),
      });
    });
  }

  /**
   * 校验并提交。答案不合法时抛错，pending 保持挂起。
   * 用 validateAnswers 的返回值 resolve —— 入参的 custom 还没 trim。
   */
  submit(threadId: string, toolCallId: string, answers: AskAnswer[]): boolean {
    const p = this.pending.get(threadId);
    if (!p || p.toolCallId !== toolCallId) return false;
    const normalized = validateAnswers(p.questions, answers);
    this.settle(threadId, { kind: 'answered', answers: normalized });
    return true;
  }

  cancel(threadId: string, toolCallId: string): boolean {
    const p = this.pending.get(threadId);
    if (!p || p.toolCallId !== toolCallId) return false;
    this.settle(threadId, { kind: 'cancelled' });
    return true;
  }

  private settle(threadId: string, outcome: AskOutcome): void {
    const p = this.pending.get(threadId);
    if (!p) return;
    this.pending.delete(threadId);
    p.detach();
    p.resolve(outcome);
  }
}

export const questionBroker = new QuestionBroker();
