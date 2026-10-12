import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { launchKydog } from './helpers';

// This case needs its own process: startup deliberately rejects before a caller
// can receive LaunchedApp. Only firstWindow's result is replaced, after a real
// window exists; launch, process ownership, and close all remain real.
test('failed post-launch initialization closes the owned Electron process and caller proxy', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-launch-failure-'));
  console.info('[isolated-fixture-directory]', dir);
  const fixture = path.join(dir, 'fixture.json');
  await fs.writeFile(fixture, JSON.stringify({ events: [] }));
  const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  const originalLaunch = electron.launch;
  const failure = new Error('controlled failure after actual firstWindow');
  let owned: ElectronApplication | undefined;
  let child: ChildProcess | undefined;
  let appClosed = false, proxyClosed = false;
  const lifecycle: string[] = [];
  proxy.once('close', () => { proxyClosed = true; lifecycle.push('proxy-close'); });
  try {
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    electron.launch = async (...args) => {
      owned = await originalLaunch.apply(electron, args);
      const app = owned;
      child = app.process();
      app.once('close', () => { appClosed = true; lifecycle.push('app-close'); });
      child.once('exit', (code, signal) => lifecycle.push(`process-exit:${code}:${signal}`));
      const originalFirstWindow = app.firstWindow.bind(app);
      app.firstWindow = async (...windowArgs) => {
        const page = await originalFirstWindow(...windowArgs);
        expect(page.isClosed()).toBe(false);
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);
        expect(child!.exitCode).toBeNull();
        expect(child!.signalCode).toBeNull();
        expect(appClosed).toBe(false);
        expect(proxy.listening).toBe(true);
        const status = await new Promise<number | undefined>((resolve, reject) => {
          http.get({ hostname: '127.0.0.1', port: (proxy.address() as AddressInfo).port, agent: false }, res => {
            res.resume(); res.once('end', () => resolve(res.statusCode));
          }).once('error', reject);
        });
        expect(status).toBe(403);
        lifecycle.push('live-process-window-and-proxy');
        throw failure;
      };
      return app;
    };
    let caught: unknown;
    try { await launchKydog({ fixture }); }
    catch (error) { caught = error; }
    finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
    expect(caught).toBe(failure);
    expect(appClosed).toBe(true);
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    expect(proxyClosed).toBe(true);
    expect(proxy.listening).toBe(false);
    expect(lifecycle[0]).toBe('live-process-window-and-proxy');
    expect(lifecycle.some(event => event.startsWith('process-exit:'))).toBe(true);
    console.info('[startup-failure-cleanup]', JSON.stringify({ pid: child!.pid, lifecycle }));
  } finally {
    electron.launch = originalLaunch;
    // The regression itself must also clean up when tested against the broken
    // helper. Use only the exact launch handle, never a PID/name search.
    try { if (owned) await owned.close(); }
    finally { if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve())); }
    console.info('[startup-failure-finally]', JSON.stringify({ pid: child?.pid, exitCode: child?.exitCode, signalCode: child?.signalCode, appClosed, proxyClosed, proxyListening: proxy.listening }));
  }
});
