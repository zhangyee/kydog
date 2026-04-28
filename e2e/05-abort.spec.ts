import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('05-abort: Stop button transitions run state to idle and stops events', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixture = path.resolve('e2e/fixtures/abort.json');

  const launched = await launchKydog({
    fixture,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  try {
    await launched.page.locator('[data-testid="new-thread"]').click();
    await launched.page.locator('[data-testid="input-pill"]').fill('think long');
    await launched.page.locator('[data-testid="send-button"]').click();
    await expect(launched.page.locator('[data-testid="stop-button"]')).toBeVisible({ timeout: 2000 });
    await launched.page.locator('[data-testid="stop-button"]').click();
    await expect(launched.page.locator('[data-testid="send-button"]')).toBeVisible({ timeout: 5000 });
    await expect(launched.page.locator('[data-testid="message-list"]')).not.toContainText('应该已经被中断');
  } finally {
    await teardown(launched);
  }
});
