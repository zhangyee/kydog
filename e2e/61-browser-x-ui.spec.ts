import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import type { DispatchAction } from '../src/main/browser/actions';

interface State { page: { clicks: number; keys: number; input: number; trustedClicks: number; trustedKeys: number; value: string }; native: number; activeTabId: string; targetTabId: string; userTabId: string; focused: boolean }
interface Harness {
  read(): Promise<State>;
  visible(): Promise<void>;
  hidden(): Promise<void>;
  act(action: DispatchAction): Promise<unknown>;
  faults(mode: string): Promise<{ before: State; after: State; error: string | null }>;
  bindings(): Promise<{ before: { documentEpoch: number; routeRevision: number }; after: { documentEpoch: number; routeRevision: number }; error: string | null }>;
  stop(): void;
}

// One isolated process for the feature area. Each repeat receives a fresh profile.
// Production BrowserService and XQueuedPage are imported into the fixture bundle;
// only the fixture has a global controller, never the shipped application.
test.describe('X browser port native safety (offline)', () => {
  test.describe.configure({ mode: 'serial' });
  let app: ElectronApplication, dir: string;
  const control = <T>(fn: (h: Harness, value: string) => Promise<T>, value = '') => app.evaluate((_electron, source) => {
    const run = new Function('h', 'value', `return (${source.fn})(h, value)`);
    return run((globalThis as unknown as { __xUiHarness: Harness }).__xUiHarness, source.value);
  }, { fn: fn.toString(), value }) as Promise<T>;
  test.beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-x-ui-native-'));
    await build({ configFile: false, root: path.resolve(__dirname, '..'), logLevel: 'warn', build: {
      outDir: path.join(dir, 'bundle'), emptyOutDir: true, target: 'node22',
      lib: { entry: path.resolve(__dirname, 'fixtures/61-browser/xUiHarness.ts'), formats: ['cjs'], fileName: () => 'harness.cjs' },
      rollupOptions: { external: id => id === 'electron' || id.startsWith('node:') },
    } });
    app = await _electron.launch({ args: [path.join(dir, 'bundle/harness.cjs'), '--force-device-scale-factor=1',
      ...(process.platform === 'darwin' ? ['-AppleShowScrollBars', 'Always'] : []), `--user-data-dir=${path.join(dir, 'profile')}`],
      env: { ...process.env, KYDOG_LOG: 'warn', PI_OFFLINE: '1', HOME: dir, USERPROFILE: dir }, timeout: 20_000 });
    await app.firstWindow();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __xUiReady: boolean }).__xUiReady), { timeout: 30_000 }).toBe(true);
  });
  test.afterAll(async () => { if (app) { await control(async h => { h.stop(); }); await app.close(); } if (dir) await fs.rm(dir, { recursive: true, force: true }); });

  test('visible then hidden native click/type/Enter affect the exact page without switching the user tab', async () => {
    await control(async h => { await h.visible(); });
    await control(async h => { await h.act({ kind: 'click', selector: '#open' }); await h.act({ kind: 'type', selector: '#query', text: 'visible query' }); await h.act({ kind: 'key', key: 'Enter' }); });
    const visible = await control(h => h.read());
    expect(visible.page).toMatchObject({ clicks: 1, trustedClicks: 1, keys: 1, trustedKeys: 1, value: 'visible query' });
    expect(visible.native).toBeGreaterThan(0);
    expect(visible.activeTabId).toBe(visible.targetTabId);
    await control(async h => { await h.hidden(); });
    await control(async h => { await h.act({ kind: 'click', selector: '#open' }); await h.act({ kind: 'type', selector: '#query', text: 'hidden query' }); await h.act({ kind: 'key', key: 'Enter' }); });
    const hidden = await control(h => h.read());
    expect(hidden.page).toMatchObject({ clicks: 2, trustedClicks: 2, keys: 2, trustedKeys: 2, value: 'hidden query' });
    expect(hidden.activeTabId).toBe(hidden.userTabId);
    expect(hidden.focused).toBe(true);
  });
  test('each successful native control precedes blocked cover/replacement/cancel/password/semantic/form-owner input', async () => {
    for (const mode of ['cover', 'replace', 'cancel', 'password', 'semantic', 'form-owner']) {
      const prior = await control(h => h.read());
      await control(async (h, value) => {
        await h.act(value === 'password' ? { kind: 'type', selector: '#query', text: 'safe control' } : { kind: 'click', selector: '#open' });
      }, mode);
      const positive = await control(h => h.read());
      if (mode === 'password') {
        expect(positive.page.input, mode).toBe(prior.page.input + 1);
        expect(positive.page.value, mode).toBe('safe control');
      } else expect(positive.page.trustedClicks, mode).toBe(prior.page.trustedClicks + 1);
      const result = await control((h, value) => h.faults(value), mode);
      expect(result.error, mode).toBe(mode === 'cancel' ? 'browser.cancelled' : mode === 'password' ? 'browser.password_field' : mode === 'cover' ? 'browser.click_intercepted' : mode === 'replace' ? 'browser.stale_index' : 'browser.target_unusable');
      expect(result.after.native, mode).toBe(result.before.native);
      expect(result.after.page, mode).toEqual(result.before.page);
      expect(result.after.activeTabId, mode).toBe(result.after.userTabId);
    }
  });
  test('source same-document route invalidates the old action binding', async () => {
    const result = await control(h => h.bindings());
    expect(result.after.documentEpoch).toBe(result.before.documentEpoch);
    expect(result.after.routeRevision).toBe(result.before.routeRevision + 1);
    expect(result.error).toBe('browser.stale_snapshot');
  });
});
