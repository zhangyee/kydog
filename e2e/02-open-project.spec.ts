import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('02-open-project: project shows in workspace tree', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);

  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath);
    },
  });
  try {
    await expect(launched.page.locator('[data-testid="projects-tree"]')).toContainText(path.basename(projectPath));
  } finally {
    await teardown(launched);
  }
});
