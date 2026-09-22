import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector, type LaunchedApp } from './helpers';
import { inspectPdf, type PdfPage, type PdfReport } from './pdfInspect';

/**
 * 项目文件：右栏文件树跟着磁盘走、markdown 编辑器（保存往返、KaTeX、代码块配色、开档不标脏、
 * 关脏 tab 的确认、相对路径图片、块级图片说明文字）、主进程把 PDF 页渲染成 PNG、md 导出 PDF。
 * 串行共用一次启动，各条用不同的文件。
 *
 * 顺序约束：导出那条放最后 —— 它替换了主进程的 dialog.showSaveDialog / shell.showItemInFolder、
 * 改了设置文件里的 ui.mdExport、开着一个 PDF 标签，这些都不收回。
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

// ---- md 导出 PDF 的夹具（spec 2026-09-22-md-export-pdf-design §5）----

// 8×8 的不透明纯色 PNG（RGB #3a6ea5）。断言用 naturalWidth === 8、PDF 里画了一张 8×8 的图认它。
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGOwyluKFTEMLQkAbOhTQQpargcAAAAASUVORK5CYII=';

// 300 行、跨好几页的代码块，末行带标记：守「长代码块不被截断」。
const LONG_CODE = Array.from({ length: 300 }, (_, i) => (i === 299 ? 'const LAST = "ZZ_LAST_LINE";' : `const line_${i + 1} = ${i + 1};`)).join('\n');
// 一行远宽于版心、中间有空格可断的代码，行尾带标记：守「长行折行」与「折出来的行不计数」。
const LONG_LINE = `const LONG = "${'x'.repeat(60)} ${Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')} ZZ_LONG_TAIL";`;
// python 块放在最后：打印窗口 800×600，它离视口最远，守「视口外的代码块也真的挂上 CodeMirror」。
const EXPORT_MD = [
  '# 导出标题', '',
  '正文段落，带一个 [外链](https://example.org/x) 和一个 [相对链接](other.md)。', '',
  '```js', LONG_CODE, '```', '',
  '```js', 'const a = 1;', LONG_LINE, 'const b = 2;', '```', '',
  '| 列 A | 列 B |', '|---|---|', '| 1 | 2 |', '',
  '![块级图](figs/a.png)', '',
  '$$', 'E=mc^2', '$$', '',
  '```python', 'def tail():', "    return 'ZZ_PY_TAIL'", '```', '',
].join('\n');
// 块级图的两种 alt：说明文字、Milkdown 自己写的缩放比例；外加一张行内图。
const IMAGES_MD = ['# 图片', '', '![块级图](figs/a.png)', '', '![1.50](figs/a.png)', '', '行内 ![行内图](figs/a.png) 在句中。', ''].join('\n');

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
      // md 导出 PDF（spec 2026-09-22-md-export-pdf-design §5）
      await fs.mkdir(path.join(proj, 'figs'), { recursive: true });
      await fs.writeFile(path.join(proj, 'figs', 'a.png'), Buffer.from(TINY_PNG_BASE64, 'base64'));
      await fs.writeFile(path.join(proj, 'export.md'), EXPORT_MD);
      await fs.writeFile(path.join(proj, 'images.md'), IMAGES_MD);
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
  // 文件树缓存着这个目录 → 主进程 fs.watch 盯着它，debounce 200ms 后发 fs.changed。
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
  // 等这一 tab 真的记成「有未保存修改」再存：打完字立刻 ⌘S，保存可能赶在脏标记之前、什么都不写
  // （Windows runner 上见过盘上还是原文）。
  await expect(page.getByTestId(`tab-dirty-${at('notes.md')}`)).toBeVisible();
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

/** 把光标挪到这一行末尾。macOS 上 End 是「滚到文末」、光标不动（Playwright 按 Cocoa 的编辑命令发键，
 *  见 playwright-core 的 macEditingCommands），行尾是 ⌘→；其余平台就是 End。 */
const END_OF_LINE = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

