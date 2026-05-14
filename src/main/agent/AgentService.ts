import { randomUUID } from 'node:crypto';
import { sessionsDirFor } from '../persist/paths';
import { createSession, type AnySession } from './sessionFactory';
import { transition, type RunState } from './runState';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { KydogError } from '../../shared/errors';
import { normalizePiMessages, type PiMessage } from './messageNormalizer';
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

    const session = await createSession({
      cwd: projectPath,
      sessionId: threadId,
      sessionsDir: sessionsDirFor(projectPath),
      providerId,
      modelId,
    });
    const bound: Bound = {
      session, cwd: projectPath, threadId,
      providerId, modelId,
      activeMessageId: null,
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

  private async markStaleOrDispose(bound: Bound): Promise<void> {
    const state = this.runs.get(bound.threadId);
    if (!state || state.status === 'idle') {
      await this.dispose(bound.threadId);
      return;
    }
    bound.staleAfterRun = true;
  }

  private async maybeTriggerTitleGen(threadId: string): Promise<void> {
    try {
      const { loadIndex } = await import('../persist/indexFile');
      const idx = await loadIndex();
      const thread = idx.threads.find((t) => t.id === threadId);
      if (!thread || thread.title !== '无标题') return;

      const { titleService } = await import('../thread/titleService');
      titleService.generateForThread(threadId, '');
    } catch (err) {
      logger.warn('agent', 'maybeTriggerTitleGen failed', { threadId, err: String(err) });
    }
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
          const e = evt as unknown as { toolCallId: string; isError: boolean; result: unknown };
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
        case 'message_end':
          // No-op: defer flush to agent_end so the buffer survives pi's
          // intra-turn message boundaries (assistant w/ toolcall → toolResult → assistant w/ text).
          return;
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
          const endEvt = reason === 'error'
            ? { kind: 'error' as const, message: errorMessage ?? 'unknown' }
            : { kind: reason };
          this.runs.set(threadId, transition(this.runs.get(threadId) ?? { status: 'idle' }, endEvt));
          broadcaster.emit('run.ended', { threadId, runId, reason, errorMessage });
          if (reason === 'completed') {
            void this.maybeTriggerTitleGen(threadId);
          }
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

// Re-export RunState so downstream consumers can import it from this module
export type { RunState } from './runState';
