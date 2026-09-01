import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown, seedSettings, seedProject } from './helpers';

const NOTES_REL = 'notes.md';

/** 只读 contenteditable 的正文（跳过 skill chip），与 27-composer 里那个同源。 */
async function readBodyText(page: Page): Promise<string> {
  return await page.locator('[data-testid="composer-input"]').evaluate((el: HTMLElement) => {
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

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, NOTES_REL), '# 初始标题\n\n正文段落。\n');
  await seedProject(home, projectPath, [{ id: 'thr-draft', title: '测试 Thread' }]);
}

test('51-composer-draft: 切到 md 编辑器再切回来，未发送的输入还在', async () => {
  const launched = await launchKydog({ seed: seedAll });
  const { page, kydogHome } = launched;
  try {
    const notesPath = path.join(kydogHome, 'proj', NOTES_REL);

    await page.click('text=测试 Thread');
    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await page.keyboard.type('写了一半的问题');
    expect(await readBodyText(page)).toBe('写了一半的问题');

    // 打开 md 文件 tab —— thread 那半边会被整个卸载
    const fsRow = page.getByTestId(`fs-${notesPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();
    await expect(page.locator('.kydog-md-editor .ProseMirror')).toContainText('初始标题');
    await expect(input).toHaveCount(0);

    // 切回 thread tab
    await page.locator('[data-testid="tab-thr-draft"]').click();
    await expect(input).toBeVisible();
    expect(await readBodyText(page)).toBe('写了一半的问题');

    // 接着往下打字仍然是接在原文后面，不是从零开始
    await input.click();
    await page.keyboard.press('End');
    await page.keyboard.type('？');
    expect(await readBodyText(page)).toBe('写了一半的问题？');
  } finally {
    await teardown(launched);
  }
});

test('51-composer-draft: 切到设置页再切回来，未发送的输入还在；发送后清空', async () => {
  const launched = await launchKydog({ seed: seedAll, fixture: 'e2e/fixtures/happy-path-text.json' });
  const { page } = launched;
  try {
    await page.click('text=测试 Thread');
    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await page.keyboard.type('草稿');

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="open-settings"]').click();
    await expect(input).toHaveCount(0);

    await page.locator('[data-testid="tab-thr-draft"]').click();
    await expect(input).toBeVisible();
    expect(await readBodyText(page)).toBe('草稿');

    // 发出去之后草稿才该没
    await input.click();
    await page.keyboard.press('Enter');
    expect(await readBodyText(page)).toBe('');
  } finally {
    await teardown(launched);
  }
});
