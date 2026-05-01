import { settingsService } from '../settings/settingsService';
import { resolveProviderDefault } from '../llm/resolveProvider';
import { threadService } from '../thread/threadService';
import type { ProviderId } from '../../shared/types';

export class ResolveError extends Error {
  constructor(public code: 'no-provider' | 'no-model', message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

interface ThreadGetter {
  get(threadId: string): Promise<{ id: string; modelOverride?: { providerId: ProviderId; modelId: string } } | null>;
}

const defaultThreadGetter: ThreadGetter = {
  async get(threadId) {
    const all = await threadService.listAll();
    return all.find((t) => t.id === threadId) ?? null;
  },
};

/** 解析当前 thread 应使用的 active provider/model。失败抛 ResolveError。 */
export async function resolveActive(
  threadId: string,
  _projectPath: string,
  store: ThreadGetter = defaultThreadGetter,
): Promise<{ providerId: ProviderId; modelId: string }> {
  const settings = await settingsService.get();
  const thread = await store.get(threadId);
  const override = thread?.modelOverride;
  const providerId = override?.providerId ?? settings.llm.defaultProvider;
  if (!providerId) {
    throw new ResolveError('no-provider', 'no provider configured (settings.llm.defaultProvider is null)');
  }
  const modelId =
    override?.modelId ??
    resolveProviderDefault(settings, providerId) ??
    settings.llm.defaultModel ??
    null;
  if (!modelId) {
    throw new ResolveError('no-model', `no model configured for ${providerId}`);
  }
  return { providerId, modelId };
}
