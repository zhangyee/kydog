import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('14-tool-group: 三路 fastpaper 并行被识别为 ToolGroup，PARALLEL · 3 徽章 + 展开后看到三张 ToolCard', async () => {
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

    // 外层 ProcessGroup 跑完默认收起
    const pgToggle = launched.page.locator('[data-testid="process-toggle"]');
    await expect(pgToggle).toContainText('已处理', { timeout: 10000 });
    await expect(launched.page.locator('[data-testid="message-list"]')).not.toContainText('PARALLEL · 3');

    // 展开 ProcessGroup
    await pgToggle.click();

    // 看到 ToolGroup 的并行徽章 + 聚合标签 + 总状态
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('PARALLEL · 3', { timeout: 5000 });
    const tgToggle = launched.page.getByTestId('tool-group-toggle-tc-arxiv');
    await expect(tgToggle).toContainText('fastpaper ×3');
    await expect(tgToggle).toContainText('全部完成');

    // 此时 ToolGroup 默认收起，3 张内层 ToolCard 还不可见
    await expect(launched.page.getByTestId('tool-tc-arxiv')).toHaveCount(0);

    // 展开 ToolGroup
    await tgToggle.click();

    // 3 张 ToolCard 全部可见
    await expect(launched.page.getByTestId('tool-tc-arxiv')).toBeVisible({ timeout: 10000 });
    await expect(launched.page.getByTestId('tool-tc-s2')).toBeVisible({ timeout: 10000 });
    await expect(launched.page.getByTestId('tool-tc-pubmed')).toBeVisible({ timeout: 10000 });
  } finally {
    await teardown(launched);
  }
});
