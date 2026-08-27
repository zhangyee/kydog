import { describe, it, expect } from 'vitest';
import { createOnboardingService, type OnboardingDeps } from './onboardingService';
import type { SettingsFile, OnboardingCompleteArgs } from '../../shared/types';
import type { SeedManifest, ManifestReadResult } from './manifest';

const ARGS: OnboardingCompleteArgs = { locale: 'zh', theme: 'vellum', readingFontSize: 'medium', userName: '老张', agentName: 'KyDog', telemetryEnabled: false };

function makeWorld(over: Partial<{ completedAt: string | null; model: boolean; manifest: ManifestReadResult; seedFail: boolean; writeManifestFail: boolean; telemetry: SettingsFile['telemetry']; syncFail: boolean }> = {}) {
  const state = {
    settings: {
      schemaVersion: 7,
      ui: { theme: 'porcelain', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'small' },
      llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: over.model === false ? null : 'anthropic', defaultModel: over.model === false ? null : 'm1' },
      skills: { disabledBuiltins: [] }, tools: { externalBins: [] },
      research: { presets: {}, custom: [] },
      updates: { autoCheck: true, dismissedCandidateId: null },
      // 可覆写：验证「落盘值来自 manifest」时，初始值必须与期望值不同，否则断言证明不了任何东西。
      telemetry: over.telemetry ?? { state: 'undecided', decidedAt: null },
      onboarding: { completedAt: over.completedAt ?? null },
    } as SettingsFile,
    manifest: over.manifest ?? { status: 'none' as const },
    written: null as SeedManifest | null,
    lastWritten: null as SeedManifest | null,   // 与 written 不同：成功后 manifest 会被删，这里留痕以便断言写进去的内容
    deleted: 0, discarded: 0, seedCalls: [] as Array<{ locale: string; userName: string; agentName: string }>,
    order: [] as string[], syncCalls: [] as string[],   // 验证 seed → sync 的先后顺序，以及 sync 收到的 locale
  };
  const deps: OnboardingDeps = {
    settings: {
      async withLock(fn) {
        const { next, result } = await fn(state.settings);
        if (next) state.settings = next;
        return result;
      },
    },
    seed: async (input) => {
      if (over.seedFail) throw new Error('EACCES');
      state.seedCalls.push(input);
      state.order.push('seed');
      return { created: ['SOUL.md', 'USER.md', 'AGENTS.md'], skipped: [] };
    },
    readManifest: async () => (state.written ? { status: 'ok', manifest: state.written } : state.manifest),
    writeManifest: async (m) => {
      if (over.writeManifestFail) throw new Error('ENOSPC');
      state.written = m;
      state.lastWritten = m;
    },
    deleteManifest: async () => { state.deleted += 1; state.written = null; },
    discardCorruptManifest: async () => { state.discarded += 1; state.manifest = { status: 'none' }; },
    isModelResolvable: () => over.model !== false,
    syncSkills: async (locale) => {
      if (over.syncFail) throw new Error('EACCES');
      state.order.push('sync');
      state.syncCalls.push(locale);
    },
    now: () => '2026-07-22T00:00:00.000Z',
  };
  return { state, svc: createOnboardingService(deps) };
}

