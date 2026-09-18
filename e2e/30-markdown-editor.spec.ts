import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, type LaunchedApp } from './helpers';

/**
 * 项目文件：右栏文件树跟着磁盘走、markdown 编辑器（保存往返、KaTeX、代码块配色、开档不标脏、
 * 关脏 tab 的确认）、主进程把 PDF 页渲染成 PNG。串行共用一次启动，各条用不同的文件。
 */
test.describe.configure({ mode: 'serial' });

// 语法会被 Crepe 规范化的内容：- 列表 → *，--- → ***，表格重新补空格对齐。
const NORM_CONTENT = [
  '# 规范化标题', '', '- 列表项一', '- 列表项二', '', '---', '', '| A | B |', '|---|---|', '| 1 | 2 |', '',
].join('\n');

// 最小单页 PDF：无 xref，pdf.js 走 recovery 模式解析 → numPages=1，MediaBox 300x400。
const MINIMAL_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`;

let launched: LaunchedApp;
let proj = '';
const at = (rel: string) => path.join(proj, rel);

test.beforeAll(async () => {
  launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      proj = path.join(home, 'proj');
      await fs.mkdir(proj, { recursive: true });
      await fs.writeFile(path.join(proj, 'README.md'), '# initial\n');
      await fs.writeFile(path.join(proj, 'tmp.md'), 'tmp\n');
      await fs.writeFile(path.join(proj, 'notes.md'), '# 初始标题\n\n正文段落。\n');
      await fs.writeFile(path.join(proj, 'math.md'), '# 行内公式标题\n\n这里有行内公式 $E = mc^2$ 在文字中。\n');
      await fs.writeFile(path.join(proj, 'norm.md'), NORM_CONTENT);
      await fs.writeFile(path.join(proj, 'code.md'), '# 代码块\n\n```python\ndef hello():\n    print("hi")\n```\n');
      await fs.writeFile(path.join(proj, 'figure.pdf'), MINIMAL_PDF);
      await seedProject(home, proj, [{ id: 'thr-1', title: '测试 Thread' }]);
    },
  });
  // 选中 thread，右栏才显示这个项目的文件树。
  await launched.page.getByTestId('thread-thr-1').click();
  await launched.page.getByTestId(`fs-${at('README.md')}`).waitFor();
});

test.afterAll(async () => { await teardown(launched); });

/** 双击文件树里的一行打开它的 tab，等编辑器挂上。 */
async function openMd(rel: string) {
  const { page } = launched;
  await page.getByTestId(`fs-${at(rel)}`).dblclick();
  await expect(page.getByTestId(`tab-${at(rel)}`)).toBeVisible();
  // 开过的 tab 编辑器仍挂在 DOM 里（切走只是藏起来），只认当前看得见的那一个。
  const editor = page.locator('.kydog-md-editor .ProseMirror').locator('visible=true');
  await editor.waitFor();
  return editor;
}

// 复现过「agent 写了一个 markdown，右侧文件树没刷新」：主进程 watcher 看到外部写入 → fs.changed →
// 渲染端重 fetch。这里用测试进程直接写文件模拟 agent 工具落盘。
test('32-file-tree-fs-watch: 外部新写入文件 → FileTree 自动出现新行', async () => {
  const { page } = launched;
  const report = at('research-report.md');
  await expect(page.getByTestId(`fs-${report}`)).toHaveCount(0);
  await fs.writeFile(report, '# report\n');
  // chokidar awaitWriteFinish(200) + debounce(200) ≈ 400ms。
  await expect(page.getByTestId(`fs-${report}`)).toBeVisible();
});

test('32-file-tree-fs-watch: 外部删除文件 → FileTree 行消失', async () => {
  const { page } = launched;
  const tmp = at('tmp.md');
  await expect(page.getByTestId(`fs-${tmp}`)).toBeVisible();
  await fs.unlink(tmp);
  await expect(page.getByTestId(`fs-${tmp}`)).toHaveCount(0);
});

test('30-markdown-editor: 双击打开 → 编辑 → ⌘S 保存往返', async () => {
  const { page } = launched;
  const editor = await openMd('notes.md');
  await expect(editor).toContainText('初始标题');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' 追加文字');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => fs.readFile(at('notes.md'), 'utf8').catch(() => '')).toContain('追加文字');
});

test('30-markdown-editor: 行内公式 $...$ 不白屏、KaTeX 正常渲染', async () => {
  const editor = await openMd('math.md');
  await expect(editor).toContainText('行内公式标题');
  await expect(editor.locator('.katex').first()).toBeVisible();
});

test('30-markdown-editor: 代码块当前行高亮跟随主题，而非 One Dark 深色', async () => {
  const { page } = launched;
  await openMd('code.md');
  await page.locator('.kydog-md-editor .cm-activeLineGutter').first().waitFor();
  const r = await page.evaluate(() => {
    const gutter = document.querySelector('.kydog-md-editor .cm-activeLineGutter') as HTMLElement;
    const line = document.querySelector('.kydog-md-editor .cm-activeLine') as HTMLElement;
    const probe = document.createElement('div');
    probe.style.background = 'var(--color-hover-bg)';
    document.querySelector('.kydog-md-editor')!.appendChild(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { gutterBg: getComputedStyle(gutter).backgroundColor, lineBg: getComputedStyle(line).backgroundColor, want };
  });
  expect(r.gutterBg).not.toBe('rgb(44, 49, 58)');   // One Dark 的 highlightBackground
  expect(r.gutterBg).toBe(r.want);
  expect(r.lineBg).toBe(r.want);
});

test('30-markdown-editor: 打开会被规范化的 md 不标脏；改了才脏，关脏 tab 弹确认框', async () => {
  const { page } = launched;
  const normPath = at('norm.md');
  const dirty = page.getByTestId(`tab-dirty-${normPath}`);
  const editor = await openMd('norm.md');
  await expect(editor).toContainText('规范化标题');

  // 开档即脏（bug）：Crepe 加载期会把 `-` / `---` / 表格规范化并发 markdownUpdated。要断的是
  // 「这段时间里什么都没发生」，没有协议事实可等，只能看一个观察窗 —— 这是全文件唯一的固定等待。
  await page.waitForTimeout(1500);
  await expect(dirty).toHaveCount(0);

  // 正向：真改了就脏（证明上面那个「不在」不是因为定位器坏了）。
  await editor.click();
  await page.keyboard.type('脏内容');
  await expect(dirty).toBeVisible();

  // 关脏 tab → 确认框；取消 → tab 仍在；再关 → 不保存 → tab 消失。
  await page.getByTestId(`tab-close-${normPath}`).click();
  await expect(page.getByTestId('unsaved-modal')).toBeVisible();
  await page.getByTestId('unsaved-cancel').click();
  await expect(page.getByTestId('unsaved-modal')).toHaveCount(0);
  await expect(page.getByTestId(`tab-${normPath}`)).toBeVisible();
  await page.getByTestId(`tab-close-${normPath}`).click();
  await page.getByTestId('unsaved-discard').click();
  await expect(page.getByTestId(`tab-${normPath}`)).toHaveCount(0);
});

/** 从 PNG 的 IHDR 里读宽高：magic(8) + 长度(4) + 'IHDR'(4) 之后是两个 big-endian u32。 */
function readPngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('47-pdf-raster: pdf.renderPage 真的画出一张 PNG', async () => {
  const { page, app } = launched;
  const pdfPath = at('figure.pdf');
  const render = (scale: number) => page.evaluate(
    async (a) => await window.kydog.invoke('pdf.renderPage', { path: a.p, page: 1, scale: a.scale }),
    { p: pdfPath, scale },
  );

  const result = await render(2);
  const expected = at('figure-p1.png');
  expect(result.pngPath).toBe(expected);
  // 「返回了一个路径」什么都证明不了 —— 读那个文件的字节。
  const buf = await fs.readFile(expected);
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buf.length).toBeGreaterThan(1024);
  // MediaBox 300x400 按 scale 2 → 600x800：尺寸对得上才说明画的是这一页，也证明 scale 真的生效。
  expect(readPngSize(buf)).toEqual({ width: 600, height: 800 });
  await render(3);
  expect(readPngSize(await fs.readFile(expected))).toEqual({ width: 900, height: 1200 });
  // 渲染窗口用完即毁：连转两张之后，活着的只剩主窗口。
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});
