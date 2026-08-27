import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { settingsService } from '../settings/settingsService';
import { agentService } from './AgentService';

// 与 AgentService.invalidation.test.ts 的 makeFakeBound 同构
function makeFakeBound(threadId: string) {
  const dispose = vi.fn().mockResolvedValue(undefined);
  return {
    threadId, providerId: 'anthropic', modelId: 'm1',
    cwd: '/x', activeMessageId: null,
    session: { prompt: vi.fn(), abort: vi.fn(), subscribe: () => () => undefined, dispose },
    _dispose: dispose,
  };
}

describe('AgentService locale-switch helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-loc-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    (settingsService as any).cache = null;
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('hasActiveRun：只有 running 算，idle 不算', () => {
    expect(agentService.hasActiveRun()).toBe(false);
    (agentService as any).runs.set('t1', { status: 'idle' });
    expect(agentService.hasActiveRun()).toBe(false);
    (agentService as any).runs.set('t2', { status: 'running', runId: 'r1' });
    expect(agentService.hasActiveRun()).toBe(true);
  });

  it('disposeAllSessions 清空全部 session', async () => {
    const a = makeFakeBound('t1');
    const b = makeFakeBound('t2');
    (agentService as any).sessions.set('t1', a);
    (agentService as any).sessions.set('t2', b);
    await agentService.disposeAllSessions();
    expect(a._dispose).toHaveBeenCalled();
    expect(b._dispose).toHaveBeenCalled();
    expect((agentService as any).sessions.size).toBe(0);
  });
});
