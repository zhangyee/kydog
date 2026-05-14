import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('03-create-thread: clicking 新建对话 selects new thread and shows EmptyState', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  try {
    await launched.page.locator('[data-testid="new-thread"]').click();
    await expect(launched.page.locator('[data-testid="chapter-frontier"]')).toBeVisible();
    await expect(launched.page.locator('[data-testid="composer-input"]')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
