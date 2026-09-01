import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown } from './helpers';

const NOTES_REL = 'notes.md';
const MATH_REL = 'math.md';
const NORM_REL = 'norm.md';
const CODE_REL = 'code.md';

// 语法会被 Crepe 规范化的内容：- 列表 → *，--- → ***，表格重新补空格对齐。
const NORM_CONTENT = [
  '# 规范化标题',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '---',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
].join('\n');

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, NOTES_REL), '# 初始标题\n\n正文段落。\n');
  await fs.writeFile(
    path.join(projectPath, MATH_REL),
    '# 行内公式标题\n\n这里有行内公式 $E = mc^2$ 在文字中。\n',
  );
  await fs.writeFile(path.join(projectPath, NORM_REL), NORM_CONTENT);
  await fs.writeFile(
    path.join(projectPath, CODE_REL),
    '# 代码块\n\n```python\ndef hello():\n    print("hi")\n```\n',
  );
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

test('30-markdown-editor: 双击打开 → 编辑 → ⌘S 保存往返', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const notesPath = path.join(kydogHome, 'proj', NOTES_REL);

    // 选中 thread，Inspector 才显示该项目的文件树
    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${notesPath}`);
    await fsRow.waitFor();

    // 双击打开 markdown 编辑器 tab
    await fsRow.dblclick();
    await expect(page.getByTestId(`tab-${notesPath}`)).toBeVisible();
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

test('30-markdown-editor: 行内公式 $...$ 不白屏、KaTeX 正常渲染', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const mathPath = path.join(kydogHome, 'proj', MATH_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${mathPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();
    await expect(page.getByTestId(`tab-${mathPath}`)).toBeVisible();

    // 编辑器不能白屏：标题正文要出现
    const editor = page.locator('.kydog-md-editor .ProseMirror');
    await editor.waitFor();
    await expect(editor).toContainText('行内公式标题');

    // KaTeX 真渲染出来（行内公式节点存在 .katex）
    await expect(editor.locator('.katex').first()).toBeVisible();
  } finally {
    await teardown(launched);
  }
});

test('30-markdown-editor: 打开会被规范化的 md 不应标脏（开档即脏 bug）', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const normPath = path.join(kydogHome, 'proj', NORM_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${normPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const editor = page.locator('.kydog-md-editor .ProseMirror');
    await editor.waitFor();
    await expect(editor).toContainText('规范化标题');

    // 等编辑器加载期的 markdownUpdated（规范化）跑完
    await page.waitForTimeout(1500);

    // 没有任何编辑，脏标记不应出现
    await expect(page.getByTestId(`tab-dirty-${normPath}`)).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('30-markdown-editor: 代码块当前行高亮跟随主题，而非 One Dark 深色', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const codePath = path.join(kydogHome, 'proj', CODE_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${codePath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();
    await page.locator('.kydog-md-editor .cm-activeLineGutter').first().waitFor();

    const r = await page.evaluate(() => {
      const gutter = document.querySelector('.kydog-md-editor .cm-activeLineGutter') as HTMLElement;
      const line = document.querySelector('.kydog-md-editor .cm-activeLine') as HTMLElement;
      const probe = document.createElement('div');
      probe.style.background = 'var(--color-hover-bg)';
      document.querySelector('.kydog-md-editor')!.appendChild(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        gutterBg: getComputedStyle(gutter).backgroundColor,
        lineBg: getComputedStyle(line).backgroundColor,
        want,
      };
    });

    // 不再是 One Dark 的深色 highlightBackground (#2c313a)
    expect(r.gutterBg).not.toBe('rgb(44, 49, 58)');
    // 当前行行号与内容行都跟随主题 token --color-hover-bg
    expect(r.gutterBg).toBe(r.want);
    expect(r.lineBg).toBe(r.want);
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
    const fsRow = page.getByTestId(`fs-${notesPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const editor = page.locator('.kydog-md-editor .ProseMirror');
    await editor.waitFor();
    await editor.click();
    await page.keyboard.type('脏内容');

    // 等待 tab 脏状态指示点出现（Crepe markdownUpdated → setFileTabDirty 传播）
    await expect(page.getByTestId(`tab-dirty-${notesPath}`)).toBeVisible({ timeout: 3000 });

    // 点 tab 关闭按钮 → 因脏出现确认框
    await page.getByTestId(`tab-close-${notesPath}`).click();
    await expect(page.locator('[data-testid="unsaved-modal"]')).toBeVisible();

    // 取消 → tab 仍在
    await page.click('[data-testid="unsaved-cancel"]');
    await expect(page.locator('[data-testid="unsaved-modal"]')).toHaveCount(0);
    await expect(page.getByTestId(`tab-${notesPath}`)).toBeVisible();

    // 再关 → 不保存 → tab 消失
    await page.getByTestId(`tab-close-${notesPath}`).click();
    await page.click('[data-testid="unsaved-discard"]');
    await expect(page.getByTestId(`tab-${notesPath}`)).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});
