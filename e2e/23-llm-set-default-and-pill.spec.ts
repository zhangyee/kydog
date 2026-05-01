import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test.skip('23-llm: set default → InputPill shows provider · model', async () => {
  const launched = await launchKydog({ });
  const { page, kydogHome } = launched;
  try {
    await seedSettings(kydogHome, { providerConfigured: true });
    // user reloads / restarts to pick up seed; in real test, drive UI
    await expect(page.locator('text=/Anthropic · /')).toBeVisible({ timeout: 5000 });
  } finally {
    await teardown(launched);
  }
});
