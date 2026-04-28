import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type LaunchedApp = { app: ElectronApplication; page: Page; userDataDir: string; kydogHome: string };

export async function launchKydog(opts: { fixture?: string; seed?: (kydogHome: string) => Promise<void> } = {}): Promise<LaunchedApp> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-userdata-'));
  const kydogHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-home-'));
  if (opts.seed) await opts.seed(kydogHome);
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

export async function seedSettings(kydogHome: string, opts: { providerConfigured?: boolean } = {}) {
  await fs.mkdir(path.join(kydogHome, '.kydog'), { recursive: true });
  const provider = opts.providerConfigured === false
    ? null
    : { kind: 'openai-compat', name: 'Fixture', baseUrl: 'http://fixture', apiKey: 'sk-fix', model: 'fix' };
  await fs.writeFile(
    path.join(kydogHome, '.kydog', 'kydog.json'),
    JSON.stringify({
      schemaVersion: 1,
      ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false },
      llm: { provider },
    }, null, 2),
  );
}

export async function seedProject(kydogHome: string, projectPath: string, threads: Array<{ id: string; title: string }> = []) {
  await fs.mkdir(path.join(kydogHome, '.kydog'), { recursive: true });
  await fs.writeFile(
    path.join(kydogHome, '.kydog', 'index.json'),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: projectPath, addedAt: new Date().toISOString() }],
      threads: threads.map((t) => ({
        id: t.id,
        projectPath,
        title: t.title,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      })),
    }, null, 2),
  );
}

export async function seedSamplePackage(projectPath: string) {
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'README.md'), '# sample\n');
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectPath, 'src', 'a.ts'), 'export const a = 1;\n');
}

export async function teardown(launched: LaunchedApp): Promise<void> {
  await launched.app.close();
  await fs.rm(launched.userDataDir, { recursive: true, force: true }).catch(() => {});
}
