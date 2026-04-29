import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('14-tool-group: three concurrent tool_calls render as a ToolGroup with PARALLEL · 3', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixture = path.resolve('e2e/fixtures/happy-path-bash-parallel.json');

  const launched = await launchKydog({
    fixture,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  try {
    await launched.page.locator('[data-testid="new-thread"]').click();
    await launched.page.locator('[data-testid="input-pill"]').fill('parallel search');
    await launched.page.locator('[data-testid="send-button"]').click();
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('parallel search');
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('PARALLEL · 3', { timeout: 5000 });
    await expect(launched.page.getByTestId('tool-tc-arxiv')).toBeVisible();
    await expect(launched.page.getByTestId('tool-tc-s2')).toBeVisible();
    await expect(launched.page.getByTestId('tool-tc-pubmed')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
