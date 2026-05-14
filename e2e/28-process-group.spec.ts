import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('28-process-group: thinking 跑完后外层 ProcessGroup 收起，点击展开后内层 ThinkingBlock 仍可独立折叠', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixture = path.resolve('e2e/fixtures/happy-path-thinking.json');

  const launched = await launchKydog({
    fixture,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  try {
    await launched.page.locator('[data-testid="new-thread"]').click();
    await launched.page.locator('[data-testid="composer-input"]').fill('summarize your reasoning');
    await launched.page.locator('[data-testid="send-button"]').click();

    // 等到本轮的最终 text 出现 → 跑完了
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('我先看了下目录', { timeout: 5000 });

    // 外层 ProcessGroup 默认收起：toggle 显示「已处理」+「展开」
    const pgToggle = launched.page.locator('[data-testid="process-toggle"]');
    await expect(pgToggle).toContainText('已处理');
    await expect(pgToggle).toContainText('展开');

    // 内层 ThinkingBlock 此时还在 DOM 里吗？因为外层收起，内层不可见
    await expect(launched.page.locator('[data-testid="thinking-toggle"]')).toHaveCount(0);

    // 点击外层 toggle 展开
    await pgToggle.click();
    await expect(pgToggle).toContainText('收起');

    // 内层 ThinkingBlock 出现，自己仍是收起态
    const thToggle = launched.page.locator('[data-testid="thinking-toggle"]');
    await expect(thToggle).toContainText('已思考');
    await expect(thToggle).toContainText('展开');
    await expect(launched.page.locator('[data-testid="thinking-content"]')).toHaveCount(0);

    // 点击内层 toggle 展开
    await thToggle.click();
    await expect(launched.page.locator('[data-testid="thinking-content"]')).toContainText('我先梳理一下文件结构');
  } finally {
    await teardown(launched);
  }
});