test('30-markdown-editor: 相对路径图片按文件所在目录显示（块级与行内）', async () => {
  const editor = await openMd('images.md');
  const imgs = editor.locator('img');
  // 两张块级图（alt 是说明文字 / 是缩放比例）+ 一张行内图
  await expect(imgs).toHaveCount(3);
  // 三张都真的解码出来了：naturalWidth 是 PNG 的实际宽度。不配 proxyDomURL 时 figs/a.png 按应用页面
  // 自己的目录找、载不到，naturalWidth 是 0（spec §4 探针实测）。
  await expect.poll(() => imgs.evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth)))
    .toEqual([8, 8, 8]);
});

test('30-markdown-editor: 块级图片的说明文字存盘不被改成缩放比例；比例那条路仍然通', async () => {
  const { page } = launched;
  const file = at('images.md');
  const editor = await openMd('images.md');
  // 改一个与图片无关的字（标题末尾）再存盘：保存写的是整份重新序列化的文档，图片那几行跟着重写
  await editor.locator('h1').click();
  await page.keyboard.press(END_OF_LINE);
  await page.keyboard.type('改');
  await expect(page.getByTestId(`tab-dirty-${file}`)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => fs.readFile(file, 'utf8').catch(() => '')).toContain('# 图片改');
  const saved = await fs.readFile(file, 'utf8');
  expect(saved).toContain('![块级图](figs/a.png)');   // 修之前会变成 ![1.00](figs/a.png)
  expect(saved).toContain('![1.50](figs/a.png)');     // Milkdown 自己的比例写法照旧往返
  expect(saved).toContain('![行内图](figs/a.png)');   // 行内图走 commonmark 的 image 节点，本来就保留
});

/**
 * 导出一次的墙上时间预算。隐藏窗口里建 Crepe、300 行代码块整块挂上 CodeMirror、KaTeX、printToPDF、
 * 落盘，是真在干活的一段，耗时随机器浮动（本机约 0.5 秒）。这里的判据是「提示条出现、而且是完成
 * 不是失败」，不是快慢 —— 所以单给一个预算，不去放大 5 秒的 expect.timeout。主进程自己的上限是 60 秒。
 */
const EXPORT_BUDGET_MS = 30_000;

/** 页上文字的左缘。打印样式把编辑区的内边距清成 0，正文从版心左缘起排，这个数就是左边距。 */
function leftEdge(p: PdfPage): number {
  return Math.min(...p.items.filter((i) => i.str.trim() !== '').map((i) => i.x));
}

/** 含某段文字的那一行（按基线拼好的行）。找不到时返回一句说明，toMatch 的报错直接说出缺的是哪一行。 */
function rowWith(r: PdfReport, needle: string): string {
  return r.lines.find((l) => l.includes(needle)) ?? `<PDF 里没有含「${needle}」的行>`;
}

/** 一份 PDF 可以拿来和 PDF 标签对照的两个事实：页数、第 1 页的高宽比（两位小数：A4 是 1.41，Letter 是 1.29）。 */
function onDisk(r: PdfReport): { pages: number; ratio: number } {
  return { pages: r.pages.length, ratio: Number((r.pages[0].height / r.pages[0].width).toFixed(2)) };
}

/**
 * PDF 标签此刻画的是哪一份：页行数 + 第 1 页那一行的高宽比。页行的宽高 = pdfjs 读出的页尺寸 × 缩放
 * （PdfFileTab 的 data-pdf-page 行），所以高宽比就是那一页的纸型。还没有页行（加载中）时返回 null。
 * 直接查 DOM、不用 locator：页行在重读时会整批消失再出现，locator 的自动等待会卡在消失的那一刻。
 */
function shownPdf(pdfPath: string): Promise<{ pages: number; ratio: number } | null> {
  return launched.page.evaluate((sel) => {
    const pane = document.querySelector(sel);
    const rows = pane ? [...pane.querySelectorAll('[data-pdf-layer="stable"] [data-pdf-page]')] : [];
    if (rows.length === 0) return null;
    const b = rows[0].getBoundingClientRect();
    return { pages: rows.length, ratio: Number((b.height / b.width).toFixed(2)) };
  }, testIdSelector(`file-pane-${pdfPath}`));
}

