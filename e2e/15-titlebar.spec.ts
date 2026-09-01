import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('15-titlebar: defaults to KyDog and reflects selected thread title', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const threadId = 'bbbbbbbb-2222-2222-2222-222222222222';
  const threadTitle = 'phase3 titlebar thread';
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [{ id: threadId, title: threadTitle }]);
    },
  });
  try {
    const titleBar = launched.page.locator('[data-testid="title-bar"]');
    await expect(titleBar).toBeVisible();
    await expect(titleBar).toContainText('KyDog');

    await launched.page.getByTestId(`thread-${threadId}`).click();
    await expect(titleBar).toContainText(threadTitle);
  } finally {
    await teardown(launched);
  }
});
