import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('22-llm: add Anthropic key shows entry in list', async () => {
  const launched = await launchKydog({ seed: (home) => seedSettings(home, { providerConfigured: false }) });
  const { page } = launched;
  try {
    // First-run: settings tab auto-opens, list is empty.
    await expect(page.getByText('还未配置任何 provider')).toBeVisible();

    // Add → AddProviderPage push.
    await page.getByRole('button', { name: '+ 添加 provider' }).click();
    await expect(page.getByRole('button', { name: '‹ 返回' })).toBeVisible();

    // Pick Anthropic → ProviderDetailPane (ApiKeyForm + OAuth login section).
    await page.getByText('Anthropic', { exact: true }).click();

    // Fill key, save.
    await page.locator('input[type="password"]').first().fill('sk-ant-test');
    await page.getByRole('button', { name: '保存' }).click();
    await page.waitForTimeout(500);

    // Back to list: row visible.
    await page.getByRole('button', { name: '‹ 返回' }).click();
    await expect(page.getByText('Anthropic').first()).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
