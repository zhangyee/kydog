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

  // 判据是 session 上的 bound.runId（send() 铸出、agent_settled 清），不是现算 runs：
  // runs 在 agent_end 就回 idle，而 pi 在那之后仍可能自动重试。
  // 「重试窗口里也算有 run 在飞」那一条在 AgentService.browserDispose.test.ts。
  it('hasActiveRun：有 bound.runId 才算，null 不算', () => {
    expect(agentService.hasActiveRun()).toBe(false);
    (agentService as any).sessions.set('t1', { ...makeFakeBound('t1'), runId: null });
    expect(agentService.hasActiveRun()).toBe(false);
    (agentService as any).sessions.set('t2', { ...makeFakeBound('t2'), runId: 'r1' });
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
