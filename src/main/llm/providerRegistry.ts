// src/main/llm/providerRegistry.ts
import path from 'node:path';
import type { SettingsFile, ProviderId, CustomProvider, ProviderOverride } from '../../shared/types';
import { SettingsService } from '../settings/settingsService';
import { KydogCredentialStore } from './kydogAuthBackend';
import { kydogAgentDir } from '../skills/skillResourceLoader';
import { logger } from '../log';

type PiModelRuntime = import('@earendil-works/pi-coding-agent').ModelRuntime;

// pi-coding-agent 通过 dynamic import（与 sessionFactory 一致；CJS resolution 已踩过坑）
// 0.80.8 起 AuthStorage + ModelRegistry 合并成 ModelRuntime，凭据与模型目录同一个对象。
// 索引签名让未声明的成员取出来只是 unknown（不可调用），所以真正要调的方法逐个钉上
// pi 的原签名 —— 调用点就不用再 cast 整个 runtime。
type AnyModelRuntime = {
  getModel(providerId: string, modelId: string): unknown | undefined;
  getModels(providerId?: string): readonly unknown[];
  getProviderAuthStatus(providerId: string): unknown;
  registerProvider(providerId: string, cfg: unknown): void;
  login(providerId: string, type: string, interaction: unknown): Promise<unknown>;
  logout(providerId: string): Promise<void>;
  completeSimple: PiModelRuntime['completeSimple'];
  refresh: PiModelRuntime['refresh'];
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
    // 打开的话 create() 会 await 一次带 15s abort 预算的目录拉取（model-runtime.js:74-80），
    // 而 initProviderRegistry 排在 installDispatcher / createWindow 之前 —— 网络被黑洞
    // （强制门户、公司代理）时就是十几秒白屏。这里关掉，create() 直接拿静态目录返回；
    // 远程目录改由 buildModelRuntime 在返回后起一次不 await 的后台 refresh 拉。
    allowModelNetwork: false,
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
    // 自定义 provider / override 都注册完再起，这次刷新才看得到完整的 provider 集合。
    // 故意不 await：模型列表先是静态那份、几秒后才长出新模型可以接受，启动卡住不行。
    // 也故意不传 allowNetwork —— refresh() 里是 `options.allowNetwork ?? modelNetworkEnabled`
    // (model-runtime.js:369)，显式传 true 会盖掉 PI_OFFLINE，单测就会真去联网。
    void rt.refresh().catch((err: unknown) =>
      logger.warn('llm', 'model catalog refresh failed', { err: String(err) }));
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
