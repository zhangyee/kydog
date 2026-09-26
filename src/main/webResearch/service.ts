import { session } from 'electron';
import { KydogError } from '../../shared/errors';
import { getProviderRegistry } from '../llm/providerRegistry';
import { createResearchModelAdapter } from './extractClaims';
import { extractBody } from './extractBody';
import { fetchSource } from './fetchSource';
import { ResearchRunService } from './researchRun';
import { researchRunStore } from './runStore';

let service: ResearchRunService | undefined;

/** One process-wide queue owner; sessions only bind thread/run identity around it. */
export function getWebResearchService(): ResearchRunService {
  if (service) return service;
  service = new ResearchRunService({
    store: researchRunStore,
    fetch: (input) => fetchSource(input, {
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    }),
    parse: extractBody,
    resolveModel: async (threadId) => {
      // Dynamic import avoids sessionFactory → service → threadService → AgentService
      // → sessionFactory at module load time.
      const { resolveActive } = await import('../agent/resolveActive');
      const { providerId, modelId } = await resolveActive(threadId, '');
      const registry = getProviderRegistry();
      if (!registry.modelRuntime.getModel(providerId, modelId)) {
        throw new KydogError('llm.not_configured', `没有可用的模型 ${providerId}/${modelId}`);
      }
      return { providerId, modelId, runtimeRevision: registry.runtimeRevision };
    },
    adapter: createResearchModelAdapter(),
  });
  return service;
}