type ExportRecord = { defaultPaths: string[]; revealed: string[] };

test('30-markdown-editor: 导出 PDF —— A4 / 标准 / 页码开，再 Letter / 窄 / 页码关；PDF 标签开着时重导出，「打开」看到新的那份', async () => {
  const { page, app, kydogHome } = launched;
  const mdPath = at('export.md');
  const editor = await openMd('export.md');
  // 每个 md 标签各有一套胶囊 / 设置卡 / 提示条（开过的标签只是藏起来），定位一律限在这个标签里
  const pane = page.getByTestId(`file-pane-${mdPath}`);
  const toast = pane.getByTestId('md-export-toast');

  // 不存盘的改动：导出的应当是编辑器当前内容，不是磁盘上那份
  await editor.locator('h1').click();
  await page.keyboard.press(END_OF_LINE);
  await page.keyboard.type('ZZUNSAVED');
  await expect(page.getByTestId(`tab-dirty-${mdPath}`)).toBeVisible();

  const out1 = at('out-a4.pdf');
  const out2 = at('out-letter.pdf');
  // 替换主进程的存储框与「在访达中显示」：handler 在调用时按模块属性取这两个函数（handlers.ts），
  // 换掉就不弹系统框、不开访达。存储框按调用次序交出预设路径，并记下每次收到的默认路径。
  await app.evaluate(({ dialog, shell }, paths) => {
    const queue = [...paths];
    const rec: ExportRecord = { defaultPaths: [], revealed: [] };
    (globalThis as unknown as { __mdExportE2E: ExportRecord }).__mdExportE2E = rec;
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const opts = args[args.length - 1] as { defaultPath?: string };
      rec.defaultPaths.push(opts.defaultPath ?? '');
      const next = queue.shift();
      return next ? { canceled: false, filePath: next } : { canceled: true, filePath: '' };
    }) as typeof dialog.showSaveDialog;
    shell.showItemInFolder = (p: string) => { rec.revealed.push(p); };
  }, [out1, out2, out2]);
  const recorded = () => app.evaluate(() => (globalThis as unknown as { __mdExportE2E: ExportRecord }).__mdExportE2E);

  /** 点分享键 →（改选项）→「导出…」→ 等这一次的结果提示条。先断言上一条提示条已经不在：新提示条出现
   *  才是「这一次做完了」的信号，旧的还挂着就分不清（每一条都在下一次导出前被点它的动作收掉）。 */
  const exportOnce = async (configure: () => Promise<void>) => {
    await expect(toast).toHaveCount(0);
    await pane.getByTestId('md-export').click();
    await expect(pane.getByTestId('md-export-card')).toBeVisible();
    await configure();
    await pane.getByTestId('md-export-go').click();
    await expect(toast).toBeVisible({ timeout: EXPORT_BUDGET_MS });
    // 失败时把提示条原文（「导出失败：<原因>」）带进报错
    expect(await toast.getAttribute('data-kind'), await toast.innerText()).toBe('done');
  };

  // ① 默认选项 A4 / 标准 / 页码开（种的设置文件是 v4、没有 ui.mdExport，读出来补默认）
  await exportOnce(async () => {
    await expect(pane.getByTestId('md-export-paper-a4')).toHaveAttribute('aria-pressed', 'true');
    await expect(pane.getByTestId('md-export-margin-standard')).toHaveAttribute('aria-pressed', 'true');
    await expect(pane.getByTestId('md-export-page-numbers')).toHaveAttribute('aria-checked', 'true');
  });
  // 「在访达中显示」交给 shell，传的是导出的那个路径；点完提示条收起
  await pane.getByTestId('md-export-reveal').click();
  await expect.poll(async () => (await recorded()).revealed).toEqual([out1]);
  await expect(toast).toHaveCount(0);

  const a4 = await inspectPdf(out1);
  // 1 长代码块不截断：末行在、编号是 300。.cm-editor / .cm-scroller 不放开 overflow 时，分页推下去的行被
  //   滚动层按分页前的高度裁掉，末行没了（探针实测）
  expect(rowWith(a4, 'ZZ_LAST_LINE')).toMatch(/^300\s*const LAST = "ZZ_LAST_LINE";/);
  // 2 视口外的代码块真的挂上了 CodeMirror：python 块的行带行号。只查标记文字不够 —— 纯文本占位
  //   （pre.milkdown-code-block-placeholder）里也有这段字，只是没有行号（探针实测：不装「全部可见」的
  //   IntersectionObserver、强行打印，印出来的就是不带行号的这两行；实际导出里就绪判据会一直等占位消失，
  //   那种情况下更早红在上面等提示条那一步）
  expect(rowWith(a4, 'def tail')).toMatch(/^1\s*def tail\(\):/);
  expect(rowWith(a4, 'ZZ_PY_TAIL')).toMatch(/^2\s*return 'ZZ_PY_TAIL'/);
  // 3 导出的是编辑器当前内容（含没存盘的那几个字）
  expect(a4.text).toContain('ZZUNSAVED');
  // 4 纸张 A4（Chromium 的 A4 是 595.92 × 842.88 pt），每一页都是
  for (const p of a4.pages) {
    expect(p.width).toBeCloseTo(595.92, 0);
    expect(p.height).toBeCloseTo(842.88, 0);
  }
  //   标准边距 1in = 72pt：正文从版心左缘起排（编辑区的 88px 内边距没清掉的话这里多出 66pt）
  expect(leftEdge(a4.pages[0])).toBeCloseTo(72, 0);
  // 5 页脚页码「— N —」
  expect(a4.text).toMatch(/—\s*2\s*—/);
  // 6 相对路径图片按 md 所在目录解析、画进了 PDF：这张 8×8（载不到时是坏图，不会画它）
  expect(a4.pages.flatMap((p) => p.images)).toContainEqual({ width: 8, height: 8 });
  // 7 公式按 KaTeX 渲染：嵌入的字体里有 KaTeX 家族（只剩 TeX 原文时没有）
  expect(a4.fontNames.some((f) => f.startsWith('KaTeX_')), `嵌入字体：${a4.fontNames.join(', ')}`).toBe(true);
  // 8 超长行折行：行尾标记完整落在版心内（右边距 72pt）。.cm-content 不放开 flex / min-width 时它按最长行
  //   把内容撑到版心外，这段字印到页外、根本读不出来（探针实测）
  const tail = a4.pages.flatMap((p) => p.items.map((i) => ({ ...i, pageWidth: p.width })))
    .find((i) => i.str.includes('ZZ_LONG_TAIL'));
  expect(tail, 'PDF 里读不到超长行的行尾标记 ZZ_LONG_TAIL').toBeDefined();
  expect(tail!.x + tail!.width).toBeLessThanOrEqual(tail!.pageWidth - 72 + 1);
  // 9 行号只数逻辑行。300 行的块：「N const line_N」一行不少、逐对一致、按 1…299 连续（中间丢了跨页的行、
  //   或编号错位，都在这里现形）
  const numbered = a4.lines.map((l) => /^(\d+)\s*const line_(\d+)\b/.exec(l)).filter((m) => m !== null)
    .map((m) => [Number(m[1]), Number(m[2])]);
  expect(numbered.length).toBe(299);
  expect(numbered.filter(([n, k], i) => n !== k || k !== i + 1).slice(0, 5)).toEqual([]);
  //   超长行折成好几行，只有第一行带编号；折出来的行不计数，它后面那一行的编号是 3
  expect(rowWith(a4, 'const LONG')).toMatch(/^2\s*const LONG =/);
  expect(rowWith(a4, 'ZZ_LONG_TAIL')).not.toMatch(/^\d/);   // 正向对照：上一条，同一个块的首行带编号
  expect(rowWith(a4, 'const b = 2;')).toMatch(/^3\s*const b = 2;/);
  // 链接：http(s) 外链可点；相对链接只留文字、不留 href（留着的话 Chromium 会把它印成
  // file:///…/other.md 的链接注解，pdfInspect 连 unsafeUrl 一起收，漏不掉）
  const links = a4.pages.flatMap((p) => p.links);
  expect(links).toContain('https://example.org/x');
  expect(links.filter((u) => u.includes('other.md'))).toEqual([]);
  expect(a4.text).toContain('相对链接');

  // ② Letter / 窄 / 页码关：三项都翻面
  await exportOnce(async () => {
    await pane.getByTestId('md-export-paper-letter').click();
    await pane.getByTestId('md-export-margin-narrow').click();
    await pane.getByTestId('md-export-page-numbers').click();
    await expect(pane.getByTestId('md-export-paper-letter')).toHaveAttribute('aria-pressed', 'true');
    await expect(pane.getByTestId('md-export-margin-narrow')).toHaveAttribute('aria-pressed', 'true');
    await expect(pane.getByTestId('md-export-page-numbers')).toHaveAttribute('aria-checked', 'false');
  });
  // 选择落盘：~/.kydog/kydog.json 的 ui.mdExport 是这一次的选择
  await expect.poll(() => fs.readFile(path.join(kydogHome, '.kydog', 'kydog.json'), 'utf8')
    .then((s) => JSON.parse(s).ui?.mdExport ?? null).catch(() => null))
    .toEqual({ paper: 'letter', margin: 'narrow', pageNumbers: false });
  // 「打开」开出这份 PDF 的标签，点完提示条收起
  await pane.getByTestId('md-export-open').click();
  await expect(page.getByTestId(`tab-${out2}`)).toBeVisible();
  await expect(toast).toHaveCount(0);

  const letter = await inspectPdf(out2);
  for (const p of letter.pages) {
    expect(p.width).toBeCloseTo(612, 0);
    expect(p.height).toBeCloseTo(792, 0);
  }
  expect(leftEdge(letter.pages[0])).toBeCloseTo(36, 0);   // 窄边距 0.5in
  // 否定：页码关了就读不出「— 2 —」。正向证明是第一次导出的第 5 条（同一条用例、同一个读法）；
  // 先证明确实有第 2 页可以缺页码
  expect(letter.pages.length).toBeGreaterThan(1);
  expect(letter.text).not.toMatch(/—\s*2\s*—/);
  // 标签里显示的就是盘上这一份
  await expect.poll(() => shownPdf(out2)).toEqual(onDisk(letter));

  // ③ PDF 标签开着时再导出到同一路径（换回 A4：页数与页面高宽比都变）→「打开」→ 标签里是新的那份。
  //   PDF 标签一个 tab 对象只读一次字节，盘上变了它也不跟；「打开」把同路径的标签关掉再开，新 tab 对象
  //   status 回到 'loading'，PdfFileTab 的字节 effect 才重读（MarkdownFileTab.tsx 的 openExported）。
  //   这条路断了，标签会一直停在上一份 Letter 的页数与高宽比上。
  await page.getByTestId(`tab-${mdPath}`).click();
  await exportOnce(async () => {
    await pane.getByTestId('md-export-paper-a4').click();
    await expect(pane.getByTestId('md-export-paper-a4')).toHaveAttribute('aria-pressed', 'true');
  });
  const again = await inspectPdf(out2);
  // 盘上确实换了一份，而且和标签里正显示的那份区分得开（否则下面那条不变也照样绿）
  expect(again.pages[0].width).toBeCloseTo(595.92, 0);
  expect(onDisk(again)).not.toEqual(onDisk(letter));
  await pane.getByTestId('md-export-open').click();
  await expect.poll(() => shownPdf(out2)).toEqual(onDisk(again));

  // 存储框一共弹了三次（没有多弹），每次的默认路径都是 md 同目录、同名换成 .pdf
  expect((await recorded()).defaultPaths).toEqual([at('export.pdf'), at('export.pdf'), at('export.pdf')]);
  // 打印窗口用完即毁：只剩主窗口
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});
