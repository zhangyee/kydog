import type { SettingsFile, ProviderId } from '../../shared/types';

/**
 * 解析顺序：providers[id].defaultModel（内置）→ customProviders[i].defaultModel（自定义）→ undefined
 * 调用方负责再 fallback 到全局 settings.llm.defaultModel。
 */
export function resolveProviderDefault(
  settings: SettingsFile,
  providerId: ProviderId,
): string | undefined {
  const builtin = settings.llm.providers[providerId]?.defaultModel;
  if (builtin) return builtin;
  const custom = settings.llm.customProviders.find((cp) => cp.id === providerId)?.defaultModel;
  if (custom) return custom;
  return undefined;
}
