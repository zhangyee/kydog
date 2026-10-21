import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { settingsService } from '../settings/settingsService';
vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
vi.mock('./resolveActive', () => ({ resolveActive: vi.fn() }));
vi.mock('./sessionFactory', async (orig) => ({ ...(await orig<typeof import('./sessionFactory')>()), createSession: vi.fn() }));
import type { AskSharedState } from './askUserQuestionTool';
import { createSession } from './sessionFactory';
import { resolveActive } from './resolveActive';
import { browserService } from '../browser/browserService';
import { logger } from '../log';
import { saveIndex, loadIndex } from '../persist/indexFile';
import { promises as fs } from 'node:fs';
import * as atomic from '../persist/atomicWrite';
import { threadService } from '../thread/threadService';
import { broadcaster } from '../ipc/broadcaster';
import { agentService } from './AgentService';

function makeFakeBound(threadId: string, providerId: string, modelId: string) {
  const dispose = vi.fn().mockResolvedValue(undefined);
  return {
    threadId, providerId, modelId,
    cwd: '/x', activeMessageId: null, runId: null as string | null,
    session: { prompt: vi.fn(), abort: vi.fn(), subscribe: () => () => undefined, dispose },
    _dispose: dispose,
  };
}

describe('AgentService invalidation entrypoints', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-inv-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    vi.spyOn(paths, 'WEB_RESEARCH_DIR', 'get').mockReturnValue(path.join(dir, 'web-research'));
    vi.spyOn(paths, 'SESSIONS_DIR', 'get').mockReturnValue(path.join(dir, 'sessions'));
    vi.spyOn(browserService, 'disposeForThread').mockImplementation(() => {});
    (agentService as any).threadLifetimes?.clear();
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    (settingsService as any).cache = null;
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('invalidateSessionsForProviders: idle 立即 dispose', async () => {
    const b = makeFakeBound('t1', 'anthropic', 'claude-sonnet-4-5');
    (agentService as any).sessions.set('t1', b);
    (agentService as any).runs.set('t1', { status: 'idle' });
    await agentService.invalidateSessionsForProviders(['anthropic']);
    expect(b._dispose).toHaveBeenCalled();
    expect((agentService as any).sessions.has('t1')).toBe(false);
  });

  it('invalidateSessionsForProviders: running mark stale，agent_settled 后 dispose', async () => {
    const b = makeFakeBound('t1', 'anthropic', 'm');
    (agentService as any).sessions.set('t1', b);
    b.runId = 'r';
    (agentService as any).runs.set('t1', { status: 'running', runId: 'r', abortRequested: false });
    await agentService.invalidateSessionsForProviders(['anthropic']);
    expect(b._dispose).not.toHaveBeenCalled();
    expect((b as any).staleAfterRun).toBe(true);
  });

  it('invalidateSessionsForProviders: 不匹配 provider 的 thread 不动', async () => {
    const b = makeFakeBound('t1', 'openai', 'gpt');
    (agentService as any).sessions.set('t1', b);
    (agentService as any).runs.set('t1', { status: 'idle' });
    await agentService.invalidateSessionsForProviders(['anthropic']);
    expect(b._dispose).not.toHaveBeenCalled();
  });

  it('invalidateSessionsForThread: 仅作用于 threadId', async () => {
    const a = makeFakeBound('t1', 'anthropic', 'm');
    const b = makeFakeBound('t2', 'anthropic', 'm');
    (agentService as any).sessions.set('t1', a);
    (agentService as any).sessions.set('t2', b);
    (agentService as any).runs.set('t1', { status: 'idle' });
    (agentService as any).runs.set('t2', { status: 'idle' });
    await agentService.invalidateSessionsForThread('t1');
    expect(a._dispose).toHaveBeenCalled();
    expect(b._dispose).not.toHaveBeenCalled();
  });

  it('recomputeSessionsAfterDefaultChange: 有 modelOverride 的 thread 不动', async () => {
    await settingsService.update({ llm: {
      ...(await settingsService.get()).llm,
      defaultProvider: 'openai', defaultModel: 'gpt-4o',
    } });
    const b = makeFakeBound('t1', 'anthropic', 'claude');
    (agentService as any).sessions.set('t1', b);
    (agentService as any).runs.set('t1', { status: 'idle' });
    const { threadService } = await import('../thread/threadService');
    vi.spyOn(threadService, 'listAll').mockResolvedValue([
      { id: 't1', projectPath: '/x', title: '', createdAt: '', lastActiveAt: '',
        modelOverride: { providerId: 'anthropic', modelId: 'claude' } } as any,
    ]);
    await agentService.recomputeSessionsAfterDefaultChange();
    expect(b._dispose).not.toHaveBeenCalled();
  });

  it('recomputeSessionsAfterDefaultChange: 无 override 且 effective 变化 → dispose', async () => {
    await settingsService.update({ llm: {
      ...(await settingsService.get()).llm,
      defaultProvider: 'openai', defaultModel: 'gpt-4o',
    } });
    const b = makeFakeBound('t1', 'anthropic', 'claude');
    (agentService as any).sessions.set('t1', b);
    (agentService as any).runs.set('t1', { status: 'idle' });
    const { threadService } = await import('../thread/threadService');
    vi.spyOn(threadService, 'listAll').mockResolvedValue([
      { id: 't1', projectPath: '/x', title: '', createdAt: '', lastActiveAt: '' } as any,
    ]);
    await agentService.recomputeSessionsAfterDefaultChange();
    expect(b._dispose).toHaveBeenCalled();
  });
  it('toggleDuringCreateAndRetryKeepsRunningSession', async () => {
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'm' });
    const snapshots: boolean[] = [];
    const made: Array<{ dispose: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn>; fire: (event: unknown) => void }> = [];
    let entered!: () => void;
    const atCreate = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(createSession).mockImplementation(async () => {
      snapshots.push((await settingsService.get()).research.xResearchEnabled);
      let listener: (event: unknown) => void = () => {};
      const session = {
        state: { messages: [] },
        dispose: vi.fn(), abort: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn((fn) => { listener = fn; return () => {}; }),
        fire: (event: unknown) => listener(event),
      };
      made.push(session);
      if (made.length === 1) { entered(); await blocked; }
      return session as never;
    });
    const pending = agentService.ensureSession('t1', '/x');
    await atCreate;
    const concurrent = agentService.ensureSession('t1', '/x');
    await settingsService.update({ research: { xResearchEnabled: true } });
    await agentService.invalidateAllSessions();
    release();
    const [a, b] = await Promise.all([pending, concurrent]);
    expect(a).toBe(b);
    expect(snapshots).toEqual([false, true]);
    expect(made[0].dispose).toHaveBeenCalledOnce();
    expect(made[1].subscribe).toHaveBeenCalledOnce();
    expect(made[0].subscribe).not.toHaveBeenCalled();
    const endRun = vi.spyOn(browserService, 'endRun');
    const emit = vi.spyOn(broadcaster, 'emit');
    const control = await agentService.send('t1', '/x', 'control');
    made[1].fire({ type: 'agent_start' });
    agentService.abort('t1');
    expect(made[1].abort).toHaveBeenCalledOnce();
    made[1].fire({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] });
    made[1].fire({ type: 'agent_settled' });
    expect(endRun).toHaveBeenCalledWith(control.runId);
    expect(emit).toHaveBeenCalledWith('run.started', expect.objectContaining({ runId: control.runId }));
    const first = await agentService.send('t1', '/x', 'first');
    made[1].fire({ type: 'agent_start' });
    await settingsService.update({ research: { xResearchEnabled: false } });
    await agentService.invalidateAllSessions();
    expect(agentService.currentRunIdFor('t1')).toBe(first.runId);
    made[1].fire({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'endTurn' }] });
    expect(agentService.getRunState('t1').status).toBe('idle');
    await agentService.invalidateAllSessions();
    endRun.mockClear();
    emit.mockClear();
    await expect(agentService.send('t1', '/x', 'retry-window')).rejects.toMatchObject({ code: 'thread.busy' });
    expect(agentService.currentRunIdFor('t1')).toBe(first.runId);
    expect(emit).not.toHaveBeenCalled();
    expect(endRun).not.toHaveBeenCalled();
    expect(made[1].prompt).toHaveBeenCalledTimes(2);
    made[1].fire({ type: 'agent_start' });
    made[1].fire({ type: 'tool_execution_start', toolCallId: 'retry-call', toolName: 'bash', args: { command: 'offline' } });
    made[1].fire({ type: 'tool_execution_end', toolCallId: 'retry-call', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] }, isError: false });
    made[1].fire({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'endTurn' }] });
    for (const topic of ['run.started', 'run.tool_call_start', 'run.tool_call_end', 'run.ended']) {
      expect(emit).toHaveBeenCalledWith(topic, expect.objectContaining({ runId: first.runId }));
    }
    expect(made[1].dispose).not.toHaveBeenCalled();
    made[1].fire({ type: 'agent_settled' });
    await Promise.resolve();
    expect(endRun).toHaveBeenCalledWith(first.runId);
    expect(emit).toHaveBeenCalledWith('run.ended', expect.objectContaining({ threadId: 't1' }));
    expect(made[1].dispose).toHaveBeenCalledOnce();
    expect(made[1].abort).toHaveBeenCalledOnce();
    const next = await agentService.send('t1', '/x', 'next');
    expect(next.runId).not.toBe(first.runId);
    expect(snapshots).toEqual([false, true, false]);
    expect(made[2].prompt).toHaveBeenCalledWith('next');
    // Actual dispose is already proven; protection above keeps abort unnecessary.
  });

  it('new ensure during invalidation cleanup keeps its replacement cached', async () => {
    const old = makeFakeBound('t1', 'anthropic', 'm');
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    (old.session as any).cleanup = () => { entered(); return pending; };
    (agentService as any).sessions.set('t1', old);
    expect(await agentService.ensureSession('t1', '/x')).toBe(old);
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'm' });
    const fresh = { prompt: vi.fn().mockResolvedValue(undefined), abort: vi.fn(), dispose: vi.fn(), subscribe: vi.fn(), state: { messages: [] } };
    vi.mocked(createSession).mockResolvedValue(fresh as never);
    const invalidating = agentService.invalidateAllSessions();
    await started;
    const replacement = await agentService.ensureSession('t1', '/x');
    finish();
    await invalidating;
    expect(replacement.session).toBe(fresh);
    expect(await agentService.ensureSession('t1', '/x')).toBe(replacement);
    expect(fresh.subscribe).toHaveBeenCalledOnce();
  });

  it('failed new prompt clears a stale session even without agent_settled', async () => {
    let reject!: (error: Error) => void;
    const rejected = new Promise<void>((_, no) => { reject = no; });
    const bound = makeFakeBound('t1', 'anthropic', 'm');
    bound.session.prompt = vi.fn().mockReturnValue(rejected);
    (agentService as any).sessions.set('t1', bound);
    const { runId } = await agentService.send('t1', '/x', 'new');
    await agentService.invalidateAllSessions();
    expect(agentService.currentRunIdFor('t1')).toBe(runId);
    expect(bound._dispose).not.toHaveBeenCalled();
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    reject(new Error('no key'));
    await rejected.catch(() => {});
    await Promise.resolve();
    expect(bound._dispose).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('agent', 'prompt failed', { threadId: 't1', err: 'no key' });
    expect(agentService.hasActiveRunFor('t1')).toBe(false);
  });

  it('late callbacks from a detached old session cannot erase its replacement run', async () => {
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'm' });
    let reject!: (error: Error) => void;
    const rejected = new Promise<void>((_, no) => { reject = no; });
    const sessions: Array<{ fire: (event: unknown) => void; ask: AskSharedState; currentRunId: () => string | null }> = [];
    vi.mocked(createSession).mockImplementation(async (opts) => {
      let listener: (event: unknown) => void = () => {};
      const prompt = sessions.length === 0 ? rejected : Promise.resolve();
      const fake = { state: { messages: [] }, dispose: vi.fn(), abort: vi.fn(), prompt: vi.fn(() => prompt),
        subscribe: (fn: (event: unknown) => void) => { listener = fn; return () => {}; }, fire: (event: unknown) => listener(event) };
      sessions.push({ ...fake, ask: opts.askShared!, currentRunId: opts.currentRunId! });
      return fake as never;
    });
    const emit = vi.spyOn(broadcaster, 'emit');
    const endRun = vi.spyOn(browserService, 'endRun');
    const old = await agentService.send('t1', '/x', 'old');
    expect(sessions[0].currentRunId()).toBe(old.runId);
    sessions[0].fire({ type: 'agent_start' });
    expect(emit).toHaveBeenCalledWith('run.started', expect.objectContaining({ runId: old.runId }));
    await agentService.dispose('t1');
    expect(endRun).toHaveBeenCalledWith(old.runId);
    const replacement = await agentService.send('t1', '/x', 'replacement');
    sessions[1].fire({ type: 'agent_start' });
    expect(agentService.currentRunIdFor('t1')).toBe(replacement.runId);
    expect(sessions[1].currentRunId()).toBe(replacement.runId);
    sessions[1].ask.onOpened('new-ask', []);
    expect(emit).toHaveBeenCalledWith('run.ask_start', expect.objectContaining({ runId: replacement.runId, toolCallId: 'new-ask' }));
    const freshBound = await agentService.ensureSession('t1', '/x');
    expect(freshBound.askOpened.has('new-ask')).toBe(true);
    emit.mockClear(); endRun.mockClear();
    expect(sessions[0].currentRunId()).toBeNull();
    sessions[0].ask.onOpened('old-ask', []);
    sessions[0].ask.onClosed('new-ask', { kind: 'cancelled' });
    expect(freshBound.askOpened.has('old-ask')).toBe(false);
    sessions[0].fire({ type: 'agent_end', messages: [] });
    sessions[0].fire({ type: 'agent_settled' });
    reject(new Error('old rejection'));
    await rejected.catch(() => {});
    await Promise.resolve();
    expect(agentService.currentRunIdFor('t1')).toBe(replacement.runId);
    expect(agentService.getRunState('t1')).toMatchObject({ status: 'running', runId: replacement.runId });
    expect(emit).not.toHaveBeenCalled();
    expect(endRun).not.toHaveBeenCalled();
  });

  it('invalidation snapshot cannot dispose another thread replacement during pending cleanup', async () => {
    const a = makeFakeBound('t1', 'anthropic', 'm');
    const b = makeFakeBound('t2', 'anthropic', 'm');
    let entered!: () => void;
    const atCleanup = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    (a.session as any).cleanup = () => { entered(); return wait; };
    (agentService as any).sessions.set('t1', a);
    (agentService as any).sessions.set('t2', b);
    const pending = agentService.invalidateAllSessions();
    await atCleanup;
    await agentService.dispose('t2');
    expect(b._dispose).toHaveBeenCalledOnce();
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'm' });
    const fresh = { state: { messages: [] }, prompt: vi.fn().mockResolvedValue(undefined), abort: vi.fn(), dispose: vi.fn(), subscribe: vi.fn() };
    vi.mocked(createSession).mockResolvedValue(fresh as never);
    const replacement = await agentService.ensureSession('t2', '/x');
    const { runId } = await agentService.send('t2', '/x', 'new');
    expect(agentService.currentRunIdFor('t2')).toBe(runId);
    finish(); await pending;
    expect(await agentService.ensureSession('t2', '/x')).toBe(replacement);
    expect(agentService.currentRunIdFor('t2')).toBe(runId);
    expect(fresh.dispose).not.toHaveBeenCalled();
  });

  it.each(['send', 'history'] as const)('save at ensure handoff makes %s reacquire the owned session', async (operation) => {
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'm' });
    const made: Array<{ prompt: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
    vi.mocked(createSession).mockImplementation(async () => {
      const session = { state: { messages: [{ role: 'user', content: [{ type: 'text', text: made.length === 0 ? 'old' : 'fresh' }] }] },
        prompt: vi.fn().mockResolvedValue(undefined), abort: vi.fn(), dispose: vi.fn(), subscribe: vi.fn() };
      made.push(session); return session as never;
    });
    vi.spyOn(threadService, 'listAll').mockResolvedValueOnce([{ id: 't1' } as never]).mockResolvedValue([]);
    const original = agentService.ensureSession.bind(agentService);
    let first = true;
    vi.spyOn(agentService, 'ensureSession').mockImplementation(async (threadId, cwd) => {
      const bound = await original(threadId, cwd);
      if (first) {
        first = false;
        await settingsService.update({ research: { xResearchEnabled: true } });
        await agentService.invalidateAllSessions();
      }
      return bound;
    });
    if (operation === 'send') {
      await agentService.send('t1', '/x', 'new');
      expect(made).toHaveLength(2);
      expect(made[1].prompt).toHaveBeenCalledWith('new');
      expect(made[0].prompt).not.toHaveBeenCalled();
    } else {
      const history = await agentService.loadHistory('t1', '/x');
      expect(history.flatMap(m => m.role === 'user' ? [m.content] : [])).toEqual(['fresh']);
    }
    expect(made[0].dispose).toHaveBeenCalledOnce();
    // Same handoff now reports that the thread was deleted: never reconstruct it.
    await agentService.dispose('t1');
    first = true;
    const before = made.length;
    const attempt = operation === 'send' ? agentService.send('t1', '/x', 'deleted') : agentService.loadHistory('t1', '/x');
    await expect(attempt).rejects.toMatchObject({ code: 'thread.not_found' });
    expect(made).toHaveLength(before + 1);
  });

  it.each(['send', 'history'] as const)('real deletion across cleanup refuses a %s handoff while index still contains thread', async (operation) => {
    await saveIndex({ schemaVersion: 1, projects: [{ path: '/x', addedAt: 'fixture' }], threads: [{ id: '11111111-1111-4111-8111-111111111111', projectPath: '/x', title: 'existing', createdAt: 'fixture', lastActiveAt: 'fixture' }] });
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'm' });
    const made: Array<any> = [];
    vi.mocked(createSession).mockImplementation(async () => {
      let listener: (event: unknown) => void = () => {};
      const session = { state: { messages: [{ role: 'user', content: [{ type: 'text', text: 'live' }] }] }, prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), abort: vi.fn(),
        subscribe: vi.fn(fn => { listener = fn; return () => {}; }), fire: (event: unknown) => listener(event) };
      made.push(session); return session as never;
    });
    const act = () => operation === 'send' ? agentService.send('11111111-1111-4111-8111-111111111111', '/x', 'new') : agentService.loadHistory('11111111-1111-4111-8111-111111111111', '/x');
    await act();
    if (operation === 'history') await agentService.send('11111111-1111-4111-8111-111111111111', '/x', 'control');
    made[0].fire({ type: 'agent_start' });
    made[0].fire({ type: 'agent_end', messages: [] });
    made[0].fire({ type: 'agent_settled' });
    expect(made[0].prompt).toHaveBeenCalledOnce();
    expect(made[0].subscribe).toHaveBeenCalledOnce();
    let finish!: () => void;
    const cleanup = new Promise<void>(resolve => { finish = resolve; });
    let entered!: () => void;
    const atCleanup = new Promise<void>(resolve => { entered = resolve; });
    made[0].cleanup = () => { entered(); return cleanup; };
    const original = agentService.ensureSession.bind(agentService);
    let deleting!: Promise<void>;
    let first = true;
    vi.spyOn(agentService, 'ensureSession').mockImplementation(async (id, cwd) => {
      const bound = await original(id, cwd);
      if (first) { first = false; deleting = threadService.delete({ threadIds: ['11111111-1111-4111-8111-111111111111'] }); await atCleanup; }
      return bound;
    });
    const outcome = await act().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect((await loadIndex()).threads.map(t => t.id)).toEqual(['11111111-1111-4111-8111-111111111111']);
    finish(); await deleting;
    expect(outcome.error).toMatchObject({ code: 'thread.not_found' });
    expect(made).toHaveLength(1);
    expect(made[0].prompt).toHaveBeenCalledOnce();
  });

  it.each(['send', 'history'] as const)('real deletion during replacement create prevents %s publication and prompt', async (operation) => {
    await saveIndex({ schemaVersion: 1, projects: [{ path: '/x', addedAt: 'fixture' }], threads: [{ id: '11111111-1111-4111-8111-111111111111', projectPath: '/x', title: 'existing', createdAt: 'fixture', lastActiveAt: 'fixture' }] });
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'm' });
    const made: Array<any> = [];
    let entered!: () => void;
    const atCreate = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const createWait = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(createSession).mockImplementation(async () => {
      let listener: (event: unknown) => void = () => {};
      const session = { state: { messages: [{ role: 'user', content: [{ type: 'text', text: 'live' }] }] }, prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), abort: vi.fn(),
        subscribe: vi.fn(fn => { listener = fn; return () => {}; }), fire: (event: unknown) => listener(event) };
      made.push(session);
      if (made.length === 2) { entered(); await createWait; }
      return session as never;
    });
    const act = () => operation === 'send' ? agentService.send('11111111-1111-4111-8111-111111111111', '/x', 'new') : agentService.loadHistory('11111111-1111-4111-8111-111111111111', '/x');
    await act();
    if (operation === 'history') await agentService.send('11111111-1111-4111-8111-111111111111', '/x', 'control');
    made[0].fire({ type: 'agent_start' }); made[0].fire({ type: 'agent_end', messages: [] }); made[0].fire({ type: 'agent_settled' });
    expect(made[0].subscribe).toHaveBeenCalledOnce(); expect(made[0].prompt).toHaveBeenCalledOnce();
    expect((agentService as any).sessions.has('11111111-1111-4111-8111-111111111111')).toBe(true);
    const original = agentService.ensureSession.bind(agentService);
    let first = true;
    vi.spyOn(agentService, 'ensureSession').mockImplementation(async (id, cwd) => {
      const bound = await original(id, cwd);
      if (first) { first = false; await agentService.invalidateAllSessions(); }
      return bound;
    });
    const outcomePromise = act().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await atCreate;
    expect((await loadIndex()).threads.map(t => t.id)).toEqual(['11111111-1111-4111-8111-111111111111']);
    await threadService.delete({ threadIds: ['11111111-1111-4111-8111-111111111111'] });
    finish(); const outcome = await outcomePromise;
    expect(outcome.error).toMatchObject({ code: 'thread.not_found' });
    expect(made[0].dispose).toHaveBeenCalledOnce();
    expect(made[1].dispose).toHaveBeenCalledOnce();
    expect(made[1].subscribe).not.toHaveBeenCalled();
    expect(made[1].prompt).not.toHaveBeenCalled();
    expect((agentService as any).sessions.has('11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('actual delete lease blocks before dispose, rolls back failed save, and remains deleted after committed cleanup failure', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    await saveIndex({ schemaVersion: 1, projects: [{ path: '/x', addedAt: 'fixture' }], threads: [{ id, projectPath: '/x', title: 'existing', createdAt: 'fixture', lastActiveAt: 'fixture' }] });
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'm' });
    vi.mocked(createSession).mockImplementation(async () => ({ state: { messages: [] }, prompt: vi.fn(), dispose: vi.fn(), subscribe: vi.fn() } as never));
    const initial = await agentService.ensureSession(id, '/x');
    expect(initial.threadId).toBe(id);
    const originalDispose = agentService.dispose.bind(agentService);
    const atDispose: unknown[] = [];
    vi.spyOn(agentService, 'dispose').mockImplementation(async (threadId) => {
      atDispose.push(await agentService.ensureSession(threadId, '/x').then(() => 'allowed', e => e.code));
      return originalDispose(threadId);
    });
    vi.spyOn(atomic, 'atomicWrite').mockRejectedValueOnce(new Error('save failed'));
    await expect(threadService.delete({ threadIds: [id] })).rejects.toThrow('save failed');
    expect(atDispose).toEqual(['thread.not_found']);
    const recovered = await agentService.ensureSession(id, '/x');
    expect(recovered.threadId).toBe(id);
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('postcommit cleanup failed'));
    await expect(threadService.delete({ threadIds: [id] })).rejects.toThrow('postcommit cleanup failed');
    expect(atDispose).toEqual(['thread.not_found', 'thread.not_found']);
    expect((await loadIndex()).threads).toEqual([]);
    await expect(agentService.ensureSession(id, '/x')).rejects.toMatchObject({ code: 'thread.not_found' });
  });

  it('finishing an older deletion lease cannot roll back a newer lifetime', async () => {
    vi.mocked(resolveActive).mockResolvedValue({ providerId: 'anthropic', modelId: 'm' });
    vi.mocked(createSession).mockImplementation(async () => ({ state: { messages: [] }, dispose: vi.fn(), subscribe: vi.fn() } as never));
    expect((await agentService.ensureSession('lease', '/x')).threadId).toBe('lease');
    const old = agentService.beginThreadDeletion(['lease']);
    const newer = agentService.beginThreadDeletion(['lease']);
    old.finish();
    await expect(agentService.ensureSession('lease', '/x')).rejects.toMatchObject({ code: 'thread.not_found' });
    newer.finish();
    expect((await agentService.ensureSession('lease', '/x')).threadId).toBe('lease');
    const committed = agentService.beginThreadDeletion(['lease']);
    committed.commit(); committed.finish();
    await expect(agentService.ensureSession('lease', '/x')).rejects.toMatchObject({ code: 'thread.not_found' });
  });

});
