import { createFixtureSession } from './fixtureProvider';

export type AnySession = {
  prompt: (content: string) => Promise<void>;
  abort: () => void | Promise<void>;
  subscribe: (listener: (event: { type: string; [k: string]: unknown }) => void) => () => void;
  cleanup?: () => Promise<void>;
  dispose?: () => void;
  readonly messages?: unknown[];
  readonly state?: { messages: unknown[] };
};

// Phase 0 stub: only fixture path retained so existing e2e survives.
// Real provider integration is rewired in Phase 2 via ProviderRegistry.
export async function createSession(_opts: {
  cwd: string;
  sessionId: string;
  sessionsDir: string;
}): Promise<AnySession> {
  const fixturePath = process.env.KYDOG_AGENT_FIXTURE;
  if (fixturePath) return createFixtureSession(fixturePath);
  throw new Error('createSession: real provider integration moved to Phase 2 (no provider configured)');
}
