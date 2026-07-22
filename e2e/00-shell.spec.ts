import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('00-shell: app boots; three panes render; theme applies; settings pane force-opens on first run', async () => {
  // onboarding 已完成、但未配置 provider 的"首次真实使用"态：settings 面板强制打开。
  const launched = await launchKydog({ seed: (home) => seedSettings(home, { providerConfigured: false }) });
  const { page } = launched;
  try {
    await expect(page.locator('[data-pane="workspace"]')).toBeVisible();
    await expect(page.locator('[data-pane="main"]')).toBeVisible();
    await expect(page.locator('[data-pane="inspector"]')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'vellum');
    // First run (no kydog.json): bootstrap auto-opens the settings tab on the
    // provider page so the user can configure a provider before doing anything.
    await expect(page.locator('[data-testid="tab-__settings__"]')).toBeVisible();
    await expect(page.getByText('还未配置任何 provider')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
