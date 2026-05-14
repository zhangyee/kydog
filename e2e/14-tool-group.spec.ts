import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('14-tool-group: 并行 tool_calls 落在同一个 ProcessGroup 内，展开后 3 张 ToolCard 都可见', async () => {
  test.slow();
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixture = path.resolve('e2e/fixtures/happy-path-bash-parallel.json');

  const launched = await launchKydog({
    fixture,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  try {
    await launched.page.locator('[data-testid="new-thread"]').click();
    await launched.page.locator('[data-testid="composer-input"]').fill('parallel search');
    await launched.page.locator('[data-testid="send-button"]').click();
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('parallel search');

    // 等外层 ProcessGroup 出现并收起（一轮跑完后）
    const pgToggle = launched.page.locator('[data-testid="process-toggle"]');
    await expect(pgToggle).toContainText('已处理', { timeout: 10000 });

    // 收起时 3 个内层 ToolCard 都不可见
    await expect(launched.page.getByTestId('tool-tc-arxiv')).toHaveCount(0);

    // 点开外层
    await pgToggle.click();

    // 3 张 ToolCard 都出现
    await expect(launched.page.getByTestId('tool-tc-arxiv')).toBeVisible({ timeout: 15000 });
    await expect(launched.page.getByTestId('tool-tc-s2')).toBeVisible({ timeout: 15000 });
    await expect(launched.page.getByTestId('tool-tc-pubmed')).toBeVisible({ timeout: 15000 });
  } finally {
    await teardown(launched);
  }
});
