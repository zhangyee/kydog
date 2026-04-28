import type { FakeAgentSession } from './fixtureProvider';
import { createFixtureSession } from './fixtureProvider';

export type AnySession = FakeAgentSession | {
  prompt: (content: string) => Promise<void>;
  abort: () => void;
  subscribe: (listener: (event: { type: string; [k: string]: unknown }) => void) => () => void;
  cleanup?: () => Promise<void>;
  state: { messages: unknown[] };
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
  const sessionFile = `${opts.sessionsDir}/${opts.sessionId}.jsonl`;
  const { session } = await pi.createAgentSession({
    cwd: opts.cwd,
    sessionManager: pi.SessionManager.open(sessionFile),
  });
  return session as unknown as AnySession;
}
