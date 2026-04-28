import type { RunState } from './runState';
export type { RunState } from './runState';

export class AgentService {
  private sessions = new Map<string, unknown>();  // typed as AgentSession in Phase 2 when pi SDK is wired
  private runs = new Map<string, RunState>();
  // Phase 2: ensureSession, send, abort, event forwarding
}

export const agentService = new AgentService();
