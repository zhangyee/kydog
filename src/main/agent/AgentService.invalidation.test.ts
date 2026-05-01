import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { settingsService } from '../settings/settingsService';
import { agentService } from './AgentService';

function makeFakeBound(threadId: string, providerId: string, modelId: string) {
  const dispose = vi.fn().mockResolvedValue(undefined);
  return {
    threadId, providerId, modelId,
    cwd: '/x', activeMessageId: null,
    session: { prompt: vi.fn(), abort: vi.fn(), subscribe: () => () => undefined, dispose },
    _dispose: dispose,
  };
}

describe('AgentService invalidation entrypoints', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-inv-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
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

  it('invalidateSessionsForProviders: running mark stale，agent_end 后 dispose', async () => {
    const b = makeFakeBound('t1', 'anthropic', 'm');
    (agentService as any).sessions.set('t1', b);
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
});
