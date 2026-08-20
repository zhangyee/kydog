import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown } from './helpers';

const HTML_REL = 'report.html';

// 正文里那个 <script> 是探针：沙箱没给 allow-scripts，它不该跑起来。
// 跑起来了的话 #probe 的文字会被改成 SCRIPT-RAN。
const REPORT_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>测试报告</title>
<style>body { background: var(--paper, #ffffff); color: var(--ink, #222222); }</style>
</head>
<body>
<h1 id="heading">知识地图</h1>
<p id="probe">SCRIPT-DID-NOT-RUN</p>
<script>document.getElementById('probe').textContent = 'SCRIPT-RAN';</script>
</body>
</html>
`;

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, HTML_REL), REPORT_HTML);
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

test('46-html-tab: 双击打开 HTML tab → 渲染内容', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    await expect(page.locator(`[data-testid="tab-${htmlPath}"]`)).toBeVisible();
    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
    await expect(frame.locator('#heading')).toHaveText('知识地图');
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 沙箱不执行页面里的脚本', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
    await expect(frame.locator('#probe')).toHaveText('SCRIPT-DID-NOT-RUN');
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 报告跟随 app 主题', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const body = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`).locator('body');
    const bgOf = () => body.evaluate((el) => getComputedStyle(el).backgroundColor);

    await expect(page.locator(`[data-testid="tab-${htmlPath}"]`)).toBeVisible();
    const before = await bgOf();

    // 走真实 UI 切主题（同 e2e/08-theme-switch.spec.ts 的路径）：
    // 用户菜单 → midnight。注入的 --paper 变了，frame 里的背景必须跟着变。
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="theme-midnight"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');

    await expect.poll(bgOf).not.toBe(before);
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 报告跟随阅读字号', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const body = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`).locator('body');
    const sizeVar = () => body.evaluate(
      (el) => getComputedStyle(el).getPropertyValue('--reading-font-size').trim(),
    );

    await expect(page.locator(`[data-testid="tab-${htmlPath}"]`)).toBeVisible();
    await expect.poll(sizeVar).not.toBe('');

    // 同 e2e/36-font-size.spec.ts 的路径：用户菜单 → 大号
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="reading-size-large"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'large');

    await expect.poll(sizeVar).toBe('17px');
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 文件内容改了 tab 自动重载', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
    await expect(frame.locator('#heading')).toHaveText('知识地图');

    // 从进程外改写文件 —— 模拟 agent 重写报告
    await fs.writeFile(htmlPath, REPORT_HTML.replace('知识地图', '知识地图 v2'));

    await expect(frame.locator('#heading')).toHaveText('知识地图 v2', { timeout: 10000 });
  } finally {
    await teardown(launched);
  }
});
