import { session } from 'electron';
import { KydogError } from '../../shared/errors';
import { getProviderRegistry } from '../llm/providerRegistry';
import { createResearchModelAdapter } from './extractClaims';
import { extractBody } from './extractBody';
import { fetchSiteIcon, fetchSource } from './fetchSource';
import { ResearchRunService } from './researchRun';
import { researchRunStore } from './runStore';
import { WebResearchTaskService } from './taskService';
import { webResearchTaskStore } from './taskStore';
import { broadcaster } from '../ipc/broadcaster';
import { createBrowserReader } from './browserReader';
import { browserService } from '../browser/browserService';
import { BROWSER_PARTITION } from '../browser/partition';

let service: ResearchRunService | undefined;
let taskService: WebResearchTaskService | undefined;

async function mediumBrowserHeaders(url: string): Promise<{ cookie?: string; userAgent?: string }> {
  const host = new URL(url).hostname.toLowerCase();
  if (host !== 'medium.com' && !host.endsWith('.medium.com')) return {};
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  const cookies = await browserSession.cookies.get({ url });
  return {
    cookie: cookies.length ? cookies.map(({ name, value }) => `${name}=${value}`).join('; ') : undefined,
    userAgent: browserSession.getUserAgent(),
  };
}

export function getWebResearchTaskService(): WebResearchTaskService {
  if (taskService) return taskService;
  taskService = new WebResearchTaskService({
    store: webResearchTaskStore,
    browserReader: createBrowserReader({ browser: browserService }),
    fetch: (input) => fetchSource(input, {
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
      getMediumBrowserHeaders: mediumBrowserHeaders,
    }),
    fetchIcon: (url, signal) => fetchSiteIcon(url, signal,
      { resolveProxy: (target) => session.defaultSession.resolveProxy(target) }),
    parse: extractBody,
    resolveModel: async (threadId) => {
      const { resolveActive } = await import('../agent/resolveActive');
      const { providerId, modelId } = await resolveActive(threadId, '');
      const registry = getProviderRegistry();
      if (!registry.modelRuntime.getModel(providerId, modelId)) {
        throw new KydogError('llm.not_configured', `没有可用的模型 ${providerId}/${modelId}`);
      }
      return { providerId, modelId, runtimeRevision: registry.runtimeRevision };
    },
    adapter: createResearchModelAdapter(),
    onUpdate: (snapshot) => broadcaster.emit('webResearch.taskUpdated', snapshot),
  });
  return taskService;
}

/** One process-wide queue owner; sessions only bind thread/run identity around it. */
export function getWebResearchService(): ResearchRunService {
  if (service) return service;
  service = new ResearchRunService({
    store: researchRunStore,
    fetch: (input) => fetchSource(input, {
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
      getMediumBrowserHeaders: mediumBrowserHeaders,
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
