import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown, seedSettings, seedProject, type LaunchedApp } from './helpers';

/**
 * 磁盘上的 markdown 被别人（agent）改了：干净 tab 静默跟上；有未保存修改就出横幅、确认才覆盖；
 * 自己 ⌘S 的回声不算。串行共用一次启动、同一个文件；点取消那条会留下脏状态，放最后。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let reportPath = '';

test.beforeAll(async () => {
  launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      const projectPath = path.join(home, 'proj');
      await fs.mkdir(projectPath, { recursive: true });
      reportPath = path.join(projectPath, 'report.md');
      await fs.writeFile(reportPath, '# 初稿标题\n\n初稿正文。\n');
      await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
    },
  });
  const { page } = launched;
  await page.getByTestId('thread-thr-1').click();
  await page.getByTestId(`fs-${reportPath}`).dblclick();
  await expect(page.locator('.kydog-md-editor .ProseMirror')).toContainText('初稿标题');
});

test.afterAll(async () => { await teardown(launched); });

const editorOf = () => launched.page.locator('.kydog-md-editor .ProseMirror');
const bannerOf = () => launched.page.getByTestId('external-change-banner');

async function typeAtEnd(text: string) {
  const { page } = launched;
  await editorOf().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
  await expect(editorOf()).toContainText(text);
}

test('52-md-external: 干净 tab 自动跟上外部改写；有未保存修改时出横幅，确认后才加载外部版本', async () => {
  const { page } = launched;
  const editor = editorOf();
  const banner = bannerOf();

  // 干净 tab：agent 改写 → 静默重载，不弹横幅（正向：下面脏了之后同一个横幅会出现）。
  await fs.writeFile(reportPath, '# 修订后标题\n\n修订后的正文。\n');
  await expect(editor).toContainText('修订后标题');
  await expect(editor).toContainText('修订后的正文');
  await expect(editor).not.toContainText('初稿标题');
  await expect(banner).toHaveCount(0);

  // 有未保存修改：出横幅而不是覆盖。
  await typeAtEnd(' 我手写的一句');
  await fs.writeFile(reportPath, '# 第三版标题\n\n第三版正文。\n');
  await expect(banner).toBeVisible();
  await expect(editor).toContainText('我手写的一句');
  await expect(editor).not.toContainText('第三版标题');

  // 丢弃本地修改是破坏性操作，走统一确认框。
  await page.getByTestId('external-change-reload').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(editor).toContainText('第三版标题');
  await expect(editor).not.toContainText('我手写的一句');
  await expect(banner).toHaveCount(0);
});

// ⌘S 自己写盘也会让 watcher 发 file.changed。那一条是回声，不是别人改的：拿新读到的内容跟
// diskContent 逐字节比就能认出来。认错了编辑器会被重建，光标、选区、撤销栈全丢 —— 用 DOM 节点
// 身份（打在编辑器节点上的记号）断言「没有重建」。
test('52-md-external: 自己 ⌘S 写出去的回声不触发重建', async () => {
  const { page } = launched;
  const editor = editorOf();
  await typeAtEnd(' 追加文字');
  // 等这一 tab 真的记成「有未保存修改」再存：打完字立刻 ⌘S，保存可能赶在脏标记之前、什么都不写
  // （Windows runner 上见过一次盘上还是上一版）。
  await expect(page.getByTestId(`tab-dirty-${reportPath}`)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => fs.readFile(reportPath, 'utf8').catch(() => '')).toContain('追加文字');

  await editor.evaluate((el) => { el.setAttribute('data-echo-probe', '1'); });
  // 要断的是「回声到了也什么都没发生」：等过 watcher 的 200ms debounce + 重读磁盘的一个来回。
  // 没有协议事实可等，只能看一个观察窗。
  await page.waitForTimeout(1500);
  await expect(editor).toHaveAttribute('data-echo-probe', '1');
  await expect(editor).toContainText('追加文字');
  await expect(bannerOf()).toHaveCount(0);

  // 正向：真是别人改的，编辑器就会重建，记号随旧节点一起没了 —— 证明上面那个「记号还在」有意义。
  await fs.writeFile(reportPath, '# 第四版标题\n\n第四版正文。\n');
  await expect(editor).toContainText('第四版标题');
  await expect(page.locator('.kydog-md-editor [data-echo-probe]')).toHaveCount(0);
});

test('52-md-external: 横幅里点取消 —— 本地修改留着，横幅还在', async () => {
  const { page } = launched;
  await typeAtEnd(' 又写一句');
  await fs.writeFile(reportPath, '# 第五版标题\n\n第五版正文。\n');
  const banner = bannerOf();
  await expect(banner).toBeVisible();
  await page.getByTestId('external-change-reload').click();
  await page.getByTestId('confirm-dialog-cancel').click();
  await expect(editorOf()).toContainText('又写一句');
  await expect(banner).toBeVisible();
});
