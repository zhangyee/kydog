import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('12-user-menu: opens with all sections; account CTA opens settings', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  try {
    await launched.page.locator('[data-testid="user-menu-trigger"]').click();
    await expect(launched.page.locator('[data-testid="user-menu"]')).toBeVisible();
    await expect(launched.page.locator('[data-testid="locale-zh"]')).toBeVisible();
    await expect(launched.page.locator('[data-testid="locale-en"]')).toBeVisible();
    await expect(launched.page.locator('[data-testid="theme-vellum"]')).toBeVisible();
    await expect(launched.page.locator('[data-testid="theme-lilac"]')).toBeVisible();
    await expect(launched.page.locator('[data-testid="menu-donate"]')).toBeVisible();
    await expect(launched.page.locator('[data-testid="menu-about"]')).toBeVisible();

    await launched.page.locator('[data-testid="open-settings"]').click();
    await expect(launched.page.locator('[data-testid="settings-modal"]')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
