import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('08-theme: vellum ↔ midnight toggles data-theme and accent rendering', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  try {
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', 'vellum');
    await launched.page.locator('[data-testid="user-menu-trigger"]').click();
    await launched.page.locator('[data-testid="theme-midnight"]').click();
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', 'midnight');
    await launched.page.locator('[data-testid="theme-vellum"]').click();
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', 'vellum');
  } finally {
    await teardown(launched);
  }
});
