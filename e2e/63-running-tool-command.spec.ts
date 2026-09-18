import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

/**
 * 工具还没返回时，点开就能看到它跑的是哪条命令。
 *
 * 命令在工具开始那一刻就随 `run.tool_call_start` 到了渲染层（AgentService 的
 * tool_execution_start 分支），输出却要等工具结束才一次性发过来。原先卡片「有输出才能展开」，
 * 于是一批并行的 fastpaper 全显示成「fastpaper 运行中」，哪条卡住了只能干等。
 *
 * 两份夹具里慢的那条都停 8 秒再结束，结束之后这一轮还挂着 30 秒（第二条消息不会到）——
 * 这样「跑着的时候」与「刚结束、过程区还开着」两个时刻都在同一条用例里看得到。
 */

const SLOW_COMMAND = "$ fastpaper search biorxiv 'cry for help' --after 2025-06-01 -n 8";
const PLACEHOLDER = '运行中，结果回来后显示在这里';

async function startRun(fixtureName: string, prompt: string) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    fixture: path.resolve('e2e/fixtures', fixtureName),
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  await launched.page.locator('[data-testid="new-thread"]').click();
  await launched.page.locator('[data-testid="composer-input"]').fill(prompt);
  await launched.page.locator('[data-testid="send-button"]').click();
  await expect(launched.page.locator('[data-testid="message-list"]')).toContainText(prompt);
  return launched;
}

test('63-running-tool: 单张工具卡在运行中就能展开看命令，结果回来后补进同一张卡', async () => {
  test.slow();
  const launched = await startRun('running-tool-single.json', 'search preprints');
  try {
    const page = launched.page;
    const toggle = page.getByTestId('tool-toggle-t-slow');
    const card = page.getByTestId('tool-t-slow');

    // 前提：它确实还在跑
    await expect(toggle).toContainText('运行中', { timeout: 5000 });

    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card).toContainText(SLOW_COMMAND);
    await expect(card).toContainText(PLACEHOLDER);
    // 上面几条断言做完时仍在运行中 —— 否则看到的可能是结束之后的卡
    await expect(toggle).toContainText('运行中');

    // 结果回来：同一张卡保持展开，输出补进来，占位字样消失，命令还在
    await expect(toggle).toContainText('完成', { timeout: 15_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card).toContainText('Root exudates recruit protective bacteria');
    await expect(card).not.toContainText(PLACEHOLDER);
    await expect(card).toContainText(SLOW_COMMAND);
  } finally {
    await teardown(launched);
  }
});

test('63-running-tool: 并行组里还在跑的那一行也能展开看命令，跑完的那一行照常看输出', async () => {
  test.slow();
  const launched = await startRun('running-tool-parallel.json', 'search two sources');
  try {
    const page = launched.page;
    const groupToggle = page.getByTestId('tool-group-toggle-tc-pubmed');

    // 前提：一条跑完、一条还在跑
    await expect(groupToggle).toContainText('运行中 1 · 完成 1', { timeout: 5000 });
    await groupToggle.click();

    const doneToggle = page.getByTestId('tool-toggle-tc-pubmed');
    const doneRow = page.getByTestId('tool-tc-pubmed');
    const slowToggle = page.getByTestId('tool-toggle-tc-biorxiv');
    const slowRow = page.getByTestId('tool-tc-biorxiv');

    await expect(slowToggle).toContainText('运行中');
    await expect(slowToggle).toBeEnabled();
    await slowToggle.click();
    await expect(slowToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(slowRow).toContainText(SLOW_COMMAND);
    await expect(slowRow).toContainText(PLACEHOLDER);
    await expect(slowToggle).toContainText('运行中');

    // 跑完的那一行：命令与输出都在，没有占位字样（占位字样确实存在，上面那一行刚看到过）
    await doneToggle.click();
    await expect(doneRow).toContainText(`$ fastpaper search pubmed '"cry for help" AND rhizosphere' -n 10`);
    await expect(doneRow).toContainText('Screening of Cry for Help signals');
    await expect(doneRow).not.toContainText(PLACEHOLDER);

    // 慢的那一行结束（失败）：错误输出补进同一行，占位字样消失
    await expect(slowToggle).toContainText('失败', { timeout: 15_000 });
    await expect(slowToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(slowRow).toContainText('Server error: 504');
    await expect(slowRow).not.toContainText(PLACEHOLDER);
  } finally {
    await teardown(launched);
  }
});
