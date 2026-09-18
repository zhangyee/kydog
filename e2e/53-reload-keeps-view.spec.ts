import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, type LaunchedApp } from './helpers';

/**
 * 中央区在看什么、输入框里没发的草稿，都活在渲染层内存里 —— 切走再切回、Ctrl+R 刷新都不许丢。
 * 刷新的是渲染进程，主进程照旧活着，靠主进程内存里那份快照接回来（page.reload() 与 Ctrl+R
 * 走同一条路）。冷启动不恢复由 18-projects-sidebar-actions 末尾那次重启守。
 * 串行共用一次启动。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let notesPath = '';

test.beforeAll(async () => {
  launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      const projectPath = path.join(home, 'proj');
      await fs.mkdir(projectPath, { recursive: true });
      notesPath = path.join(projectPath, 'notes.md');
      await fs.writeFile(notesPath, '# 初始标题\n\n正文段落。\n');
      await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
    },
  });
});

test.afterAll(async () => { await teardown(launched); });

/** 只读 contenteditable 的正文（跳过 skill chip），与 27-composer 里那个同源。 */
async function readBodyText(page: Page): Promise<string> {
  return page.getByTestId('composer-input').evaluate((el: HTMLElement) => {
    let body = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as Element;
        if (elem.getAttribute('data-skill-chip-name')) continue;
        if (elem.tagName === 'BR') { body += '\n'; continue; }
        body += (elem as HTMLElement).innerText ?? elem.textContent ?? '';
      } else if (node.nodeType === Node.TEXT_NODE) {
        body += node.textContent ?? '';
      }
    }
    return body;
  });
}

/** 当前看得见的那个 markdown 编辑器（开过的 tab 切走只是藏起来）。 */
const visibleEditor = (page: Page) => page.locator('.kydog-md-editor .ProseMirror').locator('visible=true');

test('53-reload: 刷新后仍停在原来的会话上，不回欢迎页', async () => {
  const { page } = launched;
  await expect(page.getByTestId('welcome-slogan')).toBeVisible();
  await page.getByTestId('thread-thr-1').click();
  await expect(page.getByTestId('tab-thr-1')).toBeVisible();
  await expect(page.getByTestId('welcome-slogan')).toHaveCount(0);

  await page.reload();
  // 用户报的现象本身：会话 tab 还在，欢迎页没回来。
  await expect(page.getByTestId('tab-thr-1')).toBeVisible();
  await expect(page.getByTestId('welcome-slogan')).toHaveCount(0);
});

test('51-composer-draft: 切到 md 编辑器再切回来，未发送的输入还在', async () => {
  const { page } = launched;
  const input = page.getByTestId('composer-input');
  await input.click();
  await page.keyboard.type('写了一半的问题');
  expect(await readBodyText(page)).toBe('写了一半的问题');

  // 打开 md 文件 tab —— thread 那半边整个卸载。
  await page.getByTestId(`fs-${notesPath}`).dblclick();
  await expect(visibleEditor(page)).toContainText('初始标题');
  await expect(input).toHaveCount(0);

  await page.getByTestId('tab-thr-1').click();
  await expect(input).toBeVisible();
  await expect.poll(() => readBodyText(page)).toBe('写了一半的问题');
  // 接着打字接在原文后面，不是从零开始。
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.type('？');
  await expect.poll(() => readBodyText(page)).toBe('写了一半的问题？');
});

test('53-reload: 刷新后文件 tab 还在，且仍停在原来那个 tab 上', async () => {
  const { page } = launched;
  await page.getByTestId(`tab-${notesPath}`).click();
  await expect(visibleEditor(page)).toContainText('初始标题');

  await page.reload();
  // tab 条上两个 tab 都回来了，而且停在 md 那个上。
  await expect(page.getByTestId('tab-thr-1')).toBeVisible();
  await expect(page.getByTestId(`tab-${notesPath}`)).toBeVisible();
  await expect(visibleEditor(page)).toContainText('初始标题');
});

test('51-composer-draft: 切到设置页再切回来，未发送的输入还在', async () => {
  const { page } = launched;
  await page.getByTestId('tab-thr-1').click();
  const input = page.getByTestId('composer-input');
  await input.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('草稿');
  await expect.poll(() => readBodyText(page)).toBe('草稿');

  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('open-settings').click();
  await expect(input).toHaveCount(0);

  await page.getByTestId('tab-thr-1').click();
  await expect(input).toBeVisible();
  await expect.poll(() => readBodyText(page)).toBe('草稿');
});
