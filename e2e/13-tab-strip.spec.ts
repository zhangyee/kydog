import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('13-tab-strip: thread tab renders, breadcrumb stats visible, close deselects to Welcome', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const threadId = 'cccccccc-3333-3333-3333-333333333333';
  const threadTitle = 'phase5 tabstrip thread';
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [{ id: threadId, title: threadTitle }]);
    },
  });
  try {
    const page = launched.page;

    // Select the seeded thread from the projects tree.
    await page.locator(`[data-testid="thread-${threadId}"]`).click();

    // TabStrip + Breadcrumb visible.
    await expect(page.locator(`[data-testid="tab-${threadId}"]`)).toBeVisible();
    await expect(page.locator('[data-testid="thread-stats"]')).toBeVisible();

    // Close tab → main pane returns to Welcome.
    await page.locator(`[data-testid="tab-close-${threadId}"]`).click();
    await expect(page.locator(`[data-testid="tab-${threadId}"]`)).toHaveCount(0);
    await expect(page.getByText('Building a better world.')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
