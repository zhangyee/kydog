// src/main/agent/runState.ts
export type RunState =
  | { status: 'idle' }
  | { status: 'running'; runId: string; abortRequested: boolean }
  | { status: 'error'; error: string };

export type RunEvent =
  | { kind: 'send'; runId: string }
  | { kind: 'abort' }
  | { kind: 'completed' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string };

export function transition(state: RunState, evt: RunEvent): RunState {
  switch (evt.kind) {
    case 'send':
      return { status: 'running', runId: evt.runId, abortRequested: false };
    case 'abort':
      return state.status === 'running' ? { ...state, abortRequested: true } : state;
    case 'completed':
    case 'aborted':
      return state.status === 'running' ? { status: 'idle' } : state;
    case 'error':
      return { status: 'error', error: evt.message };
  }
}
