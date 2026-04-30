import { createFixtureSession } from './fixtureProvider';

export type AnySession = {
  prompt: (content: string) => Promise<void>;
  abort: () => void | Promise<void>;
  subscribe: (listener: (event: { type: string; [k: string]: unknown }) => void) => () => void;
  cleanup?: () => Promise<void>;        // fake has it; real uses dispose()
  dispose?: () => void;                 // real has it
  readonly messages?: unknown[];        // real exposes top-level messages; fake has state.messages
  readonly state?: { messages: unknown[] };  // fake shape
};

export async function createSession(opts: {
  cwd: string;
  sessionId: string;
  sessionsDir: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}): Promise<AnySession> {
  const fixturePath = process.env.KYDOG_AGENT_FIXTURE;
  if (fixturePath) return createFixtureSession(fixturePath);

  const pi = await import('@mariozechner/pi-coding-agent');
  const authStorage = pi.AuthStorage.create();
  authStorage.setRuntimeApiKey('openai-compat', opts.apiKey);
  const modelRegistry = pi.ModelRegistry.create(authStorage);
  modelRegistry.registerProvider('openai-compat', {
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    api: 'openai-completions',
    models: [{
      id: opts.model,
      name: opts.model,
      api: 'openai-completions',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_000,
    }],
  });
  const model = modelRegistry.find('openai-compat', opts.model);
  if (!model) {
    throw new Error(`failed to register custom model ${opts.model} on provider openai-compat`);
  }
  const { createKydogResourceLoader } = await import('../skills/skillResourceLoader');
  const resourceLoader = await createKydogResourceLoader(opts.cwd);
  await resourceLoader.reload();
  const sessionFile = `${opts.sessionsDir}/${opts.sessionId}.jsonl`;
  const { session } = await pi.createAgentSession({
    cwd: opts.cwd,
    sessionManager: pi.SessionManager.open(sessionFile),
    authStorage,
    modelRegistry,
    model,
    resourceLoader,
  });
  return session as AnySession;
}
