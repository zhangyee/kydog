import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('29-auto-scroll: 贴底跟随 + free-read 保持 + 新 text block override 跳底', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixture = path.resolve('e2e/fixtures/auto-scroll.json');

  const launched = await launchKydog({
    fixture,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  try {
    const page = launched.page;
    const msgList = page.locator('[data-testid="message-list"]');

    await page.locator('[data-testid="new-thread"]').click();
    await page.locator('[data-testid="composer-input"]').fill('test');
    await page.locator('[data-testid="send-button"]').click();

    // 等 PHASE1 全部落地（PHASE1_END 出现）
    await expect(msgList).toContainText('PHASE1_END', { timeout: 5000 });

    // 程序滚到顶（模拟用户翻回去）。这会触发 onScroll → stickyRef = false
    await msgList.evaluate((el) => { el.scrollTop = 0; });

    // tool 阶段：ProcessGroup 在运行时自动展开（open = isRunning = true），
    // process-toggle 显示"处理中..."。等它出现说明 tool 正在跑。
    // tool chunk 本身在 ToolCard 里默认收起，不在 DOM 文本里，
    // 但 process-toggle 文本"处理中"是可测量的稳定信号。
    await expect(page.locator('[data-testid="process-toggle"]')).toContainText('处理中', { timeout: 5000 });

    // 此时容器内容正在长大，若 hook 行为正确 scrollTop 仍应是 0
    const scrollDuringTool = await msgList.evaluate((el) => el.scrollTop);
    expect(scrollDuringTool).toBe(0);

    // 等 PHASE2_TEXT 出现（新 kind:'text' block 落地）→ override 应跳底
    await expect(msgList).toContainText('PHASE2_TEXT', { timeout: 10000 });
    // 给 React effect 一拍时间把 scrollTop 设到 scrollHeight
    await page.waitForTimeout(50);
    const distance = await msgList.evaluate(
      (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
    );
    expect(distance).toBeLessThan(64);
  } finally {
    await teardown(launched);
  }
});
