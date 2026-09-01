import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown, seedSettings, seedProject } from './helpers';

const REPORT_REL = 'report.md';

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, REPORT_REL), '# 初稿标题\n\n初稿正文。\n');
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

/** 打开 report.md 的编辑器 tab，返回编辑器 locator 与文件绝对路径。 */
async function openReport(page: Page, kydogHome: string) {
  const reportPath = path.join(kydogHome, 'proj', REPORT_REL);
  await page.click('text=测试 Thread');
  const fsRow = page.getByTestId(`fs-${reportPath}`);
  await fsRow.waitFor();
  await fsRow.dblclick();
  const editor = page.locator('.kydog-md-editor .ProseMirror');
  await editor.waitFor();
  await expect(editor).toContainText('初稿标题');
  return { editor, reportPath };
}

test('52-md-external: 干净 tab —— agent 改写文件后编辑器自动跟上', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const { editor, reportPath } = await openReport(page, kydogHome);

    // 模拟 agent 在对话里改写这份报告
    await fs.writeFile(reportPath, '# 修订后标题\n\n修订后的正文。\n');

    await expect(editor).toContainText('修订后标题', { timeout: 5000 });
    await expect(editor).toContainText('修订后的正文');
    await expect(editor).not.toContainText('初稿标题');
    // 干净 tab 静默重载，不该弹横幅
    await expect(page.locator('[data-testid="external-change-banner"]')).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('52-md-external: 有未保存修改 —— 出横幅而不是覆盖，确认后才加载外部版本', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const { editor, reportPath } = await openReport(page, kydogHome);

    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' 我手写的一句');
    await expect(editor).toContainText('我手写的一句');

    await fs.writeFile(reportPath, '# 修订后标题\n\n修订后的正文。\n');

    const banner = page.locator('[data-testid="external-change-banner"]');
    await expect(banner).toBeVisible({ timeout: 5000 });
    // 关键：本地未保存的修改没有被顶掉
    await expect(editor).toContainText('我手写的一句');
    await expect(editor).not.toContainText('修订后标题');

    // 丢弃本地修改是破坏性操作，走统一确认框
    await page.locator('[data-testid="external-change-reload"]').click();
    await expect(page.locator('[data-testid="confirm-dialog"]')).toBeVisible();
    await page.locator('[data-testid="confirm-dialog-confirm"]').click();

    await expect(editor).toContainText('修订后标题');
    await expect(editor).not.toContainText('我手写的一句');
    await expect(banner).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('52-md-external: 横幅里点取消 —— 本地修改留着，横幅还在', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const { editor, reportPath } = await openReport(page, kydogHome);

    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' 我手写的一句');
    await fs.writeFile(reportPath, '# 修订后标题\n\n修订后的正文。\n');

    const banner = page.locator('[data-testid="external-change-banner"]');
    await expect(banner).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="external-change-reload"]').click();
    await page.locator('[data-testid="confirm-dialog-cancel"]').click();

    await expect(editor).toContainText('我手写的一句');
    await expect(banner).toBeVisible();
  } finally {
    await teardown(launched);
  }
});

// ⌘S 自己写盘也会让 watcher 发 file.changed。那一条是回声，不是别人改的：
// 拿新读到的内容跟 diskContent 逐字节比就能认出来。认错了编辑器会被重建，
// 光标、选区、撤销栈全丢 —— 这里用 DOM 节点身份直接断言「没有重建」。
test('52-md-external: 自己 ⌘S 写出去的回声不触发重建', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const { editor, reportPath } = await openReport(page, kydogHome);

    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' 追加文字');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(async () => fs.readFile(reportPath, 'utf8').catch(() => ''), { timeout: 5000 })
      .toContain('追加文字');

    // 在当前编辑器 DOM 上做个记号；重建会换掉这个节点，记号就没了
    await editor.evaluate((el) => { el.setAttribute('data-echo-probe', '1'); });

    // 等过 watcher 的 200ms debounce + 重读磁盘的一个来回
    await page.waitForTimeout(1500);

    await expect(editor).toHaveAttribute('data-echo-probe', '1');
    await expect(editor).toContainText('追加文字');
    await expect(page.locator('[data-testid="external-change-banner"]')).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});
