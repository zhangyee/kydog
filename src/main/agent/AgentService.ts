import { randomUUID } from 'node:crypto';
import { sessionsDirFor } from '../persist/paths';
import { createSession, type AnySession } from './sessionFactory';
import { transition, type RunState } from './runState';
import { broadcaster, type EventSink } from '../ipc/broadcaster';
import type { EventPayload, RunEvent, RunEventTopic } from '../../shared/protocol';
import { logger } from '../log';
import { KydogError } from '../../shared/errors';
import { normalizePiMessages, type PiMessage } from './messageNormalizer';
import { ASK_TOOL_NAME, type AskOutcome, type AskQuestion } from '../../shared/askQuestion';
import { isParallelBatch, toolCallsOf } from './askSequentialTools';
import type { AskSharedState } from './askUserQuestionTool';
import { settingsService } from '../settings/settingsService';
import { browserService } from '../browser/browserService';
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
  /**
   * 本轮 run 已经广播出去的 run.* 事件，按发出顺序。渲染进程重载后 buffer 全丢，
   * 这份 journal 是把它复原回来的唯一依据 —— 不能改成「重载后重新归一化 pi transcript」：
   * 并行批次里 pi 要等整批 settle 才追加 toolResult（agent-loop.js 的
   * executeToolCallsParallel），在那之前每个工具的 tool_execution_end 早就发过了，
   * transcript 上却还看不出终态。丢掉的是事件，能补回来的也只有事件。
   *
   * 生命周期严格绑在一轮 run 上：agent_start 清空，agent_end 清空。
   */
  runJournal: RunEvent[];
  /**
   * agent_start 那一刻 pi transcript 的长度 —— 即本轮 run 的第一条消息的下标。
   * loadHistory 靠它把「已落定的历史」和「由 journal 复原的 in-flight turn」切开，
   * 免得同一轮既出现在 history 里又出现在 buffer 里。
   */
  runStartIndex: number | null;
  /**
   * 这条 session 此刻在为**哪一轮 KyDog run** 服务。**唯一的写入点**是 `send()` 铸出
   * runId 那一下（另一处是造 bound 时的初始 null）；**清除点有三个**，每一个都顺带把
   * 本轮的标签回收掉，三处同形：
   *  · `agent_settled` 分支 —— pi 正常收尾；
   *  · `send()` 的 catch —— `prompt()` reject，pi 不会补发 `agent_settled`；
   *  · `dispose()` —— session 一拆就永远等不到 settle 了。
   * 少一个出口，这个字段就会**留在那里**：`hasActiveRun()` 从此恒为真（切界面语言永久
   * 被拒）、`currentRunIdFor` 继续拿死掉的 runId 盖戳、那些标签再也没人回收。
   *
   * **不能用 `runs` 现算代替**，两处都栽在同一件事上：
   *  · `agent_settled` 不带任何载荷（`agent-session.d.ts` 的 `{ type:"agent_settled" }`），
   *    而它在 `_runAgentPrompt` 的 `finally` 里发（`agent-session.js:755`），**排在最后
   *    一次 `agent_end` 之后** —— 那时 `runs` 早被下面 agent_end 分支置回 idle，
   *    现算得到 `'unknown'`，`disposeForRun('unknown')` 一个标签都命中不了，
   *    不抛不红，只是永远不回收。
   *  · pi 在 `agent_end` 之后仍可能自动重试（`docs/extensions.md:560`，
   *    `_handlePostAgentRun` → `agent.continue()`）。那一段 `runs` 也是 idle，
   *    而重试里新开的标签仍属于同一轮 KyDog run。
   */
  runId: string | null;
  staleAfterRun?: boolean;
};

/** pi 的 transcript。Adaptation A: handle both real SDK (state.messages) and fake (messages). */
function piMessagesOf(bound: Bound): PiMessage[] {
  return (bound.session.state?.messages ?? bound.session.messages ?? []) as PiMessage[];
}

/**
 * 工具事件要挂在哪一轮上。activeMessageId 在 agent_start 与 agent_end 之间恒非空，
 * 工具执行必然落在这个窗口内，所以 null 是不可达的 —— 真发生了说明不变量破了，
 * 后果是这张工具卡片彻底不出现，必须留下痕迹而不是静默丢弃。写法与上面 askShared 一致。
 */
function toolMessageId(bound: Bound, toolCallId: string): string | null {
  if (!bound.activeMessageId) {
    logger.error('agent', 'tool event without active message', { threadId: bound.threadId, toolCallId });
  }
  return bound.activeMessageId;
}

