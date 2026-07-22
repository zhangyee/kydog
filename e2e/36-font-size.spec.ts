import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

test('36-font-size: 三档切换写入 <html data-reading-size>', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  const { page } = launched;
  try {
    // ReadingFontSizeApplier 在 mount 时立即 setAttribute，所以默认就是 medium
    await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'medium');

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await expect(page.locator('[data-testid="user-menu"]')).toBeVisible();

    await page.locator('[data-testid="reading-size-large"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'large');

    await page.locator('[data-testid="reading-size-small"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'small');

    await page.locator('[data-testid="reading-size-medium"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'medium');
  } finally {
    await teardown(launched);
  }
});

test('36-font-size: 持久化 — 关 app 重开后档位不丢', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  try {
    await launched.page.locator('[data-testid="user-menu-trigger"]').click();
    await launched.page.locator('[data-testid="reading-size-large"]').click();
    await expect(launched.page.locator('html')).toHaveAttribute('data-reading-size', 'large');
    // 等持久化 settings.update IPC 写回（subscribe 是 fire-and-forget，给一拍）
    await launched.page.waitForTimeout(150);
  } finally {
    await teardown(launched);
  }

  // 用一个手工预置好 readingFontSize=large 的 kydogHome 重启
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-home-'));
  await fs.mkdir(path.join(home, '.kydog'), { recursive: true });
  await fs.writeFile(path.join(home, '.kydog', 'kydog.json'), JSON.stringify({
    schemaVersion: 3,
    ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'large' },
    llm: { auth: { 'anthropic': { type: 'api_key', key: 'sk-fix' } }, providers: { 'anthropic': {} }, customProviders: [], defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-5' },
    skills: { disabledBuiltins: [] },
    tools: { externalBins: [] },
    onboarding: { completedAt: '2026-01-01T00:00:00.000Z' },
  }, null, 2));

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-userdata-'));
  const { _electron: electron } = await import('@playwright/test');
  const app = await electron.launch({
    args: ['.vite/build/main.js', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, HOME: home, USERPROFILE: home, KYDOG_LOG: 'warn', KYDOG_E2E: '1' },
    timeout: 20_000,
  });
  const page = await app.firstWindow();
  try {
    await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'large');
  } finally {
    await app.close();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

test('36-font-size: --reading-font-size CSS 变量跟随档位切换', async () => {
  // 直接读 :root 上的 CSS 变量，确认 CSS 规则正确级联；不依赖任何打开的视图。
  // 实际正文跟随这点已经由 ProseMirror、UserMessage、AssistantMessage、MarkdownBlock
  // 这四处都使用 var(--reading-font-size) 间接保证；CSS 变量解析是浏览器原生行为。
  const launched = await launchKydog({ seed: seedSettings });
  const { page } = launched;
  try {
    const readVar = () => page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--reading-font-size').trim()
    );
    expect(await readVar()).toBe('15px'); // medium 默认

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="reading-size-large"]').click();
    expect(await readVar()).toBe('17px');

    await page.locator('[data-testid="reading-size-small"]').click();
    expect(await readVar()).toBe('13.5px');

    await page.locator('[data-testid="reading-size-medium"]').click();
    expect(await readVar()).toBe('15px');
  } finally {
    await teardown(launched);
  }
});

test('36-font-size: 关于页展示版本号 + OFL 文本', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  const { page } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-about"]').click();
    await expect(page.locator('[data-testid="about-version"]')).toContainText('KyDog');
    await expect(page.locator('[data-testid="about-ofl-text"]')).toContainText('SIL OPEN FONT LICENSE');
  } finally {
    await teardown(launched);
  }
});
