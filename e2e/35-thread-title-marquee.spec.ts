import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

const LONG_ID = 'eeeeeeee-3333-3333-3333-333333333333';
const SHORT_ID = 'ffffffff-4444-4444-4444-444444444444';
const LONG_TITLE = '会议纪要：关于下一阶段科研数据管线与多智能体协作流程的详细讨论与后续待办梳理';

test('35-marquee: 长标题 hover 滚动，短标题不滚，离开复位', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-mq-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [
        { id: LONG_ID, title: LONG_TITLE },
        { id: SHORT_ID, title: '短' },
      ]);
    },
  });
  const { page } = launched;
  try {
    const longRow = page.locator(`[data-testid="thread-${LONG_ID}"]`);
    const longScroll = page.locator(`[data-testid="thread-title-scroll-${LONG_ID}"]`);
    const shortScroll = page.locator(`[data-testid="thread-title-scroll-${SHORT_ID}"]`);

    await expect(longRow).toBeVisible();

    // 1) hover 长标题 → 内层 transform 变成负向 translateX（滚动）
    await longRow.hover();
    await expect.poll(async () => {
      if (await longScroll.count() === 0) return '';
      return await longScroll.evaluate((el) => (el as HTMLElement).style.transform);
    }).toMatch(/translateX\(-\d/);

    // 2) 移到短标题行：长标题复位（滚动节点消失），短标题始终不滚
    await page.locator(`[data-testid="thread-${SHORT_ID}"]`).hover();
    await expect(longScroll).toHaveCount(0);
    await page.waitForTimeout(450); // 过起始延迟，确认短标题不会出现滚动节点
    await expect(shortScroll).toHaveCount(0);
  } finally {
    await teardown(launched);
    await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
  }
});
