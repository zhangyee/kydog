import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage, type LaunchedApp } from './helpers';

const fixture = path.resolve('e2e/fixtures/ask-user-question.json');

async function launchWithProject(): Promise<LaunchedApp> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  return launchKydog({
    fixture,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
}

/** 新建 thread、发一句，等到提问态 composer 出现。 */
async function askUntilPending(page: Page) {
  await page.locator('[data-testid="new-thread"]').click();
  await page.locator('[data-testid="composer-input"]').fill('帮我定几件事');
  await page.locator('[data-testid="send-button"]').click();
  await expect(page.locator('[data-testid="question-composer"]')).toBeVisible({ timeout: 10_000 });
}

test('40-ask: 逐题作答后提交，留痕卡片记下答案', async () => {
  const launched = await launchWithProject();
  const page = launched.page;
  try {
    await askUntilPending(page);
    const composer = page.locator('[data-testid="question-composer"]');

    // 整体替换而非叠加：提问期间不存在第二条输入路径。
    await expect(page.locator('[data-testid="composer-input"]')).toHaveCount(0);
    await expect(composer).toContainText('这次改动落在哪个分支上？');
    await expect(composer).toContainText('1 / 3');
    await expect(page.locator('[data-testid="ask-option-q0o0"]')).toContainText('推荐');

    // 单选：点中即前进。
    await page.locator('[data-testid="ask-option-q0o0"]').click();
    await expect(composer).toContainText('2 / 3');
    await expect(composer).toContainText('需要跑哪些验证？');

    // 多选：勾两项都停在原地。
    await page.locator('[data-testid="ask-option-q1o0"]').click();
    await page.locator('[data-testid="ask-option-q1o1"]').click();
    await expect(page.locator('[data-testid="ask-option-q1o0"]')).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('[data-testid="ask-option-q1o1"]')).toHaveAttribute('data-selected', 'true');
    await expect(composer).toContainText('2 / 3');

    // 自定义行的选中只由文本非空驱动。
    const customRow = page.locator('[data-testid="ask-custom-row"]');
    await expect(customRow).toHaveAttribute('data-selected', 'false');
    await page.locator('[data-testid="ask-custom-input"]').fill('再跑一遍 e2e');
    await expect(customRow).toHaveAttribute('data-selected', 'true');
    await expect(composer).toContainText('2 / 3');

    // 第三题跳过 —— 全部题都有终态后主按钮才写「提交」。
    await page.locator('[data-testid="ask-next"]').click();
    await expect(composer).toContainText('3 / 3');
    await expect(page.locator('[data-testid="ask-submit"]')).toHaveText('下一题');
    await page.locator('[data-testid="ask-skip"]').click();
    await expect(page.locator('[data-testid="ask-submit"]')).toHaveText('提交');
    await page.locator('[data-testid="ask-submit"]').click();

    const recap = page.locator('[data-testid="ask-recap"]');
    await expect(recap).toHaveAttribute('data-status', 'answered', { timeout: 10_000 });
    await expect(recap).toContainText('询问了 分支、验证、交付');
    await expect(recap).toContainText('当前 worktree');
    await expect(recap).toContainText('tsc、vitest；再跑一遍 e2e');
    await expect(recap).toContainText('（跳过）');

    // composer 形态恢复。
    await expect(page.locator('[data-testid="question-composer"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="composer-input"]')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});

test('40-ask: 关闭提问后 composer 恢复，留痕卡片记为取消', async () => {
  const launched = await launchWithProject();
  const page = launched.page;
  try {
    await askUntilPending(page);
    await expect(page.locator('[data-testid="composer-input"]')).toHaveCount(0);

    await page.locator('[data-testid="ask-close"]').click();

    await expect(page.locator('[data-testid="question-composer"]')).toHaveCount(0);
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();
    await input.fill('那我自己定');
    await expect(input).toHaveText('那我自己定');

    const recap = page.locator('[data-testid="ask-recap"]');
    await expect(recap).toHaveAttribute('data-status', 'cancelled', { timeout: 10_000 });
    await expect(recap).toContainText('你关闭了这次提问，未作回答。');
    await expect(recap).toContainText('这次改动落在哪个分支上？');
  } finally {
    await teardown(launched);
  }
});
