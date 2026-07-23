import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('withLockSync: 磁盘遗留 v3 settings（无 onboarding 键）时按 schema 迁移，不把裸 JSON 污染进 cache（真机 P0 复现）', async () => {
    // 磁盘上是迁移前落地的 v3 文件：没有 onboarding 键。
    const v3OnDisk = {
      schemaVersion: 3,
      ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'medium' },
      llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null },
      skills: { disabledBuiltins: [] },
      tools: { externalBins: [] },
    };
    writeFileSync(path.join(dir, 'kydog.json'), JSON.stringify(v3OnDisk, null, 2), 'utf8');

    // 真机链路：kydogAuthBackend 在启动阶段调 withLockSync 读 auth，回调拿到的 current
    // 必须是迁移后的 v4 形状（onboarding 键存在），而不是裸 JSON.parse 的 v3 形状。
    const captured = svc.withLockSync((cur) => ({ result: cur.onboarding?.completedAt }));
    expect(captured).toBe(null); // undefined 说明 cur.onboarding 缺失（bug 复现）；null 说明已迁移

    // withLockSync 内部把 current 写进 this.cache；未迁移的裸对象污染 cache 后，
    // 后续任何 svc.get() 都会返回缺 onboarding 键的对象。
    const after = await svc.get();
    expect(after.onboarding).toBeDefined();
    expect(after.schemaVersion).toBe(4);
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
