import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown } from './helpers';
import { cancelPath } from './fixtures/oauth-mock';

test.skip('26-llm: OAuth login → cancel → state idle', async () => {
  const fixtureDir = path.join(__dirname, 'fixtures');
  mkdirSync(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, 'oauth-cancel.json');
  writeFileSync(fixturePath, JSON.stringify(cancelPath));
  const launched = await launchKydog({});
  const { page } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.getByText('设置', { exact: false }).click();
    await page.getByText('模型与提供商').click();
    await page.getByText('+ 添加 provider').click();
    await page.getByText('Claude Pro/Max').click();
    await page.getByText('登录', { exact: true }).click();
    await expect(page.locator('text=/复制链接/')).toBeVisible();
    await page.getByText('取消').click();
    await expect(page.getByText('登录', { exact: true })).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
