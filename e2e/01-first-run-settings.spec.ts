import { test, expect } from '@playwright/test';
import { launchKydog, teardown } from './helpers';

test('01-first-run: provider form saves and modal closes', async () => {
  const launched = await launchKydog();
  const { page } = launched;
  try {
    await page.locator('[data-testid="provider-name"]').fill('DeepSeek');
    await page.locator('[data-testid="provider-baseurl"]').fill('https://api.deepseek.com/v1');
    await page.locator('[data-testid="provider-apikey"]').fill('sk-test-fake');
    await page.locator('[data-testid="provider-model"]').fill('deepseek-chat');
    await page.locator('[data-testid="settings-save"]').click();
    await expect(page.locator('[data-testid="settings-modal"]')).toBeHidden();
  } finally {
    await teardown(launched);
  }
});
