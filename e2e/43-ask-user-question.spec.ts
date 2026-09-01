import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage, type LaunchedApp } from './helpers';

const fixture = path.resolve('e2e/fixtures/ask-user-question.json');
// 这一轮直接发 ask，前面没有任何 text / thinking —— 于是渲染进程没收到过 delta 事件。
const noPreambleFixture = path.resolve('e2e/fixtures/ask-no-preamble.json');
// 单题 8 个选项：锁住「选项上限为什么是 8」的推导——数字键 1..8 选项，第 9 位留给「其他」。
const eightOptionsFixture = path.resolve('e2e/fixtures/ask-eight-options.json');

async function launchWithProject(fixturePath = fixture): Promise<LaunchedApp> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  return launchKydog({
    fixture: fixturePath,
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

test('43-ask: 逐题作答后提交，留痕卡片记下答案', async () => {
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
    await expect(recap).toContainText('询问了 3 个问题，跳过 1 题');
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

// 键盘规格是刻意设计过的：三条快捷键都只在焦点不在输入框时生效，且这一版
// 不做任何 Enter 提交/前进 —— 用户正在框里写想法时一个回车就跳走太危险。
test('43-ask: 提问态的键盘快捷键只在输入框外生效，Enter 不提交', async () => {
  const launched = await launchWithProject();
  const page = launched.page;
  try {
    await askUntilPending(page);
    const composer = page.locator('[data-testid="question-composer"]');
    const customRow = page.locator('[data-testid="ask-custom-row"]');
    const customInput = page.locator('[data-testid="ask-custom-input"]');

    // 1) 数字键选中并前进：单选按 1 等同点第一项，选中即前进。
    await composer.focus();
    await expect(composer).toContainText('1 / 3');
    await page.keyboard.press('1');
    await expect(composer).toContainText('2 / 3');
    // 前进后第 1 题已经不在 DOM 里，翻回去才看得到那一下确实选中了。
    await page.locator('[data-testid="ask-prev"]').click();
    await expect(composer).toContainText('1 / 3');
    await expect(page.locator('[data-testid="ask-option-q0o0"]')).toHaveAttribute('data-selected', 'true');
    await page.locator('[data-testid="ask-next"]').click();
    await expect(composer).toContainText('2 / 3');

    // 2) n+1 是把光标送进自定义输入框，不是选中 —— 选中只由文本非空驱动。
    await composer.focus();
    await page.keyboard.press('3');
    await expect(customInput).toBeFocused();
    await expect(customRow).toHaveAttribute('data-selected', 'false');

    // 3) 焦点在框里时数字键就是打字，不会顺手选中选项、也不翻页。
    await page.keyboard.type('12');
    await expect(customInput).toHaveValue('12');
    await expect(page.locator('[data-testid="ask-option-q1o0"]')).toHaveAttribute('data-selected', 'false');
    await expect(page.locator('[data-testid="ask-option-q1o1"]')).toHaveAttribute('data-selected', 'false');
    await expect(composer).toContainText('2 / 3');

    // 4) 焦点在框里时 ← 是移光标，不翻页。
    await page.keyboard.press('ArrowLeft');
    await expect(composer).toContainText('2 / 3');

    // 5) Enter 不做任何事：不提交、不前进，提问态原地不动。框内框外都一样 ——
    //    这一版根本没有 Enter 通路，前进和提交只走底部的显式按钮。
    await page.keyboard.press('Enter');
    await expect(composer).toContainText('2 / 3');
    await expect(composer).toHaveCount(1);
    await expect(page.locator('[data-testid="composer-input"]')).toHaveCount(0);
    await expect(customInput).toHaveValue('12');
    await composer.focus();
    await page.keyboard.press('Enter');
    await expect(composer).toContainText('2 / 3');
    await expect(composer).toHaveCount(1);
    await expect(page.locator('[data-testid="composer-input"]')).toHaveCount(0);

    // 6) 焦点离开输入框后 ←→ 才翻页。
    await expect(customInput).not.toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(composer).toContainText('3 / 3');
    await page.keyboard.press('ArrowLeft');
    await expect(composer).toContainText('2 / 3');

    // 7) Esc 等同 ×：结束提问，composer 形态恢复，留痕记为取消。
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="question-composer"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="composer-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="ask-recap"]')).toHaveAttribute('data-status', 'cancelled', { timeout: 10_000 });
  } finally {
    await teardown(launched);
  }
});

test('43-ask: 关闭提问后 composer 恢复，留痕卡片记为取消', async () => {
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

// 留痕 buffer 只由 text / thinking 的 delta 事件创建，模型这一轮完全可以不写开场白
// 直接发 ask。取消路径最险：terminate 让 loop 早停、第二轮永不到来，buffer 至始至终
// 不存在，整轮在消息流里就什么都不剩了 —— 而重启走历史路径又能还原出来。
test('43-ask: 这一轮没有开场白直接提问，取消后照样留下卡片', async () => {
  const launched = await launchWithProject(noPreambleFixture);
  const page = launched.page;
  try {
    await askUntilPending(page);
    const composer = page.locator('[data-testid="question-composer"]');
    await expect(composer).toContainText('这次改动落在哪个分支上？');

    await page.locator('[data-testid="ask-close"]').click();

    const recap = page.locator('[data-testid="ask-recap"]');
    await expect(recap).toHaveAttribute('data-status', 'cancelled', { timeout: 10_000 });
    await expect(recap).toContainText('这次改动落在哪个分支上？');
  } finally {
    await teardown(launched);
  }
});

// 锁住「为什么选项上限是 8」这条推导：QuestionComposer 的数字键用 1..N 选选项，
// 第 N+1 个数字留给「其他」。8 个选项时「其他」正好是 9，仍在单键范围内——
// 这条测试直接按下 8 和 9，断言的是这个机制真的按预期工作，不只是渲染出了 8 项。
test('43-ask: 8 个选项全部渲染，数字键 8 选中第 8 项、9 聚焦「其他」输入框', async () => {
  const launched = await launchWithProject(eightOptionsFixture);
  const page = launched.page;
  try {
    await askUntilPending(page);
    const composer = page.locator('[data-testid="question-composer"]');
    const customInput = page.locator('[data-testid="ask-custom-input"]');
    await expect(composer).toContainText('这次改动最像下面哪一种？');

    // 8 个选项全部渲染出来。
    for (let i = 0; i < 8; i += 1) {
      await expect(page.getByTestId(`ask-option-q0o${i}`)).toBeVisible();
    }

    // 数字键 8 选中第 8 项（q0o7），不是别的项。
    await composer.focus();
    await page.keyboard.press('8');
    await expect(page.locator('[data-testid="ask-option-q0o7"]')).toHaveAttribute('data-selected', 'true');
    for (let i = 0; i < 7; i += 1) {
      await expect(page.getByTestId(`ask-option-q0o${i}`)).toHaveAttribute('data-selected', 'false');
    }

    // 数字键 9 聚焦「其他」输入框，不选中任何选项——第 9 位不是第 9 个选项。
    await composer.focus();
    await page.keyboard.press('9');
    await expect(customInput).toBeFocused();
    await expect(page.locator('[data-testid="ask-option-q0o7"]')).toHaveAttribute('data-selected', 'true');
  } finally {
    await teardown(launched);
  }
});
