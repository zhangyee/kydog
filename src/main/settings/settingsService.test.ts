import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { SettingsService } from './settingsService';

describe('SettingsService (v2 + proper-lockfile)', () => {
  let dir: string;
  let svc: SettingsService;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-svc-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    svc = new SettingsService();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('withLock: 写 + 读回一致', async () => {
    await svc.withLock(async (cur) => {
      const next = { ...cur, llm: { ...cur.llm, defaultProvider: 'anthropic' } };
      return { next, result: undefined };
    });
    const got = await svc.get();
    expect(got.llm.defaultProvider).toBe('anthropic');
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'kydog.json'), 'utf8'));
    expect(onDisk.llm.defaultProvider).toBe('anthropic');
  });

  it('withLock: 100 次并发 async 写最终 deterministic（无丢失）', async () => {
    const N = 100;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        svc.withLock(async (cur) => ({
          next: { ...cur, llm: { ...cur.llm, providers: { ...cur.llm.providers, [`p${i}`]: {} } } },
          result: undefined,
        })),
      ),
    );
    const got = await svc.get();
    expect(Object.keys(got.llm.providers).length).toBe(N);
  });

  it('withLockSync: 写 + 读回一致', () => {
    svc.withLockSync((cur) => {
      const next = { ...cur, llm: { ...cur.llm, defaultModel: 'claude-sonnet-4-5' } };
      return { next, result: undefined };
    });
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'kydog.json'), 'utf8'));
    expect(onDisk.llm.defaultModel).toBe('claude-sonnet-4-5');
  });

  it('混合 sync/async 写：交替 50 次，最终所有键都存在', async () => {
    const ops: Array<Promise<void> | void> = [];
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        ops.push(svc.withLock(async (cur) => ({
          next: { ...cur, llm: { ...cur.llm, providers: { ...cur.llm.providers, [`a${i}`]: {} } } },
          result: undefined,
        })));
      } else {
        svc.withLockSync((cur) => ({
          next: { ...cur, llm: { ...cur.llm, providers: { ...cur.llm.providers, [`s${i}`]: {} } } },
          result: undefined,
        }));
      }
    }
    await Promise.all(ops.filter((x): x is Promise<void> => !!x));
    const got = await svc.get();
    expect(Object.keys(got.llm.providers).length).toBe(50);
  });

  it('update(): patch 混入 onboarding.completedAt + schemaVersion 被过滤（守住不变式）', async () => {
    const before = await svc.get();
    const patch = {
      ui: { theme: 'sepia' as const },
      onboarding: { completedAt: 'HACK' } as any,
      schemaVersion: 99 as any,
    };
    const result = await svc.update(patch);
    expect(result.schemaVersion).toBe(4);
    expect(result.ui.theme).toBe('sepia');
    expect(result.onboarding.completedAt).toBe(before.onboarding.completedAt);
  });
});
