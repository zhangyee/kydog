// src/main/agent/sessionFactory.ts
import { createFixtureSession } from './fixtureProvider';
import { getProviderRegistry } from '../llm/providerRegistry';
import { KydogError } from '../../shared/errors';
import type { ProviderId } from '../../shared/types';

export type AnySession = {
  prompt: (content: string) => Promise<void>;
  abort: () => void | Promise<void>;
  subscribe: (listener: (event: { type: string; [k: string]: unknown }) => void) => () => void;
  cleanup?: () => Promise<void>;
  dispose?: () => void;
  readonly messages?: unknown[];
  readonly state?: { messages: unknown[] };
};

export async function createSession(opts: {
  cwd: string;
  sessionId: string;
  sessionsDir: string;
  providerId: ProviderId;
  modelId: string;
}): Promise<AnySession> {
  const fixturePath = process.env.KYDOG_AGENT_FIXTURE;
  if (fixturePath) return createFixtureSession(fixturePath);

  const pi = await import('@earendil-works/pi-coding-agent');
  const reg = getProviderRegistry();
  const model = reg.modelRegistry.find(opts.providerId, opts.modelId);
  if (!model) {
    throw new KydogError('llm.invalid', `model not found: ${opts.providerId}/${opts.modelId}`);
  }

  const { createKydogResourceLoader } = await import('../skills/skillResourceLoader');
  const resourceLoader = await createKydogResourceLoader(opts.cwd);
  await resourceLoader.reload();
  const sessionFile = `${opts.sessionsDir}/${opts.sessionId}.jsonl`;
  const { session } = await (pi as any).createAgentSession({
    cwd: opts.cwd,
    sessionManager: (pi as any).SessionManager.open(sessionFile),
    authStorage: reg.authStorage,
    modelRegistry: reg.modelRegistry,
    model,
    resourceLoader,
  });
  return session as AnySession;
}
