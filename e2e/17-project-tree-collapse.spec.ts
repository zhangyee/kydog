import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('17-project-tree-collapse: selected thread project still toggles closed', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const threadId = 'aaaaaaaa-1111-1111-1111-111111111111';
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [{ id: threadId, title: 'kept' }]);
    },
  });

  try {
    const threadRow = launched.page.locator(`[data-testid="thread-${threadId}"]`);
    const projectToggle = launched.page.locator(`[data-testid="project-toggle-${path.basename(projectPath)}"]`);

    await threadRow.click();
    await projectToggle.click();
    await expect(threadRow).toHaveCount(0);

    await projectToggle.click();
    await expect(launched.page.locator(`[data-testid="thread-${threadId}"]`)).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
