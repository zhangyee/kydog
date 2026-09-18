import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage, type LaunchedApp } from './helpers';
import type { FixtureEvent, FixtureFile } from './fixtures/fixture.types';

const fixtureFile = (name: string) => path.resolve('e2e/fixtures', name);
// 单题 4 个选项，每条说明都长到要换两三行（schema 不限 description 长度，模型真会这么写）。
const longDescriptionsFixture = fixtureFile('ask-long-descriptions.json');

/**
 * 提问卡：作答提交、真按键取消、长说明的行高。键位映射（数字键、Enter 不提交、8 个选项）
 * 由 QuestionComposer.test 守，没有开场白直接提问的留痕由 runEvents.reload.test 守。
 * 串行共用一次启动：fixture 用 `scripts` 形状，
 * 每条新建一个 thread、发各自的剧本名（剧本内容照搬原来那几份单剧本 fixture）。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let projectPath = '';

test.beforeAll(async () => {
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const eventsOf = async (name: string): Promise<FixtureEvent[]> =>
    (JSON.parse(await fs.readFile(fixtureFile(name), 'utf8')) as { events: FixtureEvent[] }).events;
  const scripts: FixtureFile = {
    scripts: {
      ask: await eventsOf('ask-user-question.json'),
      'ask long': await eventsOf('ask-long-descriptions.json'),
    },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-fx-'));
  const fixture = path.join(dir, 'ask.json');
  await fs.writeFile(fixture, JSON.stringify(scripts));
  launched = await launchKydog({
    fixture,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
});

test.afterAll(async () => {
  await teardown(launched);
  await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
});

/** 新建 thread、发这一条的剧本名，等到提问态 composer 出现。 */
async function askUntilPending(page: Page, script: string) {
  await page.locator('[data-testid="new-thread"]').click();
  await page.locator('[data-testid="composer-input"]').fill(script);
  await page.locator('[data-testid="send-button"]').click();
  await expect(page.locator('[data-testid="question-composer"]')).toBeVisible({ timeout: 10_000 });
}

test('43-ask: 逐题作答后提交，留痕卡片记下答案', async () => {
  const { page } = launched;
  await askUntilPending(page, 'ask');
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
});

test('43-ask: Esc 关闭提问后 composer 恢复，留痕卡片记为取消', async () => {
  const { page } = launched;
  await askUntilPending(page, 'ask');
  await expect(page.locator('[data-testid="composer-input"]')).toHaveCount(0);

  // 用真按键关（× 与 Esc 走同一个取消处理，键位映射由 QuestionComposer.test 守），
  // 让 e2e 里保留一条真按键到提问卡的路径。
  await page.locator('[data-testid="question-composer"]').focus();
  await page.keyboard.press('Escape');

  await expect(page.locator('[data-testid="question-composer"]')).toHaveCount(0);
  const input = page.locator('[data-testid="composer-input"]');
  await expect(input).toBeVisible();
  await input.fill('那我自己定');
  await expect(input).toHaveText('那我自己定');

  const recap = page.locator('[data-testid="ask-recap"]');
  await expect(recap).toHaveAttribute('data-status', 'cancelled', { timeout: 10_000 });
  await expect(recap).toContainText('你关闭了这次提问，未作回答。');
  await expect(recap).toContainText('这次改动落在哪个分支上？');
});

// 选项说明长到要换行时，这一行必须跟着长高。2026-09-17 第一组验收实测：行高写死 32px，
// 多行说明以行中线为轴上下溢出，压到相邻选项上，整张卡片的字叠成一团。
//
// 判据是几何，不是「元素存在」：说明整块落在自己那一行的框里，且行与行不重叠。
// 这两条在说明**没有换行**时恒成立 —— 所以同一条用例里先证明它真的换成了多行，
// 夹具哪天被改短、窗口哪天变宽，这条会红在前提上，而不是空转着绿。
test('43-ask: 选项说明换成多行时行跟着长高，不压到相邻选项', async () => {
  const { page } = launched;
  await askUntilPending(page, 'ask long');
  const spec = JSON.parse(await fs.readFile(longDescriptionsFixture, 'utf8')) as {
    events: Array<{ type: string; questions?: Array<{ options: Array<{ description: string }> }> }>;
  };
  const options = spec.events.find((e) => e.type === 'ask')!.questions![0].options;

  const rowBoxes: Array<{ y: number; height: number }> = [];
  for (let i = 0; i < options.length; i += 1) {
    const row = page.getByTestId(`ask-option-q0o${i}`);
    await expect(row).toBeVisible();
    const desc = row.getByText(options[i].description, { exact: true });
    await expect(desc).toBeVisible();

    // 前提：说明真的排成了多行（数的是文字自己的行盒，不靠 line-height 推算）。
    const lines = await desc.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
    expect(lines, `第 ${i + 1} 项的说明只排了 ${lines} 行 —— 没换行时下面两条恒成立，这条用例就测不到它要测的`)
      .toBeGreaterThanOrEqual(2);

    const r = (await row.boundingBox())!;
    const d = (await desc.boundingBox())!;
    expect(d.y, `第 ${i + 1} 项的说明顶端溢出了自己那一行（说明 y=${d.y}，行 y=${r.y}）`)
      .toBeGreaterThanOrEqual(r.y - 0.5);
    expect(d.y + d.height, `第 ${i + 1} 项的说明底端溢出了自己那一行（说明底=${d.y + d.height}，行底=${r.y + r.height}）`)
      .toBeLessThanOrEqual(r.y + r.height + 0.5);
    rowBoxes.push(r);
  }
  for (let i = 1; i < rowBoxes.length; i += 1) {
    expect(rowBoxes[i].y, `第 ${i + 1} 行压到了第 ${i} 行上`)
      .toBeGreaterThanOrEqual(rowBoxes[i - 1].y + rowBoxes[i - 1].height - 0.5);
  }
});
