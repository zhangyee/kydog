import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown } from './helpers';

const NOTES_REL = 'notes.md';

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, NOTES_REL), '# 初始标题\n\n正文段落。\n');
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

/**
 * Ctrl+R 刷新的是渲染进程，主进程照旧活着 —— 所以「刷新」的语义是接着看，不是回首页。
 * 中央区在看什么只活在渲染层内存里，重载即归零，得靠主进程内存里那份快照接回来。
 *
 * 这条只跑 page.reload()，跟 Ctrl+R 走的是同一条路（viewMenu 的 reload role）。
 */
test('53-reload: 刷新后仍停在原来的会话上，不回欢迎页', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page } = launched;

    await page.click('text=测试 Thread');
    await expect(page.locator('[data-testid="tab-thr-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="welcome-slogan"]')).toHaveCount(0);

    await page.reload();

    // 这两条就是用户报的那个现象本身：会话 tab 还在，欢迎页没回来
    await expect(page.locator('[data-testid="tab-thr-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="welcome-slogan"]')).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

// 定位文件树的行一律走 getByTestId，别拼 `[data-testid="fs-${路径}"]`：
// Windows 绝对路径里的反斜杠在 CSS 属性值里是转义符（`\a`+dmin、`\A`+ppData 都会被
// 当成字符转义吃掉），选择器永远匹配不上 —— 而元素其实好好地渲染着、位置尺寸都正常。
// 30-markdown / 32-file-tree-fs-watch / 49-file-name-marquee 目前都栽在这上面。
test('53-reload: 刷新后文件 tab 还在，且仍停在原来那个 tab 上', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const notesPath = path.join(kydogHome, 'proj', NOTES_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${notesPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();
    await expect(page.getByTestId(`tab-${notesPath}`)).toBeVisible();
    await expect(page.locator('.kydog-md-editor .ProseMirror')).toContainText('初始标题');

    await page.reload();

    // tab 条上两个 tab 都回来了，而且前面那个仍然是 md
    await expect(page.getByTestId('tab-thr-1')).toBeVisible();
    await expect(page.getByTestId(`tab-${notesPath}`)).toBeVisible();
    await expect(page.locator('.kydog-md-editor .ProseMirror')).toContainText('初始标题');
  } finally {
    await teardown(launched);
  }
});

/**
 * 冷启动是另一回事：快照只在主进程内存里，app 退出就没了。
 * 这条守的是「别把刷新的修法悄悄扩成跨重启恢复」——那是没人要过的行为改变。
 */
test('53-reload: 冷启动不恢复，仍是干净的欢迎页', async () => {
  let launched = await launchKydog({ seed: seedAll });
  const home = launched.kydogHome;
  try {
    await launched.page.click('text=测试 Thread');
    await expect(launched.page.locator('[data-testid="tab-thr-1"]')).toBeVisible();
  } finally {
    await teardown(launched);
  }

  launched = await launchKydog({ kydogHome: home });
  try {
    const { page } = launched;
    await expect(page.locator('[data-testid="thread-thr-1"]')).toBeVisible(); // 侧栏里当然还在
    await expect(page.locator('[data-testid="tab-thr-1"]')).toHaveCount(0);   // 但没有被自动选中
    await expect(page.locator('[data-testid="welcome-slogan"]')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
