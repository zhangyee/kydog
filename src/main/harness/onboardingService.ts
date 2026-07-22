import type { SettingsFile, OnboardingCompleteArgs, OnboardingResult } from '../../shared/types';
import { THEME_NAMES, READING_FONT_SIZES } from '../../shared/types';
import { validateDisplayName } from './names';
import { seedHarnessFiles, type SeedInput, type SeedOutcome } from './seed';
import { readManifest, writeManifest, deleteManifest, discardCorruptManifest, type SeedManifest, type ManifestReadResult } from './manifest';
import { settingsService } from '../settings/settingsService';
import { getProviderRegistry } from '../llm/providerRegistry';
import { logger } from '../log';

export type OnboardingDeps = {
  settings: { withLock<T>(fn: (cur: SettingsFile) => Promise<{ next?: SettingsFile; result: T }>): Promise<T> };
  seed: (input: SeedInput) => Promise<SeedOutcome>;
  readManifest: () => Promise<ManifestReadResult>;
  writeManifest: (m: SeedManifest) => Promise<void>;
  deleteManifest: () => Promise<void>;
  discardCorruptManifest: () => Promise<void>;
  isModelResolvable: (providerId: string, modelId: string) => boolean;
  now: () => string;
};

type LockStep = { next?: SettingsFile; result: OnboardingResult };
const fail = (code: Extract<OnboardingResult, { ok: false }>['code'], message: string): LockStep =>
  ({ result: { ok: false, code, message } });

export function createOnboardingService(deps: OnboardingDeps) {
  let inflight: Promise<OnboardingResult> | null = null;
  const single = (fn: () => Promise<OnboardingResult>): Promise<OnboardingResult> => {
    if (inflight) return inflight;                       // 并发共享同一结果（spec §8）
    inflight = fn().finally(() => { inflight = null; });
    return inflight;
  };

  /** 锁内公共尾段：模型校验 → 播种 → 组装 next。 */
  async function seedAndFinish(cur: SettingsFile, m: SeedManifest): Promise<LockStep> {
    if (!cur.llm.defaultProvider || !cur.llm.defaultModel
      || !deps.isModelResolvable(cur.llm.defaultProvider, cur.llm.defaultModel)) {
      return fail('model-missing', '尚未配置默认模型');
    }
    try {
      await deps.seed({ locale: m.locale, userName: m.userName, agentName: m.agentName });
    } catch (err) {
      logger.error('harness.onboarding', 'seed failed', { err: String(err) });
      return fail('seed-failed', String(err));
    }
    const next: SettingsFile = {
      ...cur,
      ui: { ...cur.ui, locale: m.locale, theme: m.theme, readingFontSize: m.readingFontSize },
      onboarding: { completedAt: deps.now() },
    };
    return { next, result: { ok: true } };
  }

  const cleanupOnOk = async (result: OnboardingResult): Promise<OnboardingResult> => {
    if (result.ok) await deps.deleteManifest();
    return result;
  };

  return {
    complete(args: OnboardingCompleteArgs): Promise<OnboardingResult> {
      return single(() => deps.settings.withLock<OnboardingResult>(async (cur) => {
        if (cur.onboarding.completedAt !== null) {
          await deps.deleteManifest();                   // stale manifest 清理（spec §8）
          return fail('already-completed', 'onboarding 已完成');
        }
        const existing = await deps.readManifest();
        if (existing.status === 'ok') return fail('recovery-pending', '存在未完成的播种记录，请走恢复流程');
        if (existing.status === 'corrupt') await deps.discardCorruptManifest(); // bootstrap 已提示过，弃置后按全新继续
        const userName = validateDisplayName(args.userName);
        const agentName = validateDisplayName(args.agentName);
        if (!userName || !agentName
          || (args.locale !== 'zh' && args.locale !== 'en')
          || !(THEME_NAMES as readonly string[]).includes(args.theme)
          || !(READING_FONT_SIZES as readonly string[]).includes(args.readingFontSize)) {
          return fail('invalid-input', '参数不合法');
        }
        const manifest: SeedManifest = { schemaVersion: 1, locale: args.locale, theme: args.theme, readingFontSize: args.readingFontSize, userName, agentName };
        await deps.writeManifest(manifest);
        return seedAndFinish(cur, manifest);
      }).then(cleanupOnOk));
    },

    resume(): Promise<OnboardingResult> {
      return single(() => deps.settings.withLock<OnboardingResult>(async (cur) => {
        if (cur.onboarding.completedAt !== null) {
          await deps.deleteManifest();
          return fail('already-completed', 'onboarding 已完成');
        }
        const m = await deps.readManifest();
        if (m.status === 'none') return fail('manifest-corrupt', '播种记录不存在');
        if (m.status === 'corrupt') { await deps.discardCorruptManifest(); return fail('manifest-corrupt', '播种记录损坏，已弃置'); }
        return seedAndFinish(cur, m.manifest);
      }).then(cleanupOnOk));
    },
  };
}

/** 真实依赖单例；isModelResolvable 用 provider registry（spec §8 服务端模型校验）。 */
export const onboardingService = createOnboardingService({
  settings: settingsService,
  seed: (input) => seedHarnessFiles(input),
  readManifest: () => readManifest(),
  writeManifest: (m) => writeManifest(m),
  deleteManifest: () => deleteManifest(),
  discardCorruptManifest: () => discardCorruptManifest(),
  isModelResolvable: (providerId, modelId) =>
    Boolean(getProviderRegistry().modelRegistry.find(providerId, modelId)),
  now: () => new Date().toISOString(),
});
