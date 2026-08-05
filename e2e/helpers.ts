import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type LaunchedApp = { app: ElectronApplication; page: Page; userDataDir: string; kydogHome: string };

export async function launchKydog(opts: {
  fixture?: string;
  seed?: (kydogHome: string) => Promise<void>;
  /** Extra env vars merged into the launched Electron process (e.g. KYDOG_E2E, KYDOG_OAUTH_FIXTURE). */
  env?: Record<string, string>;
  /** true = 全新 HOME 不预置（onboarding 专项用）。默认自动预置"已完成 onboarding"。 */
  freshHome?: boolean;
  /** 传入则复用该 HOME（重启场景）。 */
  kydogHome?: string;
} = {}): Promise<LaunchedApp> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-userdata-'));
  const kydogHome = opts.kydogHome ?? await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-home-'));
  if (!opts.freshHome && !opts.kydogHome) await seedSettings(kydogHome);
  if (opts.seed) await opts.seed(kydogHome);
  const env: Record<string, string> = {
    ...process.env,
    HOME: kydogHome,
    USERPROFILE: kydogHome,
    KYDOG_LOG: 'warn',
    KYDOG_E2E: '1',
    ...(opts.env ?? {}),
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

export async function seedSettings(kydogHome: string, opts: { providerConfigured?: boolean; onboardingCompleted?: boolean; locale?: 'zh' | 'en' } = {}) {
  await fs.mkdir(path.join(kydogHome, '.kydog'), { recursive: true });
  const v4 = {
    schemaVersion: 4 as const,  // 故意留在 v4：让 e2e 每次都走一遍 v4 → v7 迁移
    ui: {
      theme: 'vellum',
      locale: opts.locale ?? 'zh',
      workspaceCollapsed: false,
      inspectorCollapsed: false,
      readingFontSize: 'medium',
    },
    llm: opts.providerConfigured === false
      ? { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null }
      : {
          auth: { 'anthropic': { type: 'api_key', key: 'sk-fix' } },
          providers: { 'anthropic': {} },
          customProviders: [],
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-5',
        },
    skills: { disabledBuiltins: [] },
    tools: { externalBins: [] },
    onboarding: { completedAt: opts.onboardingCompleted === false ? null : '2026-01-01T00:00:00.000Z' },
  };
  await fs.writeFile(
    path.join(kydogHome, '.kydog', 'kydog.json'),
    JSON.stringify(v4, null, 2),
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
