// src/main/llm/providerRegistry.ts
import type { SettingsFile, ProviderId, CustomProvider, ProviderOverride } from '../../shared/types';
import { SettingsService } from '../settings/settingsService';
import { KydogAuthStorageBackend } from './kydogAuthBackend';

// pi-coding-agent 通过 dynamic import（与 sessionFactory 一致；CJS resolution 已踩过坑）
type AnyAuthStorage = {
  reload(): void;
  getAuthStatus(provider: string): unknown;
  [k: string]: unknown;
};
type AnyModelRegistry = {
  find(provider: string, modelId: string): unknown | undefined;
  registerProvider(name: string, cfg: unknown): void;
  [k: string]: unknown;
};

interface AgentInvalidatable {
  invalidateSessionsForProviders(providerIds: ProviderId[]): Promise<void>;
}

export class ProviderRegistry {
  readonly authStorage: AnyAuthStorage;
  modelRegistry: AnyModelRegistry;
  private constructor(authStorage: AnyAuthStorage, modelRegistry: AnyModelRegistry) {
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
  }

  static async build(svc: SettingsService): Promise<ProviderRegistry> {
    const pi = await import('@mariozechner/pi-coding-agent');
    const settings = await svc.get();
    const authStorage = (pi as any).AuthStorage.fromStorage(new KydogAuthStorageBackend(svc));
    const modelRegistry = await ProviderRegistry.buildModelRegistry(pi, settings, authStorage);
    return new ProviderRegistry(authStorage, modelRegistry);
  }

  reloadAuth(): void {
    this.authStorage.reload();
  }

  async refreshAfterProviderChange(
    svc: SettingsService,
    agent: AgentInvalidatable,
    changedIds: ProviderId[],
  ): Promise<void> {
    const pi = await import('@mariozechner/pi-coding-agent');
    const settings = await svc.get();
    this.modelRegistry = await ProviderRegistry.buildModelRegistry(pi, settings, this.authStorage);
    await agent.invalidateSessionsForProviders(changedIds);
  }

  // ────────────────────────────────────────────────────
  private static async buildModelRegistry(
    pi: typeof import('@mariozechner/pi-coding-agent'),
    settings: SettingsFile,
    authStorage: AnyAuthStorage,
  ): Promise<AnyModelRegistry> {
    const reg = (pi as any).ModelRegistry.inMemory(authStorage) as AnyModelRegistry;
    for (const cp of settings.llm.customProviders) {
      reg.registerProvider(cp.id, customProviderToPiConfig(cp));
    }
    applyBuiltinOverrides(reg, settings.llm.providers);
    return reg;
  }
}

function customProviderToPiConfig(cp: CustomProvider): unknown {
  return {
    baseUrl: cp.baseUrl,
    api: cp.api,
    apiKey: cp.apiKey,           // pi 自己解析 literal / env var / "!command"
    headers: cp.headers,
    authHeader: cp.authHeader,
    models: cp.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      api: m.api ?? cp.api,
      reasoning: m.reasoning ?? false,
      input: m.input ?? ['text'],
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 16_384,
      cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: m.compat,
    })),
  };
}

function applyBuiltinOverrides(
  reg: AnyModelRegistry,
  providers: Record<ProviderId, ProviderOverride>,
): void {
  for (const [id, ov] of Object.entries(providers)) {
    if (!ov.baseUrl && !ov.headers) continue;
    reg.registerProvider(id, {
      ...(ov.baseUrl ? { baseUrl: ov.baseUrl } : {}),
      ...(ov.headers ? { headers: ov.headers } : {}),
    });
  }
}

let _instance: ProviderRegistry | null = null;
export function getProviderRegistry(): ProviderRegistry {
  if (!_instance) throw new Error('ProviderRegistry not initialized; call initProviderRegistry first');
  return _instance;
}
export async function initProviderRegistry(svc: SettingsService): Promise<ProviderRegistry> {
  _instance = await ProviderRegistry.build(svc);
  return _instance;
}
/** 仅给测试用 */
export function _resetProviderRegistryForTest(): void { _instance = null; }
