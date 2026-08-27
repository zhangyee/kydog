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

    // ui 持久化订阅是 fire-and-forget：关闭前反复读盘直到写入落地，避免竞态（对齐 34-thread-rename.spec.ts:29 的既有模式）。
    await expect.poll(async () => {
      const raw = await fs.readFile(path.join(kydogHome, '.kydog', 'kydog.json'), 'utf8');
      return JSON.parse(raw).ui;
    }).toMatchObject({ theme: 'midnight', locale: 'en' });
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

test('38-locale: 菜单里切到 en 后重启，选中态仍是 en（不是本地 state）', async () => {
  const first = await launchKydog({
    seed: async (home) => { await seedSettings(home, { locale: 'zh' }); },
  });
  const kydogHome = first.kydogHome;
  try {
    const { page } = first;
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="locale-en"]').click();
    await expect(page.locator('[data-testid="locale-en"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  } finally {
    await teardown(first);
  }

  const settings = JSON.parse(await fs.readFile(path.join(kydogHome, '.kydog', 'kydog.json'), 'utf8'));
  expect(settings.ui.locale).toBe('en');

  // 选中态读的是 settings store；本地 state 的写法在这里一定退回 zh。
  const second = await launchKydog({ kydogHome });
  try {
    await second.page.locator('[data-testid="user-menu-trigger"]').click();
    await expect(second.page.locator('[data-testid="locale-en"]')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await teardown(second);
  }
});
