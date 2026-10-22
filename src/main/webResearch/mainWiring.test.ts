import { describe, expect, it, vi } from 'vitest';
import type { App } from 'electron';
import { installWebResearchQuitWiring } from './mainWiring';
vi.mock('../log', () => ({ logger: { error: vi.fn() } }));

describe('research quit wiring', () => {
  it.each([false, true])('revokes synchronously, drains once and permits the second quit (failure=%s)', async fail => {
    let listener!: (event: { preventDefault(): void }) => void, finish!: () => void;
    let revoked = false;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const shutdown = vi.fn(() => { revoked = true; return gate.then(() => { if (fail) throw new Error('disk'); }); });
    const event = { preventDefault: vi.fn() };
    const app = { on: (_name: string, fn: typeof listener) => { listener = fn; }, quit: vi.fn(() => listener(event)) };
    installWebResearchQuitWiring(app as unknown as App, shutdown);
    listener(event); expect(revoked).toBe(true); expect(event.preventDefault).toHaveBeenCalledTimes(1);
    listener(event); expect(shutdown).toHaveBeenCalledTimes(1); expect(event.preventDefault).toHaveBeenCalledTimes(2);
    finish(); await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(event.preventDefault).toHaveBeenCalledTimes(2); expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
