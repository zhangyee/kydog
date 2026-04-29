import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('16-thinking-summary: thinking block is collapsed by default and expands on demand', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixture = path.resolve('e2e/fixtures/happy-path-thinking.json');

  const launched = await launchKydog({
    fixture,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  try {
    await launched.page.locator('[data-testid="new-thread"]').click();
    await launched.page.locator('[data-testid="input-pill"]').fill('summarize your reasoning');
    await launched.page.locator('[data-testid="send-button"]').click();
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('我先看了下目录', { timeout: 5000 });
    await expect(launched.page.locator('[data-testid="thinking-toggle"]')).toContainText('已思考');
    await expect(launched.page.locator('[data-testid="thinking-toggle"]')).toContainText('1s');
    await expect(launched.page.locator('[data-testid="thinking-toggle"]')).toContainText('展开');
    await expect(launched.page.locator('[data-testid="thinking-toggle"]')).not.toContainText('我先梳理一下文件结构');
    await expect(launched.page.locator('[data-testid="thinking-content"]')).toHaveCount(0);
    await launched.page.locator('[data-testid="thinking-toggle"]').click();
    await expect(launched.page.locator('[data-testid="thinking-content"]')).toContainText('我先梳理一下文件结构，再决定从哪里回答。');
  } finally {
    await teardown(launched);
  }
});
