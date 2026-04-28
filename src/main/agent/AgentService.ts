import { randomUUID } from 'node:crypto';
import { settingsService } from '../settings/settingsService';
import { sessionsDirFor } from '../persist/paths';
import { createSession, type AnySession } from './sessionFactory';
import { transition, type RunState } from './runState';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { KydogError } from '../../shared/errors';
import { normalizePiMessages, type PiMessage } from './messageNormalizer';
import type { Message } from '../../shared/types';

type Bound = { session: AnySession; cwd: string; threadId: string; activeMessageId: string | null };

class AgentService {
  private sessions = new Map<string, Bound>();
  private runs = new Map<string, RunState>();

  getRunState(threadId: string): RunState {
    return this.runs.get(threadId) ?? { status: 'idle' };
  }

  async ensureSession(threadId: string, projectPath: string): Promise<Bound> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;
    const settings = await settingsService.get();
    const provider = settings.llm.provider;
    if (!provider) throw new KydogError('settings.invalid', 'provider not configured');
    const session = await createSession({
      cwd: projectPath,
      sessionId: threadId,
      sessionsDir: sessionsDirFor(projectPath),
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
    });
    const bound: Bound = { session, cwd: projectPath, threadId, activeMessageId: null };
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

  private subscribe(bound: Bound) {
    const { threadId } = bound;
    bound.session.subscribe((evt) => {
      const state = this.runs.get(threadId);
      const runId = state?.status === 'running' ? state.runId : 'unknown';
      switch (evt.type) {
        case 'agent_start':
          broadcaster.emit('run.started', { threadId, runId });
          return;
        case 'message_start':
          bound.activeMessageId = (evt as unknown as { messageId: string }).messageId;
          return;
        case 'message_update': {
          const sub = (evt as unknown as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
          const messageId = (evt as unknown as { messageId?: string }).messageId ?? bound.activeMessageId;
          if (sub?.type === 'text_delta' && messageId && sub.delta) {
            broadcaster.emit('run.message_delta', { threadId, runId, messageId, delta: sub.delta });
          }
          return;
        }
        case 'tool_execution_start': {
          const e = evt as unknown as { toolCallId: string; toolName: string; input?: { command?: string } };
          broadcaster.emit('run.tool_call_start', {
            threadId, runId, toolCallId: e.toolCallId, name: e.toolName, command: e.input?.command,
          });
          return;
        }
        case 'tool_execution_update': {
          const e = evt as unknown as { toolCallId: string; stream: 'stdout' | 'stderr'; chunk: string };
          broadcaster.emit('run.tool_call_chunk', { threadId, runId, toolCallId: e.toolCallId, stream: e.stream, chunk: e.chunk });
          return;
        }
        case 'tool_execution_end': {
          const e = evt as unknown as { toolCallId: string; isError: boolean; exitCode?: number };
          broadcaster.emit('run.tool_call_end', {
            threadId, runId, toolCallId: e.toolCallId,
            status: e.isError ? 'failed' : 'ok', exitCode: e.exitCode,
          });
          return;
        }
        case 'message_end':
          broadcaster.emit('run.message_end', { threadId, runId, messageId: (evt as unknown as { messageId: string }).messageId });
          return;
        case 'agent_end': {
          const e = evt as unknown as { reason: 'completed' | 'aborted' | 'error'; errorMessage?: string };
          const endEvt = e.reason === 'error'
            ? { kind: 'error' as const, message: e.errorMessage ?? 'unknown error' }
            : { kind: e.reason as 'completed' | 'aborted' };
          this.runs.set(threadId, transition(this.runs.get(threadId) ?? { status: 'idle' }, endEvt));
          broadcaster.emit('run.ended', { threadId, runId, reason: e.reason, errorMessage: e.errorMessage });
          return;
        }
        default:
          return;
      }
    });
  }
}

export const agentService = new AgentService();

// Re-export RunState so downstream consumers can import it from this module
export type { RunState } from './runState';
