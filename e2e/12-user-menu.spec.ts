import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('12-user-menu: opens with all sections; account CTA opens settings pane', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  const { page } = launched;
  try {
    // With provider configured, settings tab should NOT be auto-open at boot.
    await expect(page.locator('[data-testid="tab-__settings__"]')).toBeHidden();

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await expect(page.locator('[data-testid="user-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="locale-zh"]')).toBeVisible();
    await expect(page.locator('[data-testid="locale-en"]')).toBeVisible();
    await expect(page.locator('[data-testid="theme-vellum"]')).toBeVisible();
    await expect(page.locator('[data-testid="theme-lilac"]')).toBeVisible();
    await expect(page.locator('[data-testid="menu-donate"]')).toBeVisible();
    await expect(page.locator('[data-testid="menu-about"]')).toBeVisible();

    // Account CTA dispatches openSettings('provider') and closes the menu.
    await page.locator('[data-testid="open-settings"]').click();
    await expect(page.locator('[data-testid="user-menu"]')).toBeHidden();
    await expect(page.locator('[data-testid="tab-__settings__"]')).toBeVisible();
    await expect(page.locator('[data-testid="provider-name"]')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
