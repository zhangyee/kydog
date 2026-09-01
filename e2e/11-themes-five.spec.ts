import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('11-themes: five themes switch via UserMenu and toggle data-theme', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  try {
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme', 'vellum');
    await launched.page.locator('[data-testid="user-menu-trigger"]').click();
    for (const name of ['vellum', 'porcelain', 'sepia', 'midnight', 'lilac'] as const) {
      await launched.page.getByTestId(`theme-${name}`).click();
      await expect(launched.page.locator('html')).toHaveAttribute('data-theme', name);
    }
  } finally {
    await teardown(launched);
  }
});
