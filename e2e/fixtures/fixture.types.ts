export type FixtureEvent =
  | { after_ms: number; type: 'agent_start' }
  | { after_ms: number; type: 'message_start'; messageId: string }
  | { after_ms: number; type: 'text_delta'; messageId: string; delta: string }
  | { after_ms: number; type: 'thinking_delta'; messageId: string; delta: string }
  | { after_ms: number; type: 'tool_start'; toolCallId: string; name: string; command: string; args?: Record<string, unknown> }
  | { after_ms: number; type: 'tool_chunk'; toolCallId: string; stream: 'stdout' | 'stderr'; chunk: string }
  | { after_ms: number; type: 'tool_end'; toolCallId: string; status: 'ok' | 'failed'; exitCode: number }
  | { after_ms: number; type: 'message_end'; messageId: string; toolCallIds?: string[] }
  | { after_ms: number; type: 'agent_end'; reason: 'completed' | 'aborted' | 'error'; errorMessage?: string };

export type FixtureFile = { events: FixtureEvent[] };
