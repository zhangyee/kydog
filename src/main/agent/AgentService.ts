import { randomUUID } from 'node:crypto';
import { sessionsDirFor } from '../persist/paths';
import { createSession, type AnySession } from './sessionFactory';
import { transition, type RunState } from './runState';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { KydogError } from '../../shared/errors';
import { normalizePiMessages, type PiMessage } from './messageNormalizer';
import { ASK_TOOL_NAME, type AskOutcome, type AskQuestion } from '../../shared/askQuestion';
import { isParallelBatch, toolCallsOf } from './askSequentialTools';
import type { AskSharedState } from './askUserQuestionTool';
import { settingsService } from '../settings/settingsService';
import { resolveProviderDefault } from '../llm/resolveProvider';
import { threadService } from '../thread/threadService';
import type { Message, ProviderId } from '../../shared/types';

export type Bound = {
  session: AnySession;
  cwd: string;
  threadId: string;
  providerId: ProviderId;
  modelId: string;
  activeMessageId: string | null;
  /** 已经发出过 run.ask_start 的 toolCallId。tool_execution_end 靠它二分。 */
  askOpened: Set<string>;
  /** tool_execution_end 不带 args，所以在被抑制的 start 上缓存下来。 */
  askArgs: Map<string, { toolName: string; args: unknown }>;
  staleAfterRun?: boolean;
};

class AgentService {
  private sessions = new Map<string, Bound>();
  private runs = new Map<string, RunState>();

  getRunState(threadId: string): RunState {
    return this.runs.get(threadId) ?? { status: 'idle' };
  }

  async ensureSession(threadId: string, projectPath: string): Promise<Bound> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;

    const { resolveActive } = await import('./resolveActive');
    const { providerId, modelId } = await resolveActive(threadId, projectPath);

    // 工具 → AgentService 的上行通道。这里补上 runId / messageId 再对外广播：
    // 只有工具知道 pending 何时真正就绪，所以事件必须由它触发，不能挂在
    // pi 的 tool_execution_start 上（那时还没校验、没分配 id、broker 也没注册）。
    const askShared: AskSharedState = {
      onOpened: (toolCallId: string, questions: AskQuestion[]) => {
        const b = this.sessions.get(threadId);
        const messageId = b?.activeMessageId;
        if (!b || !messageId) {
          // 不可达：activeMessageId 在 agent_start 与 agent_end 之间恒非空，
          // 工具执行必然落在窗口内。真发生了说明这个不变量被破坏了——
          // 后果是工具已在 await pending 而 UI 从未打开，run 会一直挂着，
          // 所以必须留下痕迹而不是静默。
          logger.error('agent', 'ask opened without active message', { threadId, toolCallId });
          return;
        }
        b.askOpened.add(toolCallId);
        broadcaster.emit('run.ask_start', {
          threadId, runId: this.currentRunId(threadId), messageId, toolCallId, questions,
        });
      },
      onClosed: (toolCallId: string, outcome: AskOutcome) => {
        const b = this.sessions.get(threadId);
        const messageId = b?.activeMessageId;
        if (!b || !messageId) {
          logger.error('agent', 'ask closed without active message', { threadId, toolCallId, kind: outcome.kind });
          return;
        }
        broadcaster.emit('run.ask_end', {
          threadId, runId: this.currentRunId(threadId), messageId, toolCallId, outcome,
        });
      },
    };

