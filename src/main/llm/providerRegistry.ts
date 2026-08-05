// src/main/llm/providerRegistry.ts
import path from 'node:path';
import type { SettingsFile, ProviderId, CustomProvider, ProviderOverride } from '../../shared/types';
import { SettingsService } from '../settings/settingsService';
import { KydogCredentialStore } from './kydogAuthBackend';
import { kydogAgentDir } from '../skills/skillResourceLoader';

// pi-coding-agent 通过 dynamic import（与 sessionFactory 一致；CJS resolution 已踩过坑）
// 0.80.8 起 AuthStorage + ModelRegistry 合并成 ModelRuntime，凭据与模型目录同一个对象。
type AnyModelRuntime = {
  getModel(providerId: string, modelId: string): unknown | undefined;
  getModels(providerId?: string): readonly unknown[];
  getProviderAuthStatus(providerId: string): unknown;
  registerProvider(providerId: string, cfg: unknown): void;
  login(providerId: string, type: string, interaction: unknown): Promise<unknown>;
  logout(providerId: string): Promise<void>;
  [k: string]: unknown;
};

export function buildModelRuntimeOptions(svc: SettingsService): {
  credentials: KydogCredentialStore;
  modelsPath: string;
  allowModelNetwork: boolean;
} {
  return {
    credentials: new KydogCredentialStore(svc),
    // 不传会默认到 ~/.pi/agent/models.json，并往那儿写 models-store.json —— 等于把
    // f96afc7 拆掉的 .pi 耦合重建出来（model-runtime.js:59,63）。
    modelsPath: path.join(kydogAgentDir(), 'models.json'),
    // 不打开就只有打包时烤进去的静态目录，新模型永远进不来（model-runtime.js:74）。
    allowModelNetwork: true,
  };
}

interface AgentInvalidatable {
  invalidateSessionsForProviders(providerIds: ProviderId[]): Promise<void>;
}

export class ProviderRegistry {
  modelRuntime: AnyModelRuntime;
  private constructor(modelRuntime: AnyModelRuntime) {
    this.modelRuntime = modelRuntime;
  }

  static async build(svc: SettingsService): Promise<ProviderRegistry> {
    const pi = await import('@earendil-works/pi-coding-agent');
    const settings = await svc.get();
    return new ProviderRegistry(await ProviderRegistry.buildModelRuntime(pi, settings, svc));
  }

  async refreshAfterProviderChange(
    svc: SettingsService,
    agent: AgentInvalidatable,
    changedIds: ProviderId[],
  ): Promise<void> {
    const pi = await import('@earendil-works/pi-coding-agent');
    const settings = await svc.get();
    this.modelRuntime = await ProviderRegistry.buildModelRuntime(pi, settings, svc);
    await agent.invalidateSessionsForProviders(changedIds);
  }

  // ────────────────────────────────────────────────────
  private static async buildModelRuntime(
    pi: typeof import('@earendil-works/pi-coding-agent'),
    settings: SettingsFile,
    svc: SettingsService,
  ): Promise<AnyModelRuntime> {
    const rt = await (pi as any).ModelRuntime.create(buildModelRuntimeOptions(svc)) as AnyModelRuntime;
    for (const cp of settings.llm.customProviders) {
      rt.registerProvider(cp.id, customProviderToPiConfig(cp));
    }
    applyBuiltinOverrides(rt, settings.llm.providers);
    return rt;
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
  reg: AnyModelRuntime,
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
