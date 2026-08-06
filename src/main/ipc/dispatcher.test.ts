import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture ipcMain.handle registrations so we can invoke them directly in tests.
const handlers: Record<string, (evt: unknown, raw: unknown) => Promise<unknown>> = {};

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (evt: unknown, raw: unknown) => Promise<unknown>) => {
      handlers[channel] = fn;
    },
  },
}));

import { installDispatcher, registerHandler, _clearHandlersForTesting } from './dispatcher';
import { RPC_CHANNEL } from '../../shared/protocol';

const fakeEvt = {};

describe('dispatcher', () => {
  beforeEach(() => {
    // Clear electron-side channel registrations.
    for (const k of Object.keys(handlers)) delete handlers[k];
    // Clear internal handler map.
    _clearHandlersForTesting();
    installDispatcher();
  });

  it('routes to a registered handler and returns ok', async () => {
    registerHandler('settings.get', async () => ({ schemaVersion: 7, ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'medium' }, llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null }, skills: { disabledBuiltins: [] }, tools: { externalBins: [] }, research: { presets: {}, custom: [] }, updates: { autoCheck: true, dismissedCandidateId: null }, telemetry: { state: 'undecided', decidedAt: null }, onboarding: { completedAt: null } }));
    const invoke = handlers[RPC_CHANNEL];
    const result = await invoke(fakeEvt, { method: 'settings.get', args: undefined });
    expect(result).toMatchObject({ ok: true, data: { schemaVersion: 7 } });
  });

  it('returns serialized error when handler throws', async () => {
    registerHandler('settings.get', async () => { throw new Error('boom'); });
    const invoke = handlers[RPC_CHANNEL];
    const result = await invoke(fakeEvt, { method: 'settings.get', args: undefined });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown', message: 'boom' } });
  });

  it('returns unknown-method error when no handler registered', async () => {
    const invoke = handlers[RPC_CHANNEL];
    const result = await invoke(fakeEvt, { method: 'settings.get', args: undefined }) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unknown');
    expect(result.error.message).toMatch(/no handler/);
  });

  it('returns malformed-payload error for null', async () => {
    const invoke = handlers[RPC_CHANNEL];
    const result = await invoke(fakeEvt, null) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unknown');
    expect(result.error.message).toMatch(/malformed/);
  });

  it('returns malformed-payload error for string payload', async () => {
    const invoke = handlers[RPC_CHANNEL];
    const result = await invoke(fakeEvt, 'bad') as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unknown');
    expect(result.error.message).toMatch(/malformed/);
  });

  it('returns malformed-payload error when method is missing', async () => {
    const invoke = handlers[RPC_CHANNEL];
    const result = await invoke(fakeEvt, { args: undefined }) as { ok: false; error: { code: string; message: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unknown');
    expect(result.error.message).toMatch(/malformed/);
  });
});
