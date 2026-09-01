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
    await launched.page.locator('[data-testid="composer-input"]').fill('list files');
    await launched.page.locator('[data-testid="send-button"]').click();
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('list files');
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('我来 ls 看看', { timeout: 5000 });

    // 本轮跑完后 ProcessGroup 会自己收起（open = manual ?? isRunning），process-content
    // 连同里面的工具卡一起从 DOM 里消失。原先直接断言 tool-t1，等于在"还在跑"的那一小段
    // 窗口里抢时间 —— fixture 整条时间线才 165ms，机器稍慢就抓空。这是这条长期间歇红的
    // 原因（在 main 上同样是 5 次里红 3 次），不是产品问题。
    // 改成：等它落定（aria-expanded=false 就是收起了），再手动展开，断言稳定态。
    const processToggle = launched.page.getByTestId('process-toggle');
    await expect(processToggle).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
    await processToggle.click();
    await expect(launched.page.getByTestId('process-content')).toBeVisible();

    // ToolCard 用 groupToolLabel：bash 调用显示命令头（这里 command="ls" → 显示 "ls"）
    await expect(launched.page.locator('[data-testid^="tool-t1"]')).toContainText('ls');
    await expect(launched.page.locator('[data-testid^="tool-t1"]')).toContainText('完成');
    await expect(launched.page.locator('[data-testid^="tool-t1"]')).not.toContainText('$ ls');
    await expect(launched.page.locator('[data-testid="tool-toggle-t1"]')).toContainText('展开');
    await expect(launched.page.locator('[data-testid^="tool-t1"]')).not.toContainText('README.md');
    await launched.page.locator('[data-testid="tool-toggle-t1"]').click();
    await expect(launched.page.locator('[data-testid^="tool-t1"]')).toContainText('$ ls');
    await expect(launched.page.locator('[data-testid^="tool-t1"]')).toContainText('README.md', { timeout: 5000 });
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('目录里有 README 和 src', { timeout: 5000 });
  } finally {
    await teardown(launched);
  }
});
