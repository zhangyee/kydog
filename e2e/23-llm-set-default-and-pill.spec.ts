import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('23-llm: seeded provider + Composer label reflects default', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);

  const launched = await launchKydog({
    seed: async (h) => {
      await seedSettings(h);
      await seedProject(h, projectPath, [{ id: 't-23', title: '23-test' }]);
    },
  });
  const { page } = launched;
  try {
    // Provider configured → settings tab not auto-opened.
    await expect(page.locator('[data-testid="tab-__settings__"]')).toBeHidden();

    // Click the seeded thread to surface the Composer.
    await page.getByText('23-test').first().click();

    // Composer shows "Anthropic · claude-sonnet-4-5".
    await expect(page.locator('text=/Anthropic · claude-sonnet-4-5/')).toBeVisible({ timeout: 5000 });
  } finally {
    await teardown(launched);
  }
});
