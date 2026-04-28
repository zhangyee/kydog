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

  // baseUrl + model overrides require a custom models.json via ModelRegistry.create(authStorage, modelsJsonPath).
  // Wired before Phase 4 manual smoke when the provider settings UI persists pi-models.json.
  const pi = await import('@mariozechner/pi-coding-agent');
  const authStorage = pi.AuthStorage.create();
  authStorage.setRuntimeApiKey('openai-compat', opts.apiKey);
  const modelRegistry = pi.ModelRegistry.create(authStorage);
  const sessionFile = `${opts.sessionsDir}/${opts.sessionId}.jsonl`;
  const { session } = await pi.createAgentSession({
    cwd: opts.cwd,
    sessionManager: pi.SessionManager.open(sessionFile),
    authStorage,
    modelRegistry,
  });
  return session as AnySession;
}
