// src/main/agent/runState.test.ts
import { describe, it, expect } from 'vitest';
import { transition, type RunState } from './runState';

const idle: RunState = { status: 'idle' };
const running: RunState = { status: 'running', runId: 'r1', abortRequested: false };

describe('transition', () => {
  it('idle + send → running', () => {
    expect(transition(idle, { kind: 'send', runId: 'r1' })).toEqual({ status: 'running', runId: 'r1', abortRequested: false });
  });
  it('running + abort → running with abortRequested=true', () => {
    expect(transition(running, { kind: 'abort' })).toEqual({ ...running, abortRequested: true });
  });
  it('running + completed → idle', () => {
    expect(transition(running, { kind: 'completed' })).toEqual({ status: 'idle' });
  });
  it('running + aborted → idle', () => {
    expect(transition(running, { kind: 'aborted' })).toEqual({ status: 'idle' });
  });
  it('running + error → error', () => {
    expect(transition(running, { kind: 'error', message: 'boom' })).toEqual({ status: 'error', error: 'boom' });
  });
  it('error + send → running (clears error)', () => {
    expect(transition({ status: 'error', error: 'x' }, { kind: 'send', runId: 'r2' })).toEqual({ status: 'running', runId: 'r2', abortRequested: false });
  });
  it('idle + abort → no change (idempotent)', () => {
    expect(transition(idle, { kind: 'abort' })).toEqual(idle);
  });
});
