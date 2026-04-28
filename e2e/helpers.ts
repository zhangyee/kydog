import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type LaunchedApp = { app: ElectronApplication; page: Page; userDataDir: string; kydogHome: string };

export async function launchKydog(opts: { fixture?: string; preserveHome?: boolean } = {}): Promise<LaunchedApp> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-userdata-'));
  const kydogHome = opts.preserveHome
    ? path.join(os.tmpdir(), 'kydog-test-home-shared')
    : await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-home-'));
  const env: Record<string, string> = {
    ...process.env,
    HOME: kydogHome,
    USERPROFILE: kydogHome,
    KYDOG_LOG: 'warn',
  };
  if (opts.fixture) env.KYDOG_AGENT_FIXTURE = opts.fixture;
  const app = await electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    env,
    timeout: 20_000,
  });
  const page = await app.firstWindow();
  return { app, page, userDataDir, kydogHome };
}

export async function teardown(launched: LaunchedApp): Promise<void> {
  await launched.app.close();
  await fs.rm(launched.userDataDir, { recursive: true, force: true }).catch(() => {});
}
