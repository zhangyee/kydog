import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown, seedSettings } from './helpers';

test('38-locale: en 用户改主题后重启 locale 仍为 en（回归 bootstrap 硬编码）', async () => {
  const first = await launchKydog({
    freshHome: true,
    seed: async (home) => { await seedSettings(home, { locale: 'en' }); },
  });
  const kydogHome = first.kydogHome;
  try {
    const { page } = first;
    // 切主题入口对齐 08-theme-switch.spec.ts 现行写法，触发 ui 持久化订阅。
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="theme-midnight"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  } finally {
    await teardown(first);
  }

  const settings = JSON.parse(await fs.readFile(path.join(kydogHome, '.kydog', 'kydog.json'), 'utf8'));
  expect(settings.ui.locale).toBe('en');        // 未被写回 zh
  expect(settings.ui.theme).toBe('midnight');

  const second = await launchKydog({ kydogHome });
  try {
    await expect(second.page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  } finally {
    await teardown(second);
  }
});
