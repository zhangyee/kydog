import { promises as fs } from 'node:fs';
import type { FixtureFile, FixtureEvent } from '../../../e2e/fixtures/fixture.types';

export type FakeSessionListener = (event: { type: string; [k: string]: unknown }) => void;

export type FakeAgentSession = {
  prompt: (content: string) => Promise<void>;
  abort: () => void;
  subscribe: (listener: FakeSessionListener) => () => void;
  cleanup: () => Promise<void>;
  state: { messages: unknown[] };
};

export async function createFixtureSession(fixturePath: string): Promise<FakeAgentSession> {
  const raw = await fs.readFile(fixturePath, 'utf8');
  const file = JSON.parse(raw) as FixtureFile;
  const listeners = new Set<FakeSessionListener>();
  let aborted = false;

  return {
    state: { messages: [] },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    abort() { aborted = true; },
    async cleanup() { listeners.clear(); },
    async prompt() {
      for (const evt of file.events) {
        if (aborted && evt.type !== 'agent_end') continue;
        await new Promise((r) => setTimeout(r, evt.after_ms));
        emit(listeners, evt, aborted);
        if (evt.type === 'agent_end') break;
      }
    },
  };
}

function emit(listeners: Set<FakeSessionListener>, evt: FixtureEvent, aborted: boolean) {
  const piShape = toPiShape(evt, aborted);
  if (!piShape) return;
  for (const l of listeners) l(piShape);
}

function toPiShape(evt: FixtureEvent, aborted: boolean): { type: string; [k: string]: unknown } | null {
  switch (evt.type) {
    case 'agent_start':   return { type: 'agent_start' };
    case 'message_start': return { type: 'message_start', messageId: evt.messageId };
    case 'text_delta':    return { type: 'message_update', messageId: evt.messageId, assistantMessageEvent: { type: 'text_delta', delta: evt.delta } };
    case 'tool_start':    return { type: 'tool_execution_start', toolCallId: evt.toolCallId, toolName: evt.name, input: { command: evt.command } };
    case 'tool_chunk':    return { type: 'tool_execution_update', toolCallId: evt.toolCallId, stream: evt.stream, chunk: evt.chunk };
    case 'tool_end':      return { type: 'tool_execution_end', toolCallId: evt.toolCallId, isError: evt.status === 'failed', exitCode: evt.exitCode };
    case 'message_end':   return { type: 'message_end', messageId: evt.messageId };
    case 'agent_end':     return { type: 'agent_end', reason: aborted ? 'aborted' : evt.reason, errorMessage: evt.errorMessage };
  }
}
