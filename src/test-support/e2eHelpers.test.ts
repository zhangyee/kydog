import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@playwright/test', async () => ({
  _electron: { launch: vi.fn() },
  expect: (await import('vitest')).expect,
}));
import { _electron } from '@playwright/test';
import { launchKydog } from '../../e2e/helpers';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) await fs.rm(dir, {recursive: true, force: true});
});

describe('E2E launch ownership', () => {
  it.each(['firstWindow', 'bounds', 'readiness'] as const)('awaits owned cleanup after %s fails and preserves the startup error', async stage => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-launch-unit-'));
    directories.push(home);
    const failure = new Error('startup failed');
    const order: string[] = [];
    let beginClose!: () => void;
    let finishClose!: () => void;
    const closing = new Promise<void>(resolve => { beginClose = resolve; });
    const closed = new Promise<void>(resolve => { finishClose = resolve; });
    const waitFor = vi.fn(async () => { if (stage === 'readiness') throw failure; });
    const page = {locator: () => ({first: () => ({waitFor})})};
    const app = {
      firstWindow: async () => { if (stage === 'firstWindow') throw failure; return page; },
      evaluate: async () => { if (stage === 'bounds') throw failure; },
      close: vi.fn(async () => { order.push('close started'); beginClose(); await closed; order.push('close finished'); }),
    };
    vi.mocked(_electron.launch).mockImplementation(async options => {
      const arg = options!.args!.find(value => value.startsWith('--user-data-dir='))!;
      directories.push(arg.slice('--user-data-dir='.length));
      return app as never;
    });
    const launched = launchKydog({freshHome: true, kydogHome: home}).catch(error => {
      order.push('startup rejected'); return error;
    });
    await closing;
    // Hold cleanup at its real promise boundary; outcome must follow its settlement.
    finishClose();
    expect(await launched).toBe(failure);
    expect(order).toEqual(['close started', 'close finished', 'startup rejected']);
    expect(app.close).toHaveBeenCalledOnce();
  });

  it('preserves the original startup failure when cleanup also rejects', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-launch-unit-'));
    directories.push(home);
    const startup = new Error('startup'), cleanup = new Error('cleanup');
    const close = vi.fn(async () => { throw cleanup; });
    vi.mocked(_electron.launch).mockImplementation(async options => {
      directories.push(options!.args!.find(value => value.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length));
      return {firstWindow: async () => {throw startup;}, close} as never;
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(launchKydog({freshHome: true, kydogHome: home})).rejects.toBe(startup);
    expect(close).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('[launchKydog cleanup failed]', cleanup);
  });
});
