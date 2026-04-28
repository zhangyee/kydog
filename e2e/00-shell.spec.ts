import { test, expect } from '@playwright/test';
import { launchKydog, teardown } from './helpers';

test('00-shell: app boots; three panes render; theme applies; settings modal force-opens', async () => {
  const launched = await launchKydog();
  const { page } = launched;
  try {
    await expect(page.locator('[data-pane="workspace"]')).toBeVisible();
    await expect(page.locator('[data-pane="main"]')).toBeVisible();
    await expect(page.locator('[data-pane="inspector"]')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'vellum');
    await expect(page.locator('[data-testid="settings-modal"]')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