/** 把一条 run.* 事件广播出去，同时按序记进本轮 journal。 */
function emitRun<T extends RunEventTopic>(bound: Bound, topic: T, payload: EventPayload<T>): void {
  bound.runJournal.push({ topic, payload } as RunEvent);
  broadcaster.emit(topic, payload);
}

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
      onOpened: (toolCallId: string, questions: AskQuestion[], browserTabId?: string) => {
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
        emitRun(b, 'run.ask_start', {
          threadId, runId: this.currentRunId(threadId), messageId, toolCallId, questions,
          // 只在真有值时带上这个键：`undefined` 会原样进 journal，重放时与
          // 「工具压根没给」长得一样倒是没差，但序列化出去的是一个多余的 null 位。
          ...(browserTabId === undefined ? {} : { browserTabId }),
        });
      },
      onClosed: (toolCallId: string, outcome: AskOutcome) => {
        const b = this.sessions.get(threadId);
        const messageId = b?.activeMessageId;
        if (!b || !messageId) {
          logger.error('agent', 'ask closed without active message', { threadId, toolCallId, kind: outcome.kind });
          return;
        }
        emitRun(b, 'run.ask_end', {
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
      // 取值函数，不是值：session 造出来这一刻还没有任何 run 在飞。
      currentRunId: () => this.currentRunIdFor(threadId),
    });
    const bound: Bound = {
      session, cwd: projectPath, threadId,
      providerId, modelId,
      activeMessageId: null,
      askOpened: new Set(),
      askArgs: new Map(),
      runJournal: [],
      runStartIndex: null,
      runId: null,
    };
    this.sessions.set(threadId, bound);
    this.subscribe(bound);
    return bound;
  }

  /**
   * 历史 + 在途 run 的复原。
   *
   * 给了 replay（即调用方是某个具体窗口）时，若这条 thread 有 run 在飞，就把本轮 journal
   * 原样重放给那个窗口。ensureSession 之后这个方法**全程同步**，而 pi 的事件也只在主进程
   * 这一根线程上派发，所以「读 transcript、切历史、重放 journal」这三步之间插不进任何新事件：
   * 重放与其后的实时广播走同一条 EVENT_CHANNEL、先进先出，不重不漏，不需要序号去对齐。
   *
   * 对应地，返回的 messages 要把本轮 in-flight turn 摘掉 —— 它由重放的事件在渲染层的
   * buffer 里重建。留下本轮的 user 消息：直播路径里它本来也是 Composer 直接写进 history 的，
   * 不经过 buffer。
   */
  async loadHistory(threadId: string, projectPath: string, replay?: EventSink): Promise<Message[]> {
    const bound = await this.ensureSession(threadId, projectPath);
    const raw = piMessagesOf(bound);
    const state = this.runs.get(threadId);
    const startIndex = bound.runStartIndex;
    if (state?.status !== 'running' || startIndex === null) return normalizePiMessages(raw, threadId);

    const committed = [
      ...raw.slice(0, startIndex),
      ...raw.slice(startIndex).filter((m) => m.role === 'user'),
    ];
    const messages = normalizePiMessages(committed, threadId);
    if (replay) {
      // 先发 run.resync 作废这个窗口手上关于本轮的一切，再按序重放 journal。
      // 没有这一下，「run 在飞时窗口没打开这条 thread」的情形会出问题：那些事件已经
      // 建过 buffer 了，紧接着重放会把它们再算一遍。journal 是本轮的全量事实，
      // 所以「清空再重建」是安全的，而且顺带把上一轮的残留 buffer 也扫掉。
      replay({ topic: 'run.resync', payload: { threadId, runId: state.runId } });
      for (const event of bound.runJournal) replay(event);
    }
    return messages;
  }

  async send(threadId: string, projectPath: string, content: string): Promise<{ runId: string }> {
    const bound = await this.ensureSession(threadId, projectPath);
    const current = this.getRunState(threadId);
    if (current.status === 'running') throw new KydogError('thread.busy', 'thread is busy');
    const runId = randomUUID();
    this.runs.set(threadId, transition(current, { kind: 'send', runId }));
    // 本轮的 runId 记在 bound 上。**浏览器那两侧都读它**（盖戳的 currentRunIdFor、
    // 回收的 agent_settled），理由见 Bound.runId 那段注释。
    bound.runId = runId;
    void bound.session.prompt(content).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.runs.set(threadId, transition(this.runs.get(threadId)!, { kind: 'error', message: msg }));
      broadcaster.emit('run.ended', { threadId, runId, reason: 'error', errorMessage: msg });
      logger.error('agent', 'prompt failed', { threadId, err: msg });
      // **本轮在这里落地**：pi 的 `agent_settled` 只在 `_runAgentPrompt` 的 finally 里发
      // （`agent-session.js:755`），而 `prompt()` 的 catch（`:792`）排在它被 await 之前就
      // throw 了 —— 没选模型 / OAuth 过期 / 没有 API key / 压缩失败 /
      // `before_agent_start` 扩展抛错，这几条都是「reject 了但从没 settle 过」。
      // 不清的话 `hasActiveRun()` 永远为真，用户此后切界面语言一律被拒（见 Bound.runId）。
      //
      // 相等判断不能省：reject 迟到时 `bound.runId` 可能已经是下一轮的了，
      // 无条件置 null 会把新那一轮的戳抹掉。字段还是本轮的，才轮得到这里收尾 ——
      // 顺带回收本轮的标签，与另外两个出口同形（settled 已经来过时这一支不会进）。
      if (bound.runId === runId) {
        bound.runId = null;
        browserService.disposeForRun(runId);
      }
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
    // **session 一拆，本轮就再也不会 settle 了** —— `agent_settled` 由 pi 的 session 发
    // （`_runAgentPrompt` 的 finally），session 没了就没人发。所以这里补最后
    // 一次回收：不补的话，本轮开的标签带着一个永远等不到 settle 的 `ownerRunId`，
    // 此后任何一轮的 `disposeForRun` 都命中不了它们，它们占着 MAX_TABS 的名额活到进程退出。
    //
    // 读的是 `bound.runId`，与 `agent_settled` / `currentRunIdFor` 同一个字段（见 Bound.runId）：
    // 现算 `runs` 在 pi 的重试窗口里已经是 idle —— 而删线程（threadService.delete 无条件
    // dispose）与切界面语言（localeSet → disposeAllSessions）两条真实入口都能落进那个窗口。
    const abandonedRunId = bound.runId;
    bound.runId = null;
    if (abandonedRunId !== null) browserService.disposeForRun(abandonedRunId);
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

  /**
   * 浏览器工具给新标签盖的那个戳（`ownerRunId`）。没有 run 在飞就是 `null` ——
   * 那时开的标签是用户的，回合结束不该被回收。
   *
   * **读 `bound.runId`，不是现算 `runs`**：pi 在 `agent_end` 之后仍可能自动重试
   * （`docs/extensions.md:560`），那一段 `runs` 已经是 idle，现算会得到 `null`，
   * 于是重试里新开的标签被记成用户的、`agent_settled` 永不回收它们 ——
   * 「标签只增不减直到撞满上限」的另一条路。它与 `disposeForRun` 读的是同一个字段，
   * 盖戳与回收因此不可能对不上。
   */
  currentRunIdFor(threadId: string): string | null {
    return this.sessions.get(threadId)?.runId ?? null;
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
          // 新一轮：上一轮的 journal 到此为止，切开历史的下标也在这一刻定下来。
          // pi 是先发 agent_start 再把 prompt 消息 push 进 transcript 的
          // （agent-loop.js 的 runAgentLoop），所以这里读到的长度正好是本轮第一条消息的下标。
          bound.runJournal = [];
          bound.runStartIndex = piMessagesOf(bound).length;
          emitRun(bound, 'run.started', { threadId, runId });
          return;
        case 'message_start':
          // No-op: keep the run-level activeMessageId so the buffer stays alive
          // across pi's multiple message_start/end pairs within one turn.
          return;
        case 'message_update': {
          // 这里**故意**不查 abort 状态。pi 的 abort 语义是「尽快终止、保留已达、终态标
          // aborted」：agent-loop 的事件泵在发出每条 message_update **之前**就已把 partial
          // 写进它自己的 transcript（streamAssistantResponse），abort 竞态窗口里漏出的
          // delta 是 pi 已持久化的事实。在这儿加闸会让直播画面比重载后从 transcript
          // 恢复的少——制造分歧而不是防御。abort 后事件很快停，是流层收到信号终止
          // （stopReason: 'aborted'）→ runLoop break → agent_end 的协议保证，不靠这里拦。
          const sub = (evt as unknown as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
          const messageId = bound.activeMessageId;
          if (!messageId || !sub) return;
          if (sub.type === 'text_delta' && sub.delta) {
            emitRun(bound, 'run.message_delta', { threadId, runId, messageId, delta: sub.delta });
          } else if (sub.type === 'thinking_delta' && sub.delta) {
            emitRun(bound, 'run.thinking_delta', { threadId, runId, messageId, delta: sub.delta });
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
          const startMessageId = toolMessageId(bound, e.toolCallId);
          if (!startMessageId) return;
          emitRun(bound, 'run.tool_call_start', {
            threadId, runId, messageId: startMessageId, toolCallId: e.toolCallId, name: e.toolName, command,
          });
          return;
        }
        case 'tool_execution_update':
          // Skip updates — full result text is emitted at tool_execution_end to avoid duplication
          return;
        case 'tool_execution_end': {
          const e = evt as unknown as { toolCallId: string; toolName: string; isError: boolean; result: unknown };
          const messageId = toolMessageId(bound, e.toolCallId);
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
            if (!messageId) return;
            emitRun(bound, 'run.tool_call_start', {
              threadId, runId, messageId, toolCallId: e.toolCallId, name: e.toolName,
              command: JSON.stringify(cached?.args ?? {}),
            });
            const errText = extractToolResultText(e.result);
            if (errText) {
              emitRun(bound, 'run.tool_call_chunk', {
                threadId, runId, messageId, toolCallId: e.toolCallId, stream: 'stderr', chunk: errText,
              });
            }
            emitRun(bound, 'run.tool_call_end', {
              threadId, runId, messageId, toolCallId: e.toolCallId, status: 'failed',
            });
            return;
          }
          if (!messageId) return;
          const chunk = extractToolResultText(e.result);
          if (chunk) {
            emitRun(bound, 'run.tool_call_chunk', {
              threadId, runId, messageId, toolCallId: e.toolCallId, stream: e.isError ? 'stderr' : 'stdout', chunk,
            });
          }
          emitRun(bound, 'run.tool_call_end', {
            threadId, runId, messageId, toolCallId: e.toolCallId,
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
            emitRun(bound, 'run.parallel_group', {
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
          if (messageId) emitRun(bound, 'run.message_end', { threadId, runId, messageId });
          bound.activeMessageId = null;
          // tool_execution_end 是正常的清理点；run 异常退出时它可能不发，
          // 所以这里兜一次底，免得条目跨轮残留。
          bound.askOpened.clear();
          bound.askArgs.clear();
          const endEvt = reason === 'error'
            ? { kind: 'error' as const, message: errorMessage ?? 'unknown' }
            : { kind: reason };
          this.runs.set(threadId, transition(this.runs.get(threadId) ?? { status: 'idle' }, endEvt));
          // run.ended 不进 journal：它一到就说明这轮不在飞了，journal 到此作废。
          bound.runJournal = [];
          bound.runStartIndex = null;
          broadcaster.emit('run.ended', { threadId, runId, reason, errorMessage });
          if (bound.staleAfterRun) {
            void this.dispose(threadId);
          }
          return;
        }
        case 'agent_settled': {
          // **挂在这里，不是 agent_end** —— pi 在 agent_end 之后仍可能自动重试
          // （docs/extensions.md:560），那时标签还属于同一轮 KyDog run。
          // 回收用 bound.runId 而不是上面那个现算的 runId：这一刻 runs 已被
          // agent_end 置回 idle，现算是 `'unknown'`，拿它去比 ownerRunId 一个都
          // 命中不了 —— 不抛、不红，只是永远不回收（见 Bound.runId）。
          const settledRunId = bound.runId;
          bound.runId = null;
          if (settledRunId !== null) browserService.disposeForRun(settledRunId);
          return;
        }
        default:
          return;
      }
    });
  }

  /**
   * 有没有正在跑的 run。locale.set 靠它决定是否拒绝切换。
   *
   * **读 `bound.runId`，不是现算 `runs`** —— 与 `currentRunIdFor` / `agent_settled` 同一个
   * 字段。`runs` 在 `agent_end` 就被置回 idle，而 pi 在那之后仍可能自动重试
   * （`docs/extensions.md:560`）：拿 `runs` 当闸，用户在重试窗口里切语言会被放行，
   * 而 locale.set 那段注释写明的前提正是「切换时没有 run 在跑」。
   * `bound.runId` 恰好活在 `send()` 到本轮落地之间（三个出口，见 `Bound.runId`），
   * 就是那个前提本身 —— 其中 `send()` 的 catch 那个出口是必需的：`prompt()` reject
   * （没配 key / OAuth 过期）时 pi 不发 `agent_settled`，漏了它这道闸就再也开不回来。
   */
  hasActiveRun(): boolean {
    return [...this.sessions.values()].some((b) => b.runId !== null);
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
