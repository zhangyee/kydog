// src/main/llm/cascade.ts
import type { SettingsFile, ProviderId } from '../../shared/types';

/**
 * 移除 provider（builtin 或 custom）后，整理全局 default 与 auth/providers/customProviders 残留。
 * Thread.modelOverride 不在此处处理（保留字段，sessionFactory 解析时降级）。
 */
export function sweepDefaultsAfterRemove(s: SettingsFile, providerId: ProviderId): SettingsFile {
  const auth = { ...s.llm.auth };
  delete auth[providerId];
  const providers = { ...s.llm.providers };
  delete providers[providerId];
  const customProviders = s.llm.customProviders.filter((cp) => cp.id !== providerId);
  let { defaultProvider, defaultModel } = s.llm;
  if (defaultProvider === providerId) {
    defaultProvider = null;
    defaultModel = null;
  }
  return { ...s, llm: { ...s.llm, auth, providers, customProviders, defaultProvider, defaultModel } };
}

/**
 * provider 模型清单变化后，清掉 defaultModel / Provider.defaultModel 中已不存在的引用。
 * Thread.modelOverride 同样保留（sessionFactory 降级）。
 */
export function sweepDefaultsAfterModelListChange(
  s: SettingsFile,
  providerId: ProviderId,
  newModelIds: string[],
): SettingsFile {
  const valid = new Set(newModelIds);
  const providers = { ...s.llm.providers };
  if (providers[providerId]?.defaultModel && !valid.has(providers[providerId]!.defaultModel!)) {
    providers[providerId] = { ...providers[providerId], defaultModel: undefined };
  }
  const customProviders = s.llm.customProviders.map((cp) =>
    cp.id === providerId && cp.defaultModel && !valid.has(cp.defaultModel)
      ? { ...cp, defaultModel: undefined }
      : cp,
  );
  let { defaultProvider, defaultModel } = s.llm;
  if (defaultProvider === providerId && defaultModel && !valid.has(defaultModel)) {
    defaultModel = null;
  }
  return { ...s, llm: { ...s.llm, providers, customProviders, defaultProvider, defaultModel } };
}
