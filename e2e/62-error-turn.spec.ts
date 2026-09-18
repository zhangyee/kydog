import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

/**
 * 一轮在模型输出任何内容之前就以错误结束（2026-09-14 修的 bug；实测来源是 DeepSeek 回
 * 402 余额不足）。
 *
 * 以前界面上只剩面包屑一个「错误」小红点，错误原文哪里都看不到：它挂在「助手回复」组件
 * 里，而这一轮根本没有回复。这条钉住用户真正要看的那件事 —— **原文在对话里看得见**。
 *
 * **只测实时这一半。** 重启 / 重载之后仍看得见的那一半钉在
 * `src/main/agent/messageNormalizer.test.ts`：fixture session 不维护 transcript
 * （`state.messages` 恒为空），重载后没有东西可归一化，那一半在 e2e 里没法如实复现。
 */
test('62-error-turn: 模型一个字没输出就失败时，错误原文显示在对话里', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixture = path.resolve('e2e/fixtures/error-before-output.json');
  const TID = '00000000-0000-0000-0000-0000000000e1';

  const launched = await launchKydog({
    fixture,
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [{ id: TID, title: 'Error Turn' }]);
    },
  });
  try {
    const { page } = launched;
    await page.locator(`[data-testid="thread-${TID}"]`).click();
    await page.locator('[data-testid="composer-input"]').fill('hello');
    await page.locator('[data-testid="send-button"]').click();

    const list = page.locator('[data-testid="message-list"]');
    // 先证明查找本身找得到这一块（用户那条消息在），下面那条才是在断错误原文。
    await expect(list).toContainText('hello');
    await expect(list).toContainText('402: Insufficient Balance (fixture)');
    await expect(page.getByTestId('run-status-error')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