    const session = await createSession({
      cwd: projectPath,
      sessionId: threadId,
      sessionsDir: sessionsDirFor(projectPath),
      providerId,
      modelId,
      askShared,
    });
    const bound: Bound = {
      session, cwd: projectPath, threadId,
      providerId, modelId,
      activeMessageId: null,
      askOpened: new Set(),
      askArgs: new Map(),
    };
    this.sessions.set(threadId, bound);
    this.subscribe(bound);
    return bound;
  }

  async loadHistory(threadId: string, projectPath: string): Promise<Message[]> {
    const bound = await this.ensureSession(threadId, projectPath);
    // Adaptation A: handle both real SDK (messages) and fake (state.messages)
    const raw = bound.session.state?.messages ?? bound.session.messages ?? [];
    return normalizePiMessages(raw as PiMessage[]);
  }

  async send(threadId: string, projectPath: string, content: string): Promise<{ runId: string }> {
    const bound = await this.ensureSession(threadId, projectPath);
    const current = this.getRunState(threadId);
    if (current.status === 'running') throw new KydogError('thread.busy', 'thread is busy');
    const runId = randomUUID();
    this.runs.set(threadId, transition(current, { kind: 'send', runId }));
    void bound.session.prompt(content).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.runs.set(threadId, transition(this.runs.get(threadId)!, { kind: 'error', message: msg }));
      broadcaster.emit('run.ended', { threadId, runId, reason: 'error', errorMessage: msg });
      logger.error('agent', 'prompt failed', { threadId, err: msg });
    });
    return { runId };
  }

  abort(threadId: string): void {
    const bound = this.sessions.get(threadId);
    const state = this.runs.get(threadId);
    if (!bound || !state || state.status !== 'running') return;
    this.runs.set(threadId, transition(state, { kind: 'abort' }));
    // Adaptation C: handle both void (fake) and Promise<void> (real), swallow abort errors
    void Promise.resolve(bound.session.abort()).catch((err) =>
      logger.warn('agent', 'abort failed', { threadId, err: String(err) })
    );
  }

  async dispose(threadId: string): Promise<void> {
    const bound = this.sessions.get(threadId);
    if (!bound) return;
    // Adaptation B: fake has cleanup(), real has dispose()
    if (bound.session.cleanup) await bound.session.cleanup();
    else if (bound.session.dispose) bound.session.dispose();
    this.sessions.delete(threadId);
    this.runs.delete(threadId);
  }

  private currentRunId(threadId: string): string {
    const s = this.runs.get(threadId);
    return s?.status === 'running' ? s.runId : 'unknown';
  }

  private async markStaleOrDispose(bound: Bound): Promise<void> {
    const state = this.runs.get(bound.threadId);
    if (!state || state.status === 'idle') {
      await this.dispose(bound.threadId);
      return;
    }
    bound.staleAfterRun = true;
  }


  async invalidateSessionsForProviders(providerIds: ProviderId[]): Promise<void> {
    const set = new Set(providerIds);
    for (const bound of [...this.sessions.values()]) {
      if (set.has(bound.providerId)) await this.markStaleOrDispose(bound);
    }
  }

  async invalidateSessionsForThread(threadId: string): Promise<void> {
    const bound = this.sessions.get(threadId);
    if (bound) await this.markStaleOrDispose(bound);
  }

  async recomputeSessionsAfterDefaultChange(): Promise<void> {
    const settings = await settingsService.get();
    const allThreads = await threadService.listAll();
    const threadById = new Map(allThreads.map((t) => [t.id, t]));
    for (const bound of [...this.sessions.values()]) {
      const t = threadById.get(bound.threadId);
      if (t?.modelOverride) continue;
      const expectedProviderId = settings.llm.defaultProvider;
      const expectedModelId = expectedProviderId
        ? (resolveProviderDefault(settings, expectedProviderId) ?? settings.llm.defaultModel)
        : null;
      if (bound.providerId !== expectedProviderId || bound.modelId !== expectedModelId) {
        await this.markStaleOrDispose(bound);
      }
    }
  }

  private subscribe(bound: Bound) {
    const { threadId } = bound;
    bound.session.subscribe((evt) => {
      const state = this.runs.get(threadId);
      const runId = state?.status === 'running' ? state.runId : 'unknown';
      switch (evt.type) {
        case 'agent_start':
          // Synthesize one messageId per RUN (not per pi message_start) so that
          // thinking + tool calls + final text from pi's multiple messages within
          // one turn all attach to the same buffer. Tool calls fire AFTER pi's
          // first message_end, so consuming the buffer at message_end loses them.
          bound.activeMessageId = `${threadId}:${randomUUID()}`;
          broadcaster.emit('run.started', { threadId, runId });
          return;
        case 'message_start':
          // No-op: keep the run-level activeMessageId so the buffer stays alive
          // across pi's multiple message_start/end pairs within one turn.
          return;
        case 'message_update': {
          const sub = (evt as unknown as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
          const messageId = bound.activeMessageId;
          if (!messageId || !sub) return;
          if (sub.type === 'text_delta' && sub.delta) {
            broadcaster.emit('run.message_delta', { threadId, runId, messageId, delta: sub.delta });
          } else if (sub.type === 'thinking_delta' && sub.delta) {
            broadcaster.emit('run.thinking_delta', { threadId, runId, messageId, delta: sub.delta });
          }
          return;
        }
        case 'tool_execution_start': {
          const e = evt as unknown as { toolCallId: string; toolName: string; args?: { command?: string } };
          if (e.toolName === ASK_TOOL_NAME) {
            // 抑制对外事件：这时还没校验、没分配 id、broker 也没注册，
            // 照它开 UI 会让非法参数和非法批次也闪一下提问界面。
            // 但它是 { toolName, args } 的唯一来源（tool_execution_end 不带 args），
            // 所以缓存起来供回退路径用。
            bound.askArgs.set(e.toolCallId, { toolName: e.toolName, args: e.args });
            return;
          }
          const command = typeof e.args?.command === 'string' ? e.args.command : JSON.stringify(e.args ?? {});
          broadcaster.emit('run.tool_call_start', {
            threadId, runId, toolCallId: e.toolCallId, name: e.toolName, command,
          });
          return;
        }
        case 'tool_execution_update':
          // Skip updates — full result text is emitted at tool_execution_end to avoid duplication
          return;
        case 'tool_execution_end': {
          const e = evt as unknown as { toolCallId: string; toolName: string; isError: boolean; result: unknown };
          if (e.toolName === ASK_TOOL_NAME) {
            const cached = bound.askArgs.get(e.toolCallId);
            bound.askArgs.delete(e.toolCallId);
            if (bound.askOpened.delete(e.toolCallId)) {
              // 提问确实开过，结束事件已由 shared.onClosed 发出，这里什么都不做。
              return;
            }
            // 从没开过（校验失败、批次非法、其他异常）→ 补发一对普通工具事件，
            // 渲染成失败的工具卡片。chunk 必须带上，否则实时只有「失败」两个字、
            // 重启后从 session 恢复却能展开看到错误详情。
            broadcaster.emit('run.tool_call_start', {
              threadId, runId, toolCallId: e.toolCallId, name: e.toolName,
              command: JSON.stringify(cached?.args ?? {}),
            });
            const errText = extractToolResultText(e.result);
            if (errText) {
              broadcaster.emit('run.tool_call_chunk', {
                threadId, runId, toolCallId: e.toolCallId, stream: 'stderr', chunk: errText,
              });
            }
            broadcaster.emit('run.tool_call_end', {
              threadId, runId, toolCallId: e.toolCallId, status: 'failed',
            });
            return;
          }
          const chunk = extractToolResultText(e.result);
          if (chunk) {
            broadcaster.emit('run.tool_call_chunk', {
              threadId, runId, toolCallId: e.toolCallId, stream: e.isError ? 'stderr' : 'stdout', chunk,
            });
          }
          broadcaster.emit('run.tool_call_end', {
            threadId, runId, toolCallId: e.toolCallId,
            status: e.isError ? 'failed' : 'ok',
          });
          return;
        }
        case 'message_end': {
          // 协议层并行判定：读 message_end 携带的 message.content（这是协议事实，
          // 因为 pi 的 tool_execution_start 在 message_end **之后**才发）。
          // 注意不能只数个数：批次里只要有一个 executionMode: 'sequential' 的工具，
          // pi 就把整批拖成串行（agent-loop.js:256）。
          const e = evt as unknown as { message?: { role?: string; content?: unknown } };
          const msg = e.message;
          if (msg?.role === 'assistant' && bound.activeMessageId && isParallelBatch(msg.content)) {
            broadcaster.emit('run.parallel_group', {
              threadId, runId,
              messageId: bound.activeMessageId,
              toolCallIds: toolCallsOf(msg.content).map((c) => c.id),
              parallelGroupId: randomUUID(),
            });
          }
          // Defer buffer flush to agent_end so the buffer survives pi's
          // intra-turn message boundaries (assistant w/ toolcall → toolResult → assistant w/ text).
          return;
        }
        case 'agent_end': {
          const e = evt as unknown as { messages: Array<{ role?: string; stopReason?: string; errorMessage?: string }> };
          const last = e.messages[e.messages.length - 1];
          let reason: 'completed' | 'aborted' | 'error' = 'completed';
          let errorMessage: string | undefined;
          if (last?.role === 'assistant') {
            if (last.stopReason === 'aborted') reason = 'aborted';
            else if (last.stopReason === 'error') { reason = 'error'; errorMessage = last.errorMessage; }
          }
          if (reason === 'error') {
            logger.error('agent', 'run ended with error', { threadId, runId, providerId: bound.providerId, modelId: bound.modelId, errorMessage });
          }
          // Flush the run's accumulated buffer as one assistant message
          const messageId = bound.activeMessageId;
          if (messageId) broadcaster.emit('run.message_end', { threadId, runId, messageId });
          bound.activeMessageId = null;
          // tool_execution_end 是正常的清理点；run 异常退出时它可能不发，
          // 所以这里兜一次底，免得条目跨轮残留。
          bound.askOpened.clear();
          bound.askArgs.clear();
          const endEvt = reason === 'error'
            ? { kind: 'error' as const, message: errorMessage ?? 'unknown' }
            : { kind: reason };
          this.runs.set(threadId, transition(this.runs.get(threadId) ?? { status: 'idle' }, endEvt));
          broadcaster.emit('run.ended', { threadId, runId, reason, errorMessage });
          if (bound.staleAfterRun) {
            void this.dispose(threadId);
          }
          return;
        }
        default:
          return;
      }
    });
  }

  /** 有没有正在跑的 run。locale.set 靠它决定是否拒绝切换。 */
  hasActiveRun(): boolean {
    return [...this.runs.values()].some((s) => s.status === 'running');
  }

  /**
   * 丢弃全部 session。
   *
   * 只在「已确认没有 run 在跑」之后调用，所以不需要 markStaleOrDispose 那套延后逻辑。
   * 线程历史在文件里，下次访问会重建 session，自然拿到新语言的 skill 树。
   */
  async disposeAllSessions(): Promise<void> {
    for (const bound of [...this.sessions.values()]) {
      await this.dispose(bound.threadId);
    }
  }
}

function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .filter((c): c is { type: string; text?: string } => !!c && typeof c === 'object' && 'type' in c)
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('');
    }
    return JSON.stringify(result);
  }
  return String(result);
}

export const agentService = new AgentService();