describe('onboarding.complete', () => {
  it('happy path：写 manifest → 播种 → 写 ui+completedAt → 删 manifest', async () => {
    const { state, svc } = makeWorld();
    expect(await svc.complete(ARGS)).toEqual({ ok: true });
    expect(state.settings.onboarding.completedAt).toBe('2026-07-22T00:00:00.000Z');
    expect(state.settings.ui.theme).toBe('vellum');
    expect(state.settings.ui.readingFontSize).toBe('medium');
    expect(state.seedCalls).toEqual([{ locale: 'zh', userName: '老张', agentName: 'KyDog' }]);
    expect(state.lastWritten).toMatchObject({ telemetryState: 'disabled', decidedAt: '2026-07-22T00:00:00.000Z' });
    expect(state.settings.telemetry).toEqual({ state: 'disabled', decidedAt: '2026-07-22T00:00:00.000Z' });
    expect(state.deleted).toBeGreaterThan(0);
  });

  it('勾了统计 → manifest 与 settings 都落 enabled', async () => {
    const { state, svc } = makeWorld({ telemetry: { state: 'disabled', decidedAt: '2020-01-01T00:00:00.000Z' } });
    expect(await svc.complete({ ...ARGS, telemetryEnabled: true })).toEqual({ ok: true });
    expect(state.lastWritten).toMatchObject({ telemetryState: 'enabled' });
    expect(state.settings.telemetry).toEqual({ state: 'enabled', decidedAt: '2026-07-22T00:00:00.000Z' });
  });

  it('invalid-input：坏称呼/坏主题不播种不写标记', async () => {
    const { state, svc } = makeWorld();
    const r = await svc.complete({ ...ARGS, userName: 'a\nb' });
    expect(r).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(state.seedCalls).toHaveLength(0);
    expect(state.settings.onboarding.completedAt).toBeNull();
  });

  it('model-missing：默认模型未配置', async () => {
    const { state, svc } = makeWorld({ model: false });
    expect(await svc.complete(ARGS)).toMatchObject({ ok: false, code: 'model-missing' });
    expect(state.written).toBeNull();
  });

  it('seed-failed：不写 completedAt，manifest 保留', async () => {
    const { state, svc } = makeWorld({ seedFail: true });
    expect(await svc.complete(ARGS)).toMatchObject({ ok: false, code: 'seed-failed' });
    expect(state.settings.onboarding.completedAt).toBeNull();
    expect(state.written).not.toBeNull();
  });

  it('writeManifest 抛错：seed-failed，不写 completedAt，不播种', async () => {
    const { state, svc } = makeWorld({ writeManifestFail: true });
    expect(await svc.complete(ARGS)).toMatchObject({ ok: false, code: 'seed-failed' });
    expect(state.settings.onboarding.completedAt).toBeNull();
    expect(state.written).toBeNull();
    expect(state.seedCalls).toHaveLength(0);
  });

  it('recovery-pending：已有 manifest 时不覆盖、不接受新参数', async () => {
    const pending: SeedManifest = { schemaVersion: 2, locale: 'en', theme: 'midnight', readingFontSize: 'large', userName: 'Old', agentName: 'OldDog', telemetryState: 'disabled', decidedAt: '2026-07-22T00:00:00.000Z' };
    const { state, svc } = makeWorld({ manifest: { status: 'ok', manifest: pending } });
    expect(await svc.complete({ ...ARGS, userName: 'New' })).toMatchObject({ ok: false, code: 'recovery-pending' });
    expect(state.written).toBeNull(); // 未写新 manifest
    expect(state.seedCalls).toHaveLength(0);
  });

  it('already-completed：完成后重放，并清理 stale manifest', async () => {
    const { state, svc } = makeWorld({ completedAt: '2026-01-01T00:00:00.000Z' });
    expect(await svc.complete(ARGS)).toMatchObject({ ok: false, code: 'already-completed' });
    expect(state.deleted).toBeGreaterThan(0);
  });

  it('并发调用共享同一结果、只播种一次', async () => {
    const { state, svc } = makeWorld();
    const [a, b] = await Promise.all([svc.complete(ARGS), svc.complete(ARGS)]);
    expect(a).toEqual(b);
    expect(state.seedCalls).toHaveLength(1);
  });

  it('complete 成功后按选定 locale 播种 skills，顺序在 seed 之后', async () => {
    const { state, svc } = makeWorld();
    expect(await svc.complete({ ...ARGS, locale: 'en' })).toEqual({ ok: true });
    expect(state.order).toEqual(['seed', 'sync']);
    expect(state.syncCalls).toEqual(['en']);
  });

  it('skill 播种失败不挡住 onboarding（seed 失败才挡）', async () => {
    const { state, svc } = makeWorld({ syncFail: true });
    expect(await svc.complete(ARGS)).toEqual({ ok: true });
    expect(state.settings.onboarding.completedAt).toBe('2026-07-22T00:00:00.000Z');
  });
});

describe('onboarding.resume', () => {
  // telemetry 取值刻意与 makeWorld 初始值（undecided/null）不同，否则断言证明不了值是从 manifest 来的。
  const pending: SeedManifest = { schemaVersion: 2, locale: 'en', theme: 'midnight', readingFontSize: 'large', userName: 'Dr. Zhang', agentName: 'KyDog', telemetryState: 'enabled', decidedAt: '2026-08-01T00:00:00.000Z' };

  it('沿用 manifest 原输入（含 theme/字号/统计选择）补齐并提交', async () => {
    const { state, svc } = makeWorld({ manifest: { status: 'ok', manifest: pending } });
    expect(await svc.resume()).toEqual({ ok: true });
    expect(state.seedCalls).toEqual([{ locale: 'en', userName: 'Dr. Zhang', agentName: 'KyDog' }]);
    expect(state.settings.ui.theme).toBe('midnight');       // ui 来自 manifest 而非现值
    expect(state.settings.ui.readingFontSize).toBe('large');
    expect(state.settings.ui.locale).toBe('en');
    expect(state.settings.telemetry).toEqual({ state: 'enabled', decidedAt: '2026-08-01T00:00:00.000Z' });
  });

  // v1 manifest 经迁移后 telemetryState 是 undecided；恢复必须原样落成 undecided，
  // 而不是沿用现值或替用户选一边 —— 他当年根本没见过勾选框。
  it('恢复迁移自 v1 的 manifest → settings 落 undecided，不沿用现值', async () => {
    const migrated: SeedManifest = { ...pending, telemetryState: 'undecided', decidedAt: null };
    const { state, svc } = makeWorld({
      manifest: { status: 'ok', manifest: migrated },
      telemetry: { state: 'enabled', decidedAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(await svc.resume()).toEqual({ ok: true });
    expect(state.settings.telemetry).toEqual({ state: 'undecided', decidedAt: null });
  });

  it('manifest 损坏 → 弃置 + manifest-corrupt', async () => {
    const { state, svc } = makeWorld({ manifest: { status: 'corrupt' } });
    expect(await svc.resume()).toMatchObject({ ok: false, code: 'manifest-corrupt' });
    expect(state.discarded).toBe(1);
  });

  it('manifest 不存在 → manifest-corrupt（stray resume 归位全新向导）', async () => {
    const { svc } = makeWorld();
    expect(await svc.resume()).toMatchObject({ ok: false, code: 'manifest-corrupt' });
  });

  it('已完成 → already-completed', async () => {
    const { svc } = makeWorld({ completedAt: 'x', manifest: { status: 'ok', manifest: pending } });
    expect(await svc.resume()).toMatchObject({ ok: false, code: 'already-completed' });
  });
});
