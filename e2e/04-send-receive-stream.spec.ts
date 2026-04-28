import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('04-send: fixture LLM streams text + bash tool card', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixture = path.resolve('e2e/fixtures/happy-path-bash.json');

  const launched = await launchKydog({
    fixture,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  try {
    await launched.page.locator('[data-testid="new-thread"]').click();
    await launched.page.locator('[data-testid="input-pill"]').fill('list files');
    await launched.page.locator('[data-testid="send-button"]').click();
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('list files');
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('我来 ls 看看', { timeout: 5000 });
    await expect(launched.page.locator('[data-testid^="tool-t1"]')).toContainText('$ ls');
    await expect(launched.page.locator('[data-testid^="tool-t1"]')).toContainText('README.md', { timeout: 5000 });
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('目录里有 README 和 src', { timeout: 5000 });
  } finally {
    await teardown(launched);
  }
});
