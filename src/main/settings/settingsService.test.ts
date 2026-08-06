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

  it('withLock: 磁盘遗留 v3 settings（无 onboarding 键）时按 schema 迁移，不把裸 JSON 污染进 cache（真机 P0 复现）', async () => {
    // 磁盘上是迁移前落地的 v3 文件：没有 onboarding 键。
    const v3OnDisk = {
      schemaVersion: 3,
      ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'medium' },
      llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null },
      skills: { disabledBuiltins: [] },
      tools: { externalBins: [] },
    };
    writeFileSync(path.join(dir, 'kydog.json'), JSON.stringify(v3OnDisk, null, 2), 'utf8');

    // 真机链路：启动阶段拿锁读 settings，回调拿到的 current 必须是迁移后的形状
    // （onboarding 键存在），而不是裸 JSON.parse 的 v3 形状。
    const captured = await svc.withLock(async (cur) => ({ result: cur.onboarding?.completedAt }));
    expect(captured).toBe(null); // undefined 说明 cur.onboarding 缺失（bug 复现）；null 说明已迁移

    // withLock 内部把 current 写进 this.cache；未迁移的裸对象污染 cache 后，
    // 后续任何 svc.get() 都会返回缺 onboarding 键的对象。
    const after = await svc.get();
    expect(after.onboarding).toBeDefined();
    expect(after.schemaVersion).toBe(7);
  });

  it('update(): patch 混入 onboarding.completedAt + schemaVersion 被过滤（守住不变式）', async () => {
    const before = await svc.get();
    const patch = {
      ui: { theme: 'sepia' as const },
      onboarding: { completedAt: 'HACK' } as any,
      schemaVersion: 99 as any,
    };
    const result = await svc.update(patch);
    expect(result.schemaVersion).toBe(7);
    expect(result.ui.theme).toBe('sepia');
    expect(result.onboarding.completedAt).toBe(before.onboarding.completedAt);
  });

  it('update(): patch 混入 updates 被过滤（守住不变式，spec §7）', async () => {
    await svc.withLock(async (cur) => ({
      next: { ...cur, updates: { autoCheck: false, dismissedCandidateId: 'keep-me' } },
      result: undefined,
    }));
    const patch = {
      ui: { theme: 'porcelain' as const },
      updates: { autoCheck: true, dismissedCandidateId: 'HACK' } as any,
    };
    const result = await svc.update(patch);
    expect(result.ui.theme).toBe('porcelain');
    expect(result.updates).toEqual({ autoCheck: false, dismissedCandidateId: 'keep-me' });
    const got = await svc.get();
    expect(got.updates).toEqual({ autoCheck: false, dismissedCandidateId: 'keep-me' });
  });

  it('update() 不碰 telemetry —— 它只能由 telemetryService 改', async () => {
    // 用 deleting：它是最该被保住的状态，丢了等于静默吞掉用户已发出的删除请求。
    await svc.withLock(async (cur) => ({
      next: { ...cur, telemetry: { state: 'deleting' as const, decidedAt: '2026-08-05T10:00:00.000Z' } },
      result: undefined,
    }));
    const patch = { ui: { theme: 'midnight' as const } };
    const result = await svc.update(patch);
    expect(result.ui.theme).toBe('midnight');
    expect(result.telemetry).toEqual({ state: 'deleting', decidedAt: '2026-08-05T10:00:00.000Z' });
    const got = await svc.get();
    expect(got.telemetry).toEqual({ state: 'deleting', decidedAt: '2026-08-05T10:00:00.000Z' });
  });

  it('setTelemetry(): 落盘且只动 telemetry 一节', async () => {
    await svc.update({ ui: { theme: 'midnight' as const } });
    await svc.setTelemetry({ state: 'enabled', decidedAt: '2026-08-06T09:00:00.000Z' });

    const onDisk = JSON.parse(readFileSync(path.join(dir, 'kydog.json'), 'utf8'));
    expect(onDisk.telemetry).toEqual({ state: 'enabled', decidedAt: '2026-08-06T09:00:00.000Z' });
    expect(onDisk.ui.theme).toBe('midnight');
    const got = await svc.get();
    expect(got.telemetry).toEqual({ state: 'enabled', decidedAt: '2026-08-06T09:00:00.000Z' });
  });
});
