import { test, expect } from '@playwright/test';
import { launchKydog, teardown } from './helpers';

test.skip('22-llm: add Anthropic key shows entry + InputPill reflects', async () => {
  const launched = await launchKydog({ });
  const { page } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.getByText('设置', { exact: false }).click();
    await page.getByText('模型与提供商').click();
    await page.getByText('+ 添加 provider').click();
    await page.getByText('Anthropic', { exact: true }).click();
    await page.locator('input[type="password"]').first().fill('sk-test');
    await page.getByText('保存', { exact: true }).click();
    await page.getByText('‹ 返回').click();
    await expect(page.getByText('Anthropic')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
