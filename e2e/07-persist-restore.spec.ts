import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { _electron as electron } from '@playwright/test';
import { seedSettings, seedProject, seedSamplePackage } from './helpers';

test('07-persist: thread + ui state survive restart', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-home-'));
  await seedSettings(home);
  await seedProject(home, projectPath, [{ id: 'aaaaaaaa-1111-1111-1111-111111111111', title: 'kept' }]);

  const env = { ...process.env, HOME: home, USERPROFILE: home, KYDOG_LOG: 'warn' as string, KYDOG_E2E: '1' };

  // 第一次启动：切主题
  let app = await electron.launch({ args: ['.vite/build/main.js'], env, timeout: 20_000 });
  let page = await app.firstWindow();
  await expect(page.locator('[data-testid="thread-aaaaaaaa-1111-1111-1111-111111111111"]')).toBeVisible();
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="theme-midnight"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await page.waitForTimeout(300); // 给 settings.update 写盘
  await app.close();

  // 第二次启动：同 HOME，期望 thread + 主题持久化
  app = await electron.launch({ args: ['.vite/build/main.js'], env, timeout: 20_000 });
  page = await app.firstWindow();
  await expect(page.locator('[data-testid="thread-aaaaaaaa-1111-1111-1111-111111111111"]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await app.close();
});
