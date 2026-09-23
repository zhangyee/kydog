// src/main/llm/llmService.ts
import { settingsService } from '../settings/settingsService';
import { agentService } from '../agent/AgentService';
import { threadService } from '../thread/threadService';
import { applyCloudEnv } from './cloudEnvSync';
import { getProviderRegistry, ProviderRegistry } from './providerRegistry';
import { PROVIDER_CATALOG, getCatalogEntry } from './catalog';
import { sweepDefaultsAfterRemove } from './cascade';
import { getVertexAuthStatus } from './vertexStatus';
import type {
  LlmListResult, LlmConfigureCfg, LlmConfiguredEntry, LlmTestConnectionResult,
} from '../../shared/protocol';
import type { ProviderId, SettingsFile } from '../../shared/types';

class LlmService {
  async list(): Promise<LlmListResult> {
    const settings = await settingsService.get();
    const reg = getProviderRegistry();
    const catalog = PROVIDER_CATALOG.map((e) => ({
      id: e.id, displayName: e.displayName, kind: e.kind, group: e.group,
      supportsOAuth: e.oauth ? true : undefined,
    }));
    const configured: LlmConfiguredEntry[] = [];

    for (const e of PROVIDER_CATALOG) {
      const isConfigured = !!settings.llm.auth[e.id] || !!settings.llm.providers[e.id];
      if (!isConfigured) continue;
      configured.push(await this.entryFor(e.id, settings, reg));
    }
    for (const cp of settings.llm.customProviders) {
      configured.push({
        providerId: cp.id,
        displayName: cp.displayName,
        kind: 'custom',
        authStatus: { configured: true, source: 'stored', label: cp.apiKey === 'ollama' || cp.apiKey === 'lmstudio' ? '本地' : 'key' },
        // 缺省值（name → id、input → ['text']）与 providerRegistry.customProviderToPiConfig 同一个口径。
        models: cp.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          image: (m.input ?? ['text']).includes('image'),
        })),
        defaultModel: cp.defaultModel ?? cp.models[0]?.id ?? null,
      });
    }
    return {
      catalog,
      configured,
      customProviders: settings.llm.customProviders,
      defaultProvider: settings.llm.defaultProvider,
      defaultModel: settings.llm.defaultModel,
    };
  }

  private async entryFor(id: ProviderId, settings: SettingsFile, reg: ProviderRegistry): Promise<LlmConfiguredEntry> {
    const cat = getCatalogEntry(id);
    const provOverride = settings.llm.providers[id];
    const all = (reg.modelRuntime as any).getModels?.() ?? [];
    const own = (all as Array<{ provider: string; id: string; name?: string; input?: readonly string[] }>)
      .filter((m) => m.provider === id);
    // 退役的 id 不进清单。pi 把远端目录按 id upsert 合并进内置静态目录，静态目录里的旧 id
    // 永远不会被删 —— 于是下架的模型一直留在选单里，会话可以一直钉着它，直到某天服务端
    // 拒绝这个 id 才在发送时炸。远端拉到过就以远端那份为准；**没拉到过（undefined）一个都
    // 不过滤**，没有清单不等于清单是空的。
    const live = await reg.liveModelIds(id);
    const models = own
      .filter((m) => !live || live.has(m.id))
      .map((m) => ({ id: m.id, name: m.name ?? m.id, image: m.input?.includes('image') === true }));
    const defaultModel = provOverride?.defaultModel ?? cat?.defaultModel ?? models[0]?.id ?? null;
    let authStatus: LlmConfiguredEntry['authStatus'];
    if (cat?.kind === 'cloud' && cat.cloud?.cfgKind === 'vertex') {
      authStatus = await getVertexAuthStatus(provOverride?.cloud?.kind === 'vertex' ? provOverride.cloud : undefined);
    } else {
      const piStatus = (reg.modelRuntime as any).getProviderAuthStatus?.(id) ?? { configured: false };
      authStatus = piStatus;
    }
    return {
      providerId: id,
      displayName: cat?.displayName ?? id,
      kind: cat?.kind ?? 'apiKey',
      authStatus,
      models,
      defaultModel,
    };
  }

  async configure(args: { providerId: ProviderId; cfg: LlmConfigureCfg }): Promise<LlmListResult> {
    const reg = getProviderRegistry();
    if (args.cfg.kind === 'apiKey') {
      const cfg = args.cfg;
      const settings = await settingsService.get();
      await settingsService.update({
        llm: {
          ...settings.llm,
          auth: {
            ...settings.llm.auth,
            [args.providerId]: { type: 'api_key', key: cfg.apiKey },
          },
          providers: {
            ...settings.llm.providers,
            [args.providerId]: {
              ...(settings.llm.providers[args.providerId] ?? {}),
              baseUrl: cfg.baseUrl,
              headers: cfg.headers,
            },
          },
        },
      });
      await reg.refreshAfterProviderChange(settingsService, agentService, [args.providerId]);
    } else if (args.cfg.kind === 'cloud') {
      const cfg = args.cfg;
      const settings = await settingsService.get();
      const next: SettingsFile = {
        ...settings,
        llm: {
          ...settings.llm,
          auth: cfg.apiKey
            ? { ...settings.llm.auth, [args.providerId]: { type: 'api_key', key: cfg.apiKey } }
            : settings.llm.auth,
          providers: {
            ...settings.llm.providers,
            [args.providerId]: {
              ...(settings.llm.providers[args.providerId] ?? {}),
              baseUrl: cfg.baseUrl,
              cloud: cfg.cloud,
            },
          },
        },
      };
      await settingsService.update(next);
      applyCloudEnv((await settingsService.get()).llm.providers);
      await reg.refreshAfterProviderChange(settingsService, agentService, [args.providerId]);
    } else if (args.cfg.kind === 'custom') {
      const cp = args.cfg.provider;
      const settings = await settingsService.get();
      const others = settings.llm.customProviders.filter((x) => x.id !== cp.id);
      await settingsService.update({
        llm: { ...settings.llm, customProviders: [...others, cp] },
      });
      await reg.refreshAfterProviderChange(settingsService, agentService, [cp.id]);
    }
    return this.list();
  }

  async setDefault(providerId: ProviderId, modelId: string): Promise<LlmListResult> {
    // Write both the global default AND the per-provider default model so the
    // form's model picker visually persists the selection. Without the per-provider
    // write, entryFor() falls back to models[0] and the dropdown reverts on refresh.
    const settings = await settingsService.get();
    const isCustom = settings.llm.customProviders.some((cp) => cp.id === providerId);
    const customProviders = isCustom
      ? settings.llm.customProviders.map((cp) =>
          cp.id === providerId ? { ...cp, defaultModel: modelId } : cp,
        )
      : settings.llm.customProviders;
    const providers = isCustom
      ? settings.llm.providers
      : {
          ...settings.llm.providers,
          [providerId]: {
            ...(settings.llm.providers[providerId] ?? {}),
            defaultModel: modelId,
          },
        };
    await settingsService.update({
      llm: {
        ...settings.llm,
        providers,
        customProviders,
        defaultProvider: providerId,
        defaultModel: modelId,
      },
    });
    await agentService.recomputeSessionsAfterDefaultChange();
    return this.list();
  }

  async setThreadOverride(threadId: string, override: { providerId: ProviderId; modelId: string } | null): Promise<LlmListResult> {
    await threadService.update({ threadId, modelOverride: override });
    await agentService.invalidateSessionsForThread(threadId);
    return this.list();
  }

  async remove(providerId: ProviderId): Promise<LlmListResult> {
    const reg = getProviderRegistry();
    const settings = await settingsService.get();
    const next = sweepDefaultsAfterRemove(settings, providerId);
    await settingsService.update(next);
    applyCloudEnv(next.llm.providers);
    await reg.refreshAfterProviderChange(settingsService, agentService, [providerId]);
    if (settings.llm.defaultProvider === providerId) {
      await agentService.recomputeSessionsAfterDefaultChange();
    }
    return this.list();
  }

  async removeCustom(customId: string): Promise<LlmListResult> {
    return this.remove(customId);
  }

  async testConnection(providerId: ProviderId): Promise<LlmTestConnectionResult> {
    try {
      const reg = getProviderRegistry();
      const all = (reg.modelRuntime as any).getModels?.() ?? [];
      const has = (all as Array<{ provider: string }>).some((m) => m.provider === providerId);
      return { ok: has, message: has ? undefined : 'no models registered for provider' };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }
}

export const llmService = new LlmService();
