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

test('30-markdown-editor: 双击打开 → 编辑 → ⌘S 保存往返', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const notesPath = path.join(kydogHome, 'proj', NOTES_REL);

    // 选中 thread，Inspector 才显示该项目的文件树
    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${notesPath}"]`);
    await fsRow.waitFor();

    // 双击打开 markdown 编辑器 tab
    await fsRow.dblclick();
    await expect(page.locator(`[data-testid="tab-${notesPath}"]`)).toBeVisible();
    const editor = page.locator('.kydog-md-editor .ProseMirror');
    await editor.waitFor();
    await expect(editor).toContainText('初始标题');

    // 在正文末尾输入内容
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' 追加文字');

    // ⌘S 保存
    await page.keyboard.press('ControlOrMeta+s');

    // 轮询磁盘文件直到包含新内容
    await expect.poll(async () => {
      return fs.readFile(notesPath, 'utf8').catch(() => '');
    }, { timeout: 5000 }).toContain('追加文字');
  } finally {
    await teardown(launched);
  }
});

test('30-markdown-editor: 关含未保存修改的 tab 弹确认框', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const notesPath = path.join(kydogHome, 'proj', NOTES_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${notesPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const editor = page.locator('.kydog-md-editor .ProseMirror');
    await editor.waitFor();
    await editor.click();
    await page.keyboard.type('脏内容');

    // 等待 tab 脏状态指示点出现（Crepe markdownUpdated → setFileTabDirty 传播）
    await expect(page.locator(`[data-testid="tab-dirty-${notesPath}"]`)).toBeVisible({ timeout: 3000 });

    // 点 tab 关闭按钮 → 因脏出现确认框
    await page.click(`[data-testid="tab-close-${notesPath}"]`);
    await expect(page.locator('[data-testid="unsaved-modal"]')).toBeVisible();

    // 取消 → tab 仍在
    await page.click('[data-testid="unsaved-cancel"]');
    await expect(page.locator('[data-testid="unsaved-modal"]')).toHaveCount(0);
    await expect(page.locator(`[data-testid="tab-${notesPath}"]`)).toBeVisible();

    // 再关 → 不保存 → tab 消失
    await page.click(`[data-testid="tab-close-${notesPath}"]`);
    await page.click('[data-testid="unsaved-discard"]');
    await expect(page.locator(`[data-testid="tab-${notesPath}"]`)).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});
