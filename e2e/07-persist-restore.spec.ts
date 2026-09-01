import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, seedSettings, seedProject, seedSamplePackage, teardown } from './helpers';

const THREAD_ID = 'aaaaaaaa-1111-1111-1111-111111111111';

/**
 * 走 launchKydog 而不是自己 electron.launch：它会给每次启动配一个独立的
 * `--user-data-dir`。**不隔离就会撞上开发者本机那份真实 profile**
 * （Windows 上 userData 取自 APPDATA，跟这里改的 HOME 无关），本机开着 KyDog 时
 * 这条就直接 "Process failed to launch" —— 看起来像持久化坏了，其实是profile 被占。
 * 全套 e2e 里只有这一条曾经漏了这个隔离。
 */
test('07-persist: thread + ui state survive restart', async () => {
  let projectPath = '';

  const l1 = await launchKydog({
    seed: async (home) => {
      projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
      await seedSamplePackage(projectPath);
      await seedSettings(home);
      await seedProject(home, projectPath, [{ id: THREAD_ID, title: 'kept' }]);
    },
  });
  const home = l1.kydogHome;
  try {
    // 第一次启动：切主题
    await expect(l1.page.getByTestId(`thread-${THREAD_ID}`)).toBeVisible();
    await l1.page.getByTestId('user-menu-trigger').click();
    await l1.page.getByTestId('theme-midnight').click();
    await expect(l1.page.locator('html')).toHaveAttribute('data-theme', 'midnight');
    await l1.page.waitForTimeout(300); // 给 settings.update 写盘
  } finally {
    await teardown(l1);
  }

  // 第二次启动：同 HOME，期望 thread + 主题持久化
  const l2 = await launchKydog({ kydogHome: home });
  try {
    await expect(l2.page.getByTestId(`thread-${THREAD_ID}`)).toBeVisible();
    await expect(l2.page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  } finally {
    await teardown(l2);
  }
});
