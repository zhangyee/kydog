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
    // 远程目录改由 startCatalogRefresh() 起一次不 await 的后台 refresh 拉。
    allowModelNetwork: false,
  };
}

// 后台目录刷新落地后的通知钩子。这个模块本身不认识 electron（单测直接 import 它，
// import broadcaster 会把 electron 拖进来），所以广播动作由 main.ts 注入。
let catalogRefreshedHook: (() => void) | undefined;
export function setCatalogRefreshedHook(fn: (() => void) | undefined): void {
  catalogRefreshedHook = fn;
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
    this.startCatalogRefresh();
    await agent.invalidateSessionsForProviders(changedIds);
  }

  /**
   * 起一次后台目录刷新。**必须由「registry 已经可达」的地方调用**，不能塞回
   * buildModelRuntime 里：`refresh()` 立刻 resolve 时，它的 `.then` 会排在 build() 那个
   * await 的恢复之前——那一刻 `_instance` 还是 null，钩子里的 `getProviderRegistry()`
   * 会抛，广播就静默丢了。谁先谁后不能靠「refresh 总要读文件、总比 build 慢」这种时序假设。
   *
   * 故意不 await：模型清单先是静态那份、几秒后才长出新模型可以接受，启动卡住不行。
   * 也故意不传 allowNetwork —— refresh() 里是 `options.allowNetwork ?? modelNetworkEnabled`
   * (model-runtime.js:369)，显式传 true 会盖掉 PI_OFFLINE，单测就会真去联网。
   */
  startCatalogRefresh(): void {
    // 拉完才通知：此刻 getModels() 才包含远端目录里的新模型，渲染层重新读一次就对了。
    // 失败不通知——目录没变，广播出去只是让渲染层白读一次同样的清单。
    void this.modelRuntime.refresh()
      .then(() => catalogRefreshedHook?.())
      .catch((err: unknown) =>
        logger.warn('llm', 'model catalog refresh failed', { err: String(err) }));
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
    // 目录刷新不在这里起 —— 见 startCatalogRefresh()。调用方保证它排在自定义 provider /
    // override 全部注册之后，那次刷新才看得到完整的 provider 集合。
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
  // 先落位再起刷新，顺序不能反：刷新完成的钩子会回头走 getProviderRegistry()。
  _instance.startCatalogRefresh();
  return _instance;
}
/** 仅给测试用 */
export function _resetProviderRegistryForTest(): void { _instance = null; catalogRefreshedHook = undefined; }
