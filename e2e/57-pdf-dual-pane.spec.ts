import { test, expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { launchKydog, seedProject, teardown, testIdSelector, type LaunchedApp } from './helpers';
import { buildPagedPdf } from './fixtures/textPdf';
import { ZOOM_SENSITIVITY } from '../src/renderer/panels/main-pane/pdf/zoomSensitivity';
// splitPane.ts 整个文件都是纯算（两个常量 + 三个纯函数，无 import），所以连函数一起拿过来用：
// 拖分隔线那条用例要断的是「DOM 与这两个纯函数逐像素一致」，照抄一份公式到测试里等于把被测的
// 算法抄了两遍，抄错了两边一起错。
import { clampSplit, DIVIDER_PX, paneWidths } from '../src/renderer/panels/main-pane/pdf/splitPane';
// contrast() 是纯函数（luminance 算术，见文件内注释），不依赖 DOM——同 ZOOM_SENSITIVITY /
// splitPane 一样可以直接从组件目录 import 到 Node 端的 e2e 文件，不会拖入 react-pdf /
// pdf.js worker 的副作用
// （那两个文件都没有其他 import；inkForBackground.ts 只 import 了 pageBackground.ts 的一个类型）。
import { contrast } from '../src/renderer/panels/main-pane/pdf/inkForBackground';
import type { RGB } from '../src/renderer/panels/main-pane/pdf/pageBackground';
// 同上，纯函数直接从组件目录 import。LEAD 用来把「块 div 与块矩形同坐标系」那条断言的期望值
// 换算成 blockFrame 之后的真值——首尾半行距放到块外之后，块 div 不再逐 pt 落在块矩形上
// （TranslationBlocks.tsx 的 measureFit / blockFrame 改动，spec 2026-09-06 §3）。
import { LEAD, LINE_HEIGHT } from '../src/renderer/panels/main-pane/pdf/blockLayout';
import { FADE_MS, THUMB_HOVER_PX, THUMB_INSET_PX, scrollPosForThumb } from '../src/renderer/panels/main-pane/pdf/overlayScrollbar';

/**
 * PDF 双栏对照。两次冷启动，各自串行（`test.describe` 里 `mode: 'serial'`），每个说法仍是一条
 * 独立的 `test()`。**上一条的状态就是下一条的起点**，顺序是被下面这几件事逼出来的，别调：
 *
 * 启动一（进出对照、像素、字号、标注、缩放、排版、主题）
 *   1. 字号测量那条必须是 paper.pdf **第一次**进对照：TranslationBlocks 的 fitCache 是模块级的
 *      （按 tab 分域），进过一次就留着量好的字号，闸门再也拦不到「先量后到位」。
 *   2. 像素与几何、左栏标注都接着它的对照态做。
 *   3. 缩放三条要从打开时的 100% 起步（捏合那条断言精确的「150%」读数），所以先按 L 退出对照、
 *      等它把缩放还原回 100%。三条逐条接力：捏合后进对照 → 退出还原 → 自动退出。**自动退出那条会
 *      改坏 paper.pdf 的译文边车**，必须是 paper.pdf 的最后一步。
 *   4. 之后换别的 PDF，各开各的 tab（文件名互不相同）：inline-code，再是主题 × 背景。
 *
 * 启动二（分栏：两个滚动容器 + 同步）
 *   对齐 → 滚动同步 → 覆盖式滚动条 → 拖分隔线（末尾双击回等宽）→ 两栏不等宽 → 不等宽时捏合
 *   （接着上一条拉开的 scrollLeft 差距做）。
 */

const PDF_REL = 'paper.pdf';
const ZH_REL = '.paper.pdf.zh.json';
// A4，页数够滚几屏。buildPagedPdf 每页只写一行 24 pt 的「Page N」，基线在 PDF y = h - 60，
// 换成 scale 1 视口坐标（y 向下）就是 y = 60，字大致落在 y ∈ [43, 60]、x ∈ [40, 115]。
const PAGE_W = 595;
const PAGE_H = 842;
const PAGES = 8;
// 页上那行字所在的矩形（视口 pt）。下面的 fixture 把它划成一个**没有 target** 的块，
// 用来验「不翻译的块不盖」——右格里那行字必须原样还在。
const INK = { x: 30, y: 35, w: 110, h: 30 };
// 有 target 的那个块（视口 pt）：字号测量（LONG_ZH）与「译文块与右格底图同坐标系」量的都是它。
const TARGET_BLOCK = { x: 60, y: 200, w: 460, h: 120 };
// 译文块字号 e2e（字体加载前后一致）要用的长文本：块高 120pt、字号 11、行高 1.5 → 一屏约
// 7 行、每行约 41 个全角字符，纯文本装不下的门槛在 ~290 字左右。这里往上叠了好几倍余量，
// 确保 fitFontScale 真的会二分收缩——只有触发收缩，「测量时用的是不是真字体」才会体现在
// 量出来的字号（换行位置）上；文本一次就能装下的话，前后测两次字号恒等，测不出什么。
const LONG_ZH = '这段译文足够长，用来确保字号自适应必须收缩，从而让"有没有等字体加载再测量"这件事在几何上真的可观测。'.repeat(15);

/**
 * 最小译文边车：每页两条块，一条有 target（要被底色盖掉）、一条没有（原样保留）。
 * `source.sha256` 就地按同一份字节算真值——写死一个常量的话，fixture 生成逻辑一改它就悄悄
 * 变成 mismatch，而 mismatch 是「禁用对照」，整条用例会以看不出原因的方式失效。
 */
function buildSidecar(pdf: Buffer): string {
  const blocks = [];
  for (let p = 1; p <= PAGES; p++) {
    blocks.push({
      id: `b${p}-ink`, page: p, x: INK.x, y: INK.y, width: INK.w, height: INK.h,
      fontSize: 24, kind: 'formula', source: `Page ${p}`,   // 无 target = 不翻译 = 不盖
    });
    blocks.push({
      id: `b${p}-text`, page: p, x: TARGET_BLOCK.x, y: TARGET_BLOCK.y,
      width: TARGET_BLOCK.w, height: TARGET_BLOCK.h,
      fontSize: 11, kind: 'text', source: 'a body paragraph', target: LONG_ZH,
    });
  }
  return JSON.stringify({
    version: 1,
    pdf: PDF_REL,
    lang: { in: 'en', out: 'zh' },
    source: { sha256: createHash('sha256').update(pdf).digest('hex'), bytes: pdf.byteLength },
    blocks,
  }, null, 2);
}

async function writePaper(projectPath: string) {
  const pdf = buildPagedPdf(PAGES, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, PDF_REL), pdf);
  await fs.writeFile(path.join(projectPath, ZH_REL), buildSidecar(pdf));
}

/**
 * 一个项目、一个 thread，项目里放 `writers` 各自写出来的那几份文件。每个 writer 写的文件名
 * 互不相同，同一次启动里各开各的 tab、各走各的边车，不互相覆盖。
 */
function seedWith(...writers: Array<(projectPath: string) => Promise<void>>) {
  return async (home: string) => {
    const projectPath = path.join(home, 'proj');
    await fs.mkdir(projectPath, { recursive: true });
    for (const write of writers) await write(projectPath);
    await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
  };
}

// 对比度 e2e（design spec §13）的最小 fixture：一份白底、一份深底，各配一条有 target 的块。
// 不复用 paper.pdf——那份 fixture 是给对齐/像素/字号几条用例的，混进一份深色页会让读的人多想
// 一层「这份深色底是给谁用的」；各说法自带自己需要的最小 fixture，互不牵连。
const CONTRAST_WHITE_REL = 'contrast-white.pdf';
const CONTRAST_DARK_REL = 'contrast-dark.pdf';
const CONTRAST_BLOCK = { x: 60, y: 200, w: 460, h: 120 };
const CONTRAST_TEXT = '这块译文的墨色应当由背景推出，不管应用主题是什么。';
// 近黑深底——不取 INK_ON_DARK/INK_ON_LIGHT 本身的坐标，避免 fixture 和被测常量凑巧同值、
// 把「墨色确实由背景推导」这件事测成了「两边抄的是同一个数」。
const CONTRAST_DARK_BG: [number, number, number] = [12, 12, 16];

function buildContrastSidecar(pdfRel: string, pdf: Buffer): string {
  return JSON.stringify({
    version: 1,
    pdf: pdfRel,
    lang: { in: 'en', out: 'zh' },
    source: { sha256: createHash('sha256').update(pdf).digest('hex'), bytes: pdf.byteLength },
    blocks: [{
      id: 'c1', page: 1,
      x: CONTRAST_BLOCK.x, y: CONTRAST_BLOCK.y, width: CONTRAST_BLOCK.w, height: CONTRAST_BLOCK.h,
      fontSize: 14, kind: 'text', source: 'contrast check', target: CONTRAST_TEXT,
    }],
  }, null, 2);
}

// 「页背景取不到」那条兜底路径的 fixture：白页，左上角压一个深色小矩形。pageBackground() 的
// 八点取样里只有左上角那一点落在矩形内（inset 2 位图像素 ≈ 1 pt，远在 30 pt 的矩形之内），
// 其余七点仍是白 —— 八点不全同 → 返回 null → RightPage 走兜底填主题纸色。
// 这正是扫描件（JPEG 噪声让四角逐字节不等）与四边压出血图的页在真实世界里的等价触发。
const FALLBACK_REL = 'fallback-bg.pdf';
const FALLBACK_PATCH = { x: 0, y: 0, w: 30, h: 30, color: [40, 90, 60] as [number, number, number] };

async function writeFallbackBg(projectPath: string) {
  const pdf = buildPagedPdf(1, PAGE_W, PAGE_H, undefined, undefined, FALLBACK_PATCH);
  await fs.writeFile(path.join(projectPath, FALLBACK_REL), pdf);
  await fs.writeFile(
    path.join(projectPath, `.${FALLBACK_REL}.zh.json`),
    buildContrastSidecar(FALLBACK_REL, pdf),
  );
}

// 「测量与渲染同源」那条用例的 fixture：整块译文都是一个 inline-code 占位符。
// 渲染时它走 --font-mono，而测量宿主若拿纯文本（继承 --font-serif）去量，量到的行数会少于
// 真正画出来的行数——等宽字体对 `i` `l` `(` `;` 这类窄字形尤其宽，这段文本刻意堆满它们，
// 把两种字体的宽度差拉到最大。文本长度选在「按 serif 量一次就装得下、按 mono 画出来装不下」
// 这个区间里：测量错了必然溢出成块内滚动条，测量对了必然收到装得下。
const MONO_REL = 'inline-code.pdf';
const MONO_BLOCK = { x: 60, y: 200, w: 460, h: 120 };
const MONO_CODE = 'if (i < l) { i = l; } '.repeat(32);

function buildMonoSidecar(pdf: Buffer): string {
  return JSON.stringify({
    version: 1,
    pdf: MONO_REL,
    lang: { in: 'en', out: 'zh' },
    source: { sha256: createHash('sha256').update(pdf).digest('hex'), bytes: pdf.byteLength },
    blocks: [{
      id: 'm1', page: 1,
      x: MONO_BLOCK.x, y: MONO_BLOCK.y, width: MONO_BLOCK.w, height: MONO_BLOCK.h,
      fontSize: 11, kind: 'text', source: 'a code-heavy paragraph', target: '{v1}',
      placeholders: [{ id: 'v1', kind: 'inline-code', text: MONO_CODE }],
    }],
  }, null, 2);
}

async function writeMono(projectPath: string) {
  const pdf = buildPagedPdf(1, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, MONO_REL), pdf);
  await fs.writeFile(path.join(projectPath, `.${MONO_REL}.zh.json`), buildMonoSidecar(pdf));
}

async function writeContrast(projectPath: string) {
  const white = buildPagedPdf(1, PAGE_W, PAGE_H); // 无 bg 参数 = 原来的行为 = 白底
  await fs.writeFile(path.join(projectPath, CONTRAST_WHITE_REL), white);
  await fs.writeFile(
    path.join(projectPath, `.${CONTRAST_WHITE_REL}.zh.json`),
    buildContrastSidecar(CONTRAST_WHITE_REL, white),
  );

  const dark = buildPagedPdf(1, PAGE_W, PAGE_H, undefined, CONTRAST_DARK_BG);
  await fs.writeFile(path.join(projectPath, CONTRAST_DARK_REL), dark);
  await fs.writeFile(
    path.join(projectPath, `.${CONTRAST_DARK_REL}.zh.json`),
    buildContrastSidecar(CONTRAST_DARK_REL, dark),
  );
}

async function openPdf(page: Page, pdfPath: string): Promise<Locator> {
  await page.locator('[data-pane="workspace"]').getByText('测试 Thread').click();
  const row = page.getByTestId(`fs-${pdfPath}`);
  await row.waitFor();
  await row.dblclick();
  const pane = page.getByTestId(`file-pane-${pdfPath}`);
  await expect(pane.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect(pane.getByTestId('pdf-annotation-layer-1')).toBeVisible();
  return pane;
}

/**
 * 按 L 进对照。译文边车是另一条异步链路（读字节 → sha256 → RPC → store），页尺寸预取也是，
 * 两者都可能比首屏渲染晚到；没到之前按 L 要么什么都不发生（pending），要么走的是「翻译」那一支
 * （none：跑流水线）。所以先等翻译键的 aria-label 变成 ready 态的「翻译对照 · L」——它就是
 * translateUiState 的返回值，与 L 键的放行判据 canPressTranslate 同源——再按**一次** L，等它变成
 * active 态的「退出对照 · L」。等的是协议层事实，不重试、不等拍脑袋的毫秒数。
 *
 * 按键由 pane 根上的 onKeyDown 接：先点一下左栏滚动容器，根上的 onPointerDownCapture 会把焦点
 * 收进 pane。
 */
async function enterDual(page: Page, pane: Locator) {
  const btn = pane.getByTestId('pdf-translate');
  await expect(btn, '边车加载完、页尺寸预取完，翻译键才进 ready 态').toHaveAttribute('aria-label', '翻译对照 · L');
  await pane.locator('[data-testid^="pdf-scroll-"]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('l');
  await expect(btn, '按 L 之后应当进了对照').toHaveAttribute('aria-label', '退出对照 · L');
  await settleLayers(pane);
}

/** 按 L 退出对照。判据同 enterDual：翻译键从 active 回到 ready，右栏整个卸掉。 */
async function exitDual(page: Page, pane: Locator) {
  const btn = pane.getByTestId('pdf-translate');
  await expect(btn, '退出之前应当正在对照里').toHaveAttribute('aria-label', '退出对照 · L');
  await pane.locator('[data-testid^="pdf-scroll-"]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('l');
  await expect(pane.locator('[data-pdf-pane="right"]')).toHaveCount(0);
  await expect(btn).toHaveAttribute('aria-label', '翻译对照 · L');
}

/**
 * 等缩放双缓冲收敛成一层。
 *
 * 进对照会顺带做一次 fit-width 缩放，缩放走的是双缓冲：新层先在旧层下面画，全部页画好了整层
 * 顶替（PdfFileTab 的 renderLayers / promote）。顶替发生的那一刻，stable 层**整棵子树被换掉**
 * ——此前拿到的任何元素句柄都成了游离节点。于是紧跟在 enterDual 后面量几何的用例会随机踩空：
 * `boundingBox()` 回 null（win32 实测），`getComputedStyle().fontSize` 回空串（darwin-arm64
 * 实测）。本机顶替得快，这段窗口窄到从来没踩上过。
 *
 * 判据是协议层事实，不是拍脑袋的毫秒数，而且**只数层数不够**：清晰层上挂着
 * `zoom: visualScale / layer.scale`，新层还没建出来的那一小段里层数同样是 1，可那时清晰层
 * 还是按旧比例画的、只是被视觉缩小了（实测 zoom=0.393）。这时量出来的位图宽与块的 CSS 宽
 * 分属两套比例，逐几何的判据必然对不上（57「译文块与右格底图同坐标系」的 dh 差 2 px 就是它）。
 * 所以判据是两件事一起成立：只剩一层，且那一层的 zoom 已经回到 1（= 它就是按当前比例画的）。
 */
async function settleLayers(pane: Locator) {
  for (const side of ['left', 'right'] as const) {
    await expect
      .poll(() => pane.evaluate((el, s) => {
        const layers = el.querySelectorAll(`[data-pdf-pane="${s}"] [data-pdf-layer]`);
        if (layers.length !== 1) return `还有 ${layers.length} 层在飞`;
        const z = Number(getComputedStyle(layers[0] as HTMLElement).zoom);
        return Math.abs(z - 1) < 0.001 ? 'ok' : `清晰层还按旧比例画着，zoom=${z}`;
      }, side), {
        timeout: 15000,
        message: `${side} 栏的缩放应当已经落地：只剩 stable 一层，且它按当前比例重画完了`,
      })
      .toBe('ok');
  }
}

/** 从 `${page} / ${numPages} · ${zoomPct}%` 读数里取出百分比数字。 */
function readoutPct(text: string): number {
  return Number(text.split('·')[1].trim().replace('%', ''));
}

/** 切主题：走用户菜单，同 08-theme-switch / 11-themes-five 的路径。 */
async function setTheme(page: Page, name: 'vellum' | 'midnight') {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId(`theme-${name}`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', name);
  // 选主题**不关菜单**是刻意的产品行为（可以连着换几个看），所以这里必须自己关掉再返回：
  // 菜单是覆盖在侧边栏上的浮层，不关的话下一步 openPdf 点「测试 Thread」会被它拦截
  // （CI darwin-arm64 实测：locator.click 等 30s 超时，拦截者是菜单里的「登录订阅或填入
  // API Key」那一行）。本机只是碰巧关得快，不是不会发生。
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('user-menu')).toHaveCount(0);
}

function parseRgb(css: string): RGB {
  const m = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) throw new Error(`无法从 computed style 解析颜色：${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 读一个译文块的 computed color、以及右格底图在这个块矩形正中心的像素，算 WCAG 对比度。
 * 采中心点：译文块本身是叠在底图上的 HTML 层，不进 canvas 绘制，所以矩形内任一点的底图像素
 * 都只是 RightPage 填的纯色，不需要避开什么。
 * 块还没挂载、或右格还没合成过时返回 null——调用方先用它 poll 就绪，再对数值本身断言，
 * 这样断言失败时报的是真实对比度数字，不是一个含糊的超时。
 *
 * 顺带把两个原始量也交出来：`bg` 是底图那一点的实际像素，`themePaper` 是当前主题
 * `--color-paper` 解析成的 sRGB（在页内过一次 1×1 画布，和 RightPage 的 themePaperRgb
 * 同一条路子——主题 token 是 oklch()，computed style 不再折算成 rgb()）。兜底路径那条用例
 * 靠这两个数证明「这一次真的走了兜底」，不然页面要是仍被判成白底，midnight + 白底本来就
 * 达标，那条用例会在 bug 还在的时候一样绿。
 */
type Sampled = { ratio: number; bg: RGB; themePaper: RGB };

async function sampleContrast(page: Page, paneSel: string): Promise<Sampled | null> {
  const raw = await page.evaluate(({ sel, box, pageW }) => {
    // 两栏的页行都带 data-pdf-page / data-pdf-layer，必须先限到右栏：不限的话
    // querySelector 命中的是文档序在前的**左栏**那一行，里面既没有右格 canvas 也没有译文块。
    const row = document.querySelector(
      `${sel} [data-pdf-pane="right"] [data-pdf-layer="stable"] [data-pdf-page="1"]`,
    );
    const block = row?.querySelector('[data-translation-block]') as HTMLElement | null;
    const right = row?.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement | null;
    if (!block || !right || right.width === 0) return null;
    const S = right.width / pageW; // 位图像素 / pt，同其余用例的换算
    const cx = Math.round((box.x + box.w / 2) * S);
    const cy = Math.round((box.y + box.h / 2) * S);
    const d = right.getContext('2d')!.getImageData(cx, cy, 1, 1).data;
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const pctx = probe.getContext('2d')!;
    pctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-paper').trim();
    pctx.fillRect(0, 0, 1, 1);
    const p = pctx.getImageData(0, 0, 1, 1).data;
    return {
      inkCss: getComputedStyle(block).color,
      bg: [d[0], d[1], d[2]] as [number, number, number],
      themePaper: [p[0], p[1], p[2]] as [number, number, number],
    };
  }, { sel: paneSel, box: CONTRAST_BLOCK, pageW: PAGE_W });
  return raw
    ? { ratio: contrast(parseRgb(raw.inkCss), raw.bg), bg: raw.bg, themePaper: raw.themePaper }
    : null;
}

/**
 * 清晰层里第一张左格 canvas 的 CSS 宽 —— 也就是 `size.w × layer.scale`（react-pdf 对它取过
 * floor）。这是「位图层现在处在哪一档缩放」唯一从外部读得到的协议层事实：读数只反映
 * visualScale（外层 CSS zoom 的分子），位图停在哪一档它是看不出来的。还没定尺寸时返回 0。
 */
async function stableCanvasWidth(page: Page, paneSel: string): Promise<number> {
  return page.evaluate((sel) => {
    const c = document.querySelector(`${sel} [data-pdf-pane="left"] [data-pdf-layer="stable"] canvas`);
    const w = c ? (c as HTMLCanvasElement).style.width : '';
    return w ? parseFloat(w) : 0;
  }, paneSel);
}

/** 清晰层外层的 CSS zoom（= visualScale / layer.scale）。位图与显示同档时它是 1。 */
async function stableLayerZoom(page: Page, paneSel: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const l = document.querySelector(`${sel} [data-pdf-pane="left"] [data-pdf-layer="stable"]`);
    if (!l) return null;
    const z = getComputedStyle(l).zoom;
    return z ? parseFloat(z) : null;
  }, paneSel);
}

/**
 * 发一次 ctrl+wheel 把缩放捏到 `toPct`%。deltaY 按 onWheel 里那个乘法公式
 * （`targetScale.current * (1 - deltaY * ZOOM_SENSITIVITY)`）从当前读数反推，
 * ZOOM_SENSITIVITY 从 zoomSensitivity.ts import，不照抄字面量。
 */
async function pinchTo(page: Page, pdfPath: string, fromPct: number, toPct: number) {
  const deltaY = (1 - toPct / fromPct) / ZOOM_SENSITIVITY;
  await page.evaluate(({ sel, deltaY }) => {
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', {
      ctrlKey: true, deltaY,
      clientX: r.left + r.width / 2, clientY: r.top + 120, bubbles: true, cancelable: true,
    }));
  }, { sel: testIdSelector(`pdf-scroll-${pdfPath}`), deltaY });
}

/**
 * 右栏 stable 层里第 n 页那一行。两栏的页行**都**带 `data-pdf-page` / `data-pdf-layer`
 * （靠外面那层 `[data-pdf-pane]` 区分，见 PdfFileTab 的 renderLayers），所以凡是要找右格的
 * 地方都必须先限到右栏——不限的话命中的是文档序在前的左栏那一行，里面根本没有右格。
 */
function rightRowSel(paneSel: string, n: number): string {
  return `${paneSel} [data-pdf-pane="right"] [data-pdf-layer="stable"] [data-pdf-page="${n}"]`;
}

/** 左栏 stable 层里第 n 页那一行（左格 canvas、标注层都在这里）。 */
function leftRowSel(paneSel: string, n: number): string {
  return `${paneSel} [data-pdf-pane="left"] [data-pdf-layer="stable"] [data-pdf-page="${n}"]`;
}

test.describe('57 · 启动一：进出对照、像素、字号、标注、缩放、排版、主题', () => {
  test.describe.configure({ mode: 'serial' });

  let launched: LaunchedApp;
  let page: Page;
  let projectPath = '';
  // paper.pdf 那个 tab：前六条都在它上面做
  let pdfPath = '';
  let paneSel = '';
  let pane: Locator;
  /** 捏合那条在进对照之前量下的 150% 清晰层左格 canvas CSS 宽；「退出还原」那条拿它当还原目标。 */
  let zoomedW = 0;

  test.beforeAll(async () => {
    launched = await launchKydog({ seed: seedWith(writePaper, writeMono, writeFallbackBg, writeContrast) });
    page = launched.page;
    projectPath = path.join(launched.kydogHome, 'proj');
    pdfPath = path.join(projectPath, PDF_REL);
    paneSel = testIdSelector(`file-pane-${pdfPath}`);
    pane = page.getByTestId(`file-pane-${pdfPath}`);
  });

  test.afterAll(async () => { await teardown(launched); });

  test('57-pdf-dual-pane: 字号测量必须等字体真的到位——先量后到位会被人为延迟当场抓到', async () => {
    // 必须是 paper.pdf 第一次进对照（见文件头）：fitCache 里已经有量好的字号的话，块一挂上就是
    // 缓存值，闸门没开也「已经量完」，下面第一条断言会红在一个跟字体加载无关的地方。
    await openPdf(page, pdfPath);

    // 给 document.fonts.load 包一道**由测试自己开关的闸门**（真实加载照常发生，只是把 "resolve"
    // 这件事扣在闸门后面）——不赌真实加载会不会恰好落在某个时间点上，而是自己造一段"肯定还没
    // 到位"的窗口。实现如果按 spec 内部 await 这个调用，闸门没开之前就不该已经测过；不 await
    // 的话，会在闸门后面就测完并把（可能用了回退字体量出来的）结果写进 state。
    //
    // 早先这里写的是 setTimeout 的定时延迟，判据里就混进了一个墙上时间：enterDual 要等缩放
    // 双缓冲顶替完才返回（settleLayers），慢机上这一段能吃掉一秒以上，延迟不够长时读到的
    // 已经是量完的字号，用例的前提自己先不成立（CI darwin-arm64 实测读到 4.32605px）。
    // 加长延迟只是把这个赌注推远，闸门则彻底不赌：什么时候放行由测试说了算。
    // 放行之后闸门一直开着（包装只剩一层透传），本次启动后面几条照常加载字体。
    await page.evaluate(() => {
      const w = window as unknown as { __releaseFonts?: () => void };
      const orig = document.fonts.load.bind(document.fonts);
      const gate = new Promise<void>((release) => { w.__releaseFonts = release; });
      document.fonts.load = (font: string, text?: string) =>
        orig(font, text).then(async (faces) => { await gate; return faces; });
    });

    await enterDual(page, pane);

    // 朴素占位值按**未缩放的 px**比，不写死「11px」：computed 字号是 fontSize × SIZE_MUL × fit
    // × rasterScale，而 rasterScale 是「块的 CSS 宽 / bbox 宽」，随窗口宽度变。写死 11 等于假定
    // rasterScale 恰好是 1——enterDual 现在会等缩放真正落地（settleLayers），对照里 rasterScale
    // 只有 0.39 上下，朴素值就成了 4.33px，用例会红在一个跟字体加载毫无关系的地方。
    // LONG_ZH 足够长（binary search 门槛之上，见常量定义处的推算），真测过一次之后 fit 必然 ≠ 1，
    // 字号必然偏离这个值——用"偏离朴素值"当作"已经测过"的判据。
    const NAIVE = 11;
    const unscaledPx = () => block1.evaluate((el, w) => {
      const s = el.getBoundingClientRect().width / w;          // = rasterScale
      return s > 0 ? parseFloat(getComputedStyle(el).fontSize) / s : Number.NaN;
    }, TARGET_BLOCK.w);
    // 必须限到 stable 层：进对照会触发一次 fit-width 缩放，缩放期间 stable 与 incoming
    // 两层同时挂在 DOM 里（见 PdfFileTab 的 renderLayers），两层各渲染一份同页的译文块，
    // 不限层就是 strict mode 命中两个元素（CI darwin-arm64 / windows 实测）。本机只是顶替
    // 得快，查询时 incoming 已经走了。
    const block1 = page.locator(`${rightRowSel(paneSel, 1)} [data-translation-block="b1-text"]`);
    await expect(block1).toBeVisible();

    // 闸门未开：字体"到位"这件事被我们扣着。按 spec 先 await 再量的实现，此刻测量还没跑完，
    // 字号应当还是朴素占位值。
    expect(await unscaledPx(), '闸门还没开就不该已经量完——量完了说明没有真的等字体到位就测了')
      .toBeCloseTo(NAIVE, 2);

    // 放行，字体真正就绪
    await page.evaluate(() => (window as unknown as { __releaseFonts?: () => void }).__releaseFonts?.());
    await expect.poll(unscaledPx, { timeout: 15000, message: '放行之后量出真实字号' })
      .not.toBeCloseTo(NAIVE, 2);
  });

  test('57-pdf-dual-pane: 右格拷的是左格位图，译文块与右格底图同坐标系', async () => {
    // 几何（顶对齐、等高、真在另一栏里、左格显式宽）由「同页两格按栏顶对齐」那条用例管，这条只管
    // **画了什么**：右格的位图是不是真从左格拷过来的一份，以及译文 HTML 层是不是压在同一套坐标上。
    // 起点：上一条留下的对照态（paper.pdf 第 1 页在视口里）。

    // 右格确实合成过、且拷的是左格位图：
    // ① 位图尺寸逐字段等于左格 —— 只有合成 effect 会去写它，没跑过就还是 canvas 的固有 300 × 150；
    // ② 那行字所在的矩形里，两格像素逐字节相同、且真有暗像素。这一条同时钉住两件事：
    //    drawImage 真的拷了内容（不是一张空白），以及**没有 target 的块不被填色**
    //    （fixture 把这行字划成了一个无 target 的块，谁把「有没有 target」这条判据丢了，字就没了）。
    await expect.poll(async () => page.evaluate(({ lsel, rsel }) => {
      const l = document.querySelector(`${lsel} canvas`) as HTMLCanvasElement | null;
      const r = document.querySelector(`${rsel} canvas[data-pdf-right]`) as HTMLCanvasElement | null;
      return !!l && !!r && l.width > 0 && r.width === l.width && r.height === l.height;
    }, { lsel: leftRowSel(paneSel, 1), rsel: rightRowSel(paneSel, 1) }),
    { timeout: 10000, message: '等右格合成' }).toBe(true);

    const sample = await page.evaluate(({ lsel, rsel, ink, pageW }) => {
      const l = document.querySelector(`${lsel} canvas`) as HTMLCanvasElement;
      const r = document.querySelector(`${rsel} canvas[data-pdf-right]`) as HTMLCanvasElement;
      const S = l.width / pageW;                                    // 位图像素 / pt
      const box = [ink.x, ink.y, ink.w, ink.h].map((v) => Math.round(v * S)) as [number, number, number, number];
      const a = l.getContext('2d')!.getImageData(...box).data;
      const b = r.getContext('2d')!.getImageData(...box).data;
      let same = true;
      let dark = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) same = false;
        if (b[i] < 128) dark++;
      }
      return { same, dark };
    }, { lsel: leftRowSel(paneSel, 1), rsel: rightRowSel(paneSel, 1), ink: INK, pageW: PAGE_W });
    expect(sample.same, '右格在无 target 的块矩形里应与左格逐字节相同').toBe(true);
    expect(sample.dark, '右格那行原文应当还在（有暗像素）').toBeGreaterThan(0);

    // 译文 HTML 层压在底图上的位置。顶对齐那条用例量的都是两块 canvas 之间的关系，不涉及
    // HTML 层——TranslationBlocks 若用了与 RightPage 不同的缩放算块矩形，那几条照样全绿，
    // 而屏幕上是「译文没盖在原文上」。这条把 HTML 块的框换算到**右格 canvas 自己的坐标系**里
    // 比：RightPage 的 fillRect 用的正是同一组 `b.x × S`（S = 位图宽 / 页宽），所以钉住「HTML
    // 层与这块 canvas 同坐标系」就等于钉住「块正好落在那个填色矩形里」（填色还按 BLOCK_PAD
    // 向外扩了一点点，是有意的余量，不影响这条判据）。
    const overlap = await page.evaluate(({ rsel, box, pageW, lead }) => {
      const row = document.querySelector(rsel);
      if (!row) return null;
      const right = row.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement;
      const block = row.querySelector('[data-translation-block="b1-text"]') as HTMLElement | null;
      if (!block) return null;
      const rr = right.getBoundingClientRect();
      const br = block.getBoundingClientRect();
      const perPt = rr.width / pageW;          // CSS px / pt，全部从这块 canvas 自己推
      // 块 div 已经按 blockFrame 上移半个 LEAD、加高一个 LEAD（首尾半行距放到块外）：块自己的
      // fontSize style 就是 fontPt × rasterScale，与 perPt 同一套缩放，直接拿来反推同样的偏移，
      // 不能再原样拿 TARGET_BLOCK 的矩形去比。
      const fontPx = parseFloat(block.style.fontSize);
      return {
        dx: Math.abs(br.left - (rr.left + box.x * perPt)),
        dy: Math.abs(br.top - (rr.top + box.y * perPt - (lead / 2) * fontPx)),
        dw: Math.abs(br.width - box.w * perPt),
        dh: Math.abs(br.height - (box.h * perPt + lead * fontPx)),
      };
    }, { rsel: rightRowSel(paneSel, 1), box: TARGET_BLOCK, pageW: PAGE_W, lead: LEAD });
    expect(overlap, '第 1 页应当有那个有 target 的译文块').not.toBeNull();
    // 容差 1.5 px：canvas 的 CSS 宽被 react-pdf floor 过，用它反推的 perPt 与块自己用的
    // rasterScale 相差最多 1/595，落到 460 pt 宽的块上不到 0.8 px。缩放算错的话差的是几十上百 px。
    for (const [k, v] of Object.entries(overlap!)) {
      expect(v, `译文块与右格底图同坐标系：${k}`).toBeLessThan(1.5);
    }
  });

  test('57-pdf-dual-pane: 左栏可标注，右格内没有标注层', async () => {
    // 起点：仍是 paper.pdf 的对照态，此前没有画过任何标注。
    await pane.getByTestId('pdf-tool-highlight').click();

    const layer = pane.getByTestId('pdf-annotation-layer-1');
    const box = (await layer.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 21, { steps: 8 });
    await page.mouse.up();
    await expect(pane.locator('[data-annotation-id]')).toHaveCount(1);

    // 选择器必须限定在右格子树内——左格有标注，全局（或只限定到 pane 根）查一定命中，
    // 测不出「右格是不是真的没有标注层」这件事。`[data-pdf-page]` 两栏都有，先限到右栏。
    const rightCell = pane
      .locator('[data-pdf-pane="right"] [data-pdf-page="1"] [data-pdf-right="1"]')
      .locator('xpath=..');
    // 先证明右格这个定位器真的找得到那一格：找不到的话下面的 toHaveCount(0) 恒真。
    await expect(rightCell, '右栏第 1 页的右格应当在').toHaveCount(1);
    await expect(rightCell.locator('[data-annotation-id]')).toHaveCount(0);

    // 收尾：工具切回选择，后面几条按 L、点滚动容器时不带着高亮笔。
    await pane.getByTestId('pdf-tool-select').click();
  });

  test('57-pdf-dual-pane: 捏合过之后再按 L，不拿陈旧锚点把视图弹回去', async () => {
    // 这条守的是「改缩放的路径必须走同一个入口」：进/出对照也是一次缩放改动，既要显式清掉上一次
    // 捏合留下的回算锚点，也要排一次清晰层提交。现有那条 fit-width 用例的顺序是「进对照 → 捏合」，
    // 从不在捏合之后再切 dual，而那正是唯一能撞上陈旧锚点的顺序。
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));
    const readout = pane.getByTestId('pdf-readout');

    // 0. 起点：前几条留下的对照态。先退出，让缩放还原回打开时的 100%——下面断言精确的「150%」，
    //    pinchTo 的 deltaY 从读数反推，读数得正好就是 visualScale 本身，不能带取整误差。
    //    再等还原那一次清晰层提交落地，免得捏合与它交错。
    await exitDual(page, pane);
    await expect(readout, '退出对照应当把缩放还原回打开时的 100%').toContainText('· 100%');
    await expect.poll(
      () => stableLayerZoom(page, paneSel),
      { timeout: 15000, message: '等退出对照后的清晰层提交，外层 zoom 收敛回 1' },
    ).toBeCloseTo(1, 2);

    // 1. 先捏合一次（这一步才会写下 zoomAnchor），等新层顶替
    const startPct = readoutPct((await readout.textContent())!);
    await pinchTo(page, pdfPath, startPct, 150);
    await expect(readout).toContainText('150%');
    await expect.poll(
      () => stableCanvasWidth(page, paneSel),
      { timeout: 15000, message: '等捏合后的新层顶替' },
    ).toBeGreaterThan(PAGE_W);
    // 顺手把 150% 这一档的位图宽记下来，给下一条「退出还原」当还原目标（外层 zoom 回到 1 才说明
    // 这一档的位图画完了，量到的不是中间值）。
    await expect.poll(
      () => stableLayerZoom(page, paneSel),
      { timeout: 15000, message: '等 150% 的清晰层提交，外层 zoom 收敛回 1' },
    ).toBeCloseTo(1, 2);
    zoomedW = await stableCanvasWidth(page, paneSel);

    // 2. 滚到中间某页——锚点里存的是**捏合那一刻**的滚动位置，与这里差得越远，被它回算一次的
    //    后果越明显（实测是夹到 0，即整个视图弹回第 1 页）。
    await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight * 0.55; });
    await expect(readout).not.toContainText(`1 / ${PAGES}`);
    const beforeTop = await scroll.evaluate((el) => el.scrollTop);
    expect(beforeTop).toBeGreaterThan(0);

    // 3. 按 L 进对照
    await enterDual(page, pane);

    // 滚动位置只该被「内容变矮了」这件事影响（浏览器把 scrollTop 夹到新的最大值），不该被任何
    // 锚点回算改写。陈旧锚点那条路算出来的是负数，会被夹成 0 —— 视图弹回第 1 页。
    //
    // 判据不能写成「等于 `Math.min(beforeTop, scrollHeight − clientHeight)`」：`scrollHeight`
    // 与 `clientHeight` 都是**取整过**的整数属性，它们的差与浏览器内部真正拿来夹取的那个分数
    // 上界最多能差 1 px（两边各 0.5），而 `scrollTop` 是分数。拿整数差当目标，就只能靠放宽容差
    // 去吃掉那道取整——那是阈值，不是判据。
    //
    // 改成断**性质**：一次夹取只有两种合法结果 —— 内容还够高，位置原地不动（`top === beforeTop`）；
    // 不够高，位置正好落在新的上界上（`atMax`，判据是「再往下推一大截也不动」，这是浏览器自己
    // 的夹取，不经过任何取整）。而且无论哪种，位置**只可能变小**：夹取不会把 scrollTop 推大。
    // 陈旧锚点那条路算出来的是负数、被夹成 0，三条里前两条都不满足。
    const after = await scroll.evaluate((el) => {
      const top = el.scrollTop;
      el.scrollTop = top + 1e6;              // 已经在上界上的话这一句什么都不会改变
      const atMax = el.scrollTop === top;
      if (!atMax) el.scrollTop = top;        // 没到头就原样还回去
      return { top, atMax };
    });
    expect(after.top, '按 L 之后不该弹回文档开头').toBeGreaterThan(0);
    expect(after.top, '夹取只会把 scrollTop 变小，不会变大').toBeLessThanOrEqual(beforeTop);
    expect(
      after.atMax || after.top === beforeTop,
      `按 L 之后 scrollTop 只该被新的滚动上界夹一下，不该被锚点回算改写 ${JSON.stringify({ beforeTop, ...after })}`,
    ).toBe(true);

    // 提交也必须排上：位图层收敛到新缩放之后，外层 CSS zoom（visualScale / layer.scale）回到 1。
    // 不排提交的话它会一直停在 fit / 上一次捏合的比值上（实测约 0.5），画面一直糊着。
    await expect.poll(
      () => stableLayerZoom(page, paneSel),
      { timeout: 15000, message: '等进对照后的清晰层提交，外层 zoom 收敛回 1' },
    ).toBeCloseTo(1, 2);
  });

  test('57-pdf-dual-pane: 进入对照时按需 fit-width，退出还原（连位图层一起还原）', async () => {
    // 起点：上一条从 150% 进的对照；zoomedW 是它进对照前清晰层左格 canvas 的 CSS 宽。
    //
    // 读数那一半（进对照读数变小、退出读数回原值、放得下就不存还原请求）由
    // pdfTranslationStore.test.ts 的 prevScale 一组与 splitPane.test.ts 的 fitToNarrower 守着。
    // 这里只守单测看不见的**位图层**：读数回到进入前只说明 CSS zoom 那个数字回来了——位图层若停在
    // fit 那一档，画面就是被放大好几倍显示的糊图，而且在用户下一次捏合之前不会自愈。
    expect(zoomedW, '上一条应当已经量过 150% 那一档的清晰层宽').toBeGreaterThan(PAGE_W);

    // 位图层跟着进对照的 fit-width 降下来了（那一次缩放同样排了提交）。这是下面「还原」的正向前提：
    // 位图层若压根没动过，「回到 zoomedW」恒真，测不出还原。
    await expect.poll(
      () => stableCanvasWidth(page, paneSel),
      { timeout: 15000, message: '等进对照后的清晰层提交' },
    ).toBeLessThan(zoomedW);

    // 退出：判据取协议层事实，清晰层左格 canvas 的 CSS 宽（= size.w × layer.scale）必须回到
    // 进对照前那个值。
    await exitDual(page, pane);
    await expect.poll(
      () => stableCanvasWidth(page, paneSel),
      { timeout: 15000, message: '等退出对照后的清晰层提交' },
    ).toBe(zoomedW);
  });

  test('57-pdf-dual-pane: 自动退出也还原缩放，且与收掉 dual 落在同一次 commit 里', async () => {
    // 两件事一起守。
    //
    // 一是**自动退出也要还原**：边车换了版本（focus 重探撞见 mismatch）时 setLoaded 会把 dual
    // 收掉，用户没按过任何键，缩放不还原就被丢在双栏的 fit-width 小画面上。
    //
    // 二是**还原的时机**：收掉 dual 的那次 commit 已经把版面画成「单栏 + 还没还原的小缩放」，
    // 还原必须落在同一次 commit 里，中间隔一次渲染机会用户就会看到一帧小画面再跳回去。
    //
    // 同任务这条今天由两条协议层事实保证，不靠 effect 用哪一种：zustand 读值走
    // useSyncExternalStore，React 的 forceStoreRerender 无条件用 SyncLane；而 commit 末尾会对
    // SyncLane 那批更新同步冲刷 passive effect（react-dom-client 里
    // `0 !== (pendingEffectsLanes & 3) && flushPendingEffects()`）。所以 useEffect 与
    // useLayoutEffect 在这条路径上观察不出差别（两种写法都实测过）。这条用例守的是那个**结果**：
    // 还原一旦退化成晚一个任务（改用 setTimeout / rAF，或还原不再由那个 effect 负责），它就红。
    //
    // 观测手段是 MutationObserver：它的回调是**微任务**，排在「产生这批 DOM 改动的那个任务」的
    // 微任务检查点上，一定早于任何后续宏任务。所以「看到右格消失的那一批 mutation 时外层 zoom
    // 已经是还原后的值」等价于「两次改动同任务、中间没有渲染机会」。不看帧、不赌毫秒。
    //
    // 这条会改坏 paper.pdf 的边车，是 paper.pdf 的最后一步（见文件头）。
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));
    const readout = pane.getByTestId('pdf-readout');

    // 起点：上一条退出对照后的单栏 150%，停在文档中段。先回到开头：下面拿**整条读数**（含页码）
    // 比「还原回进入前」，从第 1 页进出，页码不随夹取变。再等清晰层落在 150% 这一档。
    await scroll.evaluate((el) => { el.scrollTop = 0; });
    await expect(readout).toContainText(`1 / ${PAGES}`);
    await expect.poll(
      () => stableLayerZoom(page, paneSel),
      { timeout: 15000, message: '等单栏的清晰层提交，外层 zoom 收敛回 1' },
    ).toBeCloseTo(1, 2);
    const before = await readout.textContent();
    // 进对照前的位图宽。起点不是 100%，自动退出那一刻的外层 zoom（= 还原后的 visualScale /
    // 对照时的 layer.scale）就不是 PAGE_W / duringW，而是这个宽 / duringW——两个宽都是
    // `size.w × layer.scale`，比值就是两档缩放之比。
    const beforeW = await stableCanvasWidth(page, paneSel);
    expect(beforeW, '起点应当是上一条还原回来的 150% 那一档').toBeGreaterThan(PAGE_W);

    await enterDual(page, pane);
    // 提交收敛之后位图与显示同档、外层 zoom 回到 1——下面的判据就建立在这个前提上：还没还原时
    // zoom 恒为 1，还原了就是 beforeW / duringW。fit 不猜数字，从协议层事实现推：对照期间清晰层
    // 左格 canvas 的 CSS 宽就是 size.w × layer.scale。
    await expect.poll(
      () => stableLayerZoom(page, paneSel),
      { timeout: 15000, message: '等进对照后的清晰层提交，外层 zoom 收敛回 1' },
    ).toBeCloseTo(1, 2);
    const duringW = await stableCanvasWidth(page, paneSel);
    expect(duringW, '对照期间左格 canvas 应当已经定好 CSS 尺寸').toBeGreaterThan(0);

    // 把边车的 source.sha256 改成对不上的值：下一次重探 checkVersion 判 mismatch，setLoaded
    // 自动收 dual。边车本身仍是合法 JSON——要走的是 mismatch 那条路，不是 loadError。
    const zhPath = path.join(projectPath, ZH_REL);
    const zh = JSON.parse(await fs.readFile(zhPath, 'utf8')) as { source: { sha256: string } };
    zh.source.sha256 = 'f'.repeat(64);
    await fs.writeFile(zhPath, JSON.stringify(zh, null, 2));

    // 装观察者与发 focus 在同一次 evaluate 里：重探要走一个 IPC 往返，绝无可能在这中间落地，
    // 「观察者先就位」因此是确定的，不靠抢时间窗口。
    await page.evaluate((sel) => {
      const w = window as unknown as { __kydogExitZoom?: number | null };
      w.__kydogExitZoom = null;
      const paneEl = document.querySelector(sel);
      if (!paneEl) throw new Error('找不到 PDF pane');
      const obs = new MutationObserver(() => {
        if (w.__kydogExitZoom != null) return;
        if (paneEl.querySelectorAll('[data-pdf-right="1"]').length > 0) return; // 还没收掉
        const layer = paneEl.querySelector('[data-pdf-layer="stable"]');
        if (!layer) return;
        w.__kydogExitZoom = parseFloat(getComputedStyle(layer).zoom);
        obs.disconnect();
      });
      obs.observe(paneEl, { childList: true, subtree: true, attributes: true });
      window.dispatchEvent(new Event('focus'));
    }, paneSel);

    await expect(pane.locator('[data-pdf-right="1"]')).toHaveCount(0);
    await expect(pane.getByText(/另一个版本的 PDF/)).toBeVisible();
    await expect(readout, '自动退出也要把缩放还原回进入对照前').toHaveText(before!);

    const zoomAtExit = await page.evaluate(
      () => (window as unknown as { __kydogExitZoom?: number | null }).__kydogExitZoom,
    );
    expect(zoomAtExit, '没抓到「右格消失」那一批 mutation').not.toBeNull();
    expect(zoomAtExit!, '自动退出的还原必须与收掉 dual 落在同一次 commit 里，不能晚一个任务')
      .toBeCloseTo(beforeW / duringW, 1);
  });

  test('57-pdf-dual-pane: 含 inline-code 的块，量的和画的是同一套排版——不溢出', async () => {
    // 测量宿主与渲染必须同一套 span 结构（同一份 SEG_STYLE），且要等 --font-mono 那条栈到位。
    // 用纯文本量的话，inline-code 段按 serif 的宽度算行数，画出来却是等宽字体：行数变多，
    // 「刚好装下」的比例一渲染就溢出成块内滚动条——而 spec 的立场是溢出只在收到下限 0.5 仍
    // 装不下时才允许发生。这段文本离下限远得很（见 MONO_CODE 处的推算）。
    // 新开一个 tab：fitCache 按 tab 分域，这份文档是第一次量。
    const monoPath = path.join(projectPath, MONO_REL);
    const monoSel = testIdSelector(`file-pane-${monoPath}`);
    const monoPane = await openPdf(page, monoPath);
    await enterDual(page, monoPane);

    // 限到 stable 层。缩放双缓冲期间两层各渲染一份同页的块，不限层这条 toHaveCount(1)
    // 会红在 2 上，而红的原因跟这条用例要验的排版一致性毫无关系。
    const block = page.locator(`${rightRowSel(monoSel, 1)} [data-translation-block="m1"]`);
    await expect(block).toHaveCount(1);
    // 等测量真的落地：把 computed 字号除掉 rasterScale（= 块的 CSS 宽 / bbox 宽）还原成
    // 「未缩放的 px」，它小于 11（= b.fontSize × SIZE_MUL('text')）才说明 fit 已经收下来了。
    // 不能直接拿 computed 字号跟 11 比：对照里 rasterScale 只有 0.6 上下，朴素占位值本来就是
    // 6.6px，那样比是恒真的，会在测量落地之前就放行（fit 仍是占位的 1，块当然「装得下」）。
    await expect.poll(
      async () => block.evaluate((el, bboxW) => {
        const s = el.clientWidth / bboxW;
        return s > 0 ? parseFloat(getComputedStyle(el).fontSize) / s : 99;
      }, MONO_BLOCK.w),
      { timeout: 15000, message: '等字号测量落地（这段文本按 mono 量必然要收缩，见 MONO_CODE 处推算）' },
    ).toBeLessThan(11);

    // 失败时把这几个数一并印出来：光看 scrollH > clientH 分不清是「测量用错了字体」还是
    // 「这段文本连收到下限也装不下」。
    const box = await block.evaluate((el) => ({
      scrollH: el.scrollHeight, clientH: el.clientHeight, clientW: el.clientWidth,
      chars: (el.textContent ?? '').length, fontSize: getComputedStyle(el).fontSize,
    }));
    expect(box.chars, '块里得真有那段代码文本').toBeGreaterThan(600);
    // 块高按 fixture 自己的宽高比推，不写死像素：clientW / MONO_BLOCK.w 就是这一格的
    // rasterScale，块高该是 MONO_BLOCK.h 乘同一个数。写死 50 是拿本机窗口的 rasterScale
    // 当常量——CI darwin-arm64 的主面板窄，rasterScale 更小，量到 49 就红了（那不是缺陷，
    // 是窗口窄）。留一成余量给 blockFrame 的行距增减与像素取整。
    const expectH = box.clientW * (MONO_BLOCK.h / MONO_BLOCK.w);
    expect(box.clientH, `块高应当是 bbox 高按同一 rasterScale 缩下来那个量级 ${JSON.stringify({ box, expectH })}`)
      .toBeGreaterThan(expectH * 0.9);
    // 判据：溢出不得超过**一行**。这条用例抓的是「测量用 serif、渲染用 mono」那类错——字族一分家
    // 行数就差好几行，溢出是块高的量级。而「一行以内」是这套测量方式自带的边界，不是缺陷的信号：
    // measureFit 按**未缩放**的 b.width 与 px 量（刻意的，见该函数注释：这样 fit 与缩放无关、
    // 只算一次进缓存），渲染却在 b.width × rasterScale 上画。缩放很小时同一段文本在 460 px 宽、
    // 10 px 字下的断行，与在 166 px 宽、3.6 px 字下的断行会差一行——字形前进宽度的亚像素取整
    // 不按比例走。CI darwin-arm64 实测：clientW 166 时溢出 5 px，而一行正好 5.4 px；本机
    // clientW 181 时一点不溢出。两边字号完全相同（3.61631px），所以不是排版分家。
    //
    // 这个边界记在 docs/superpowers/specs 的对照壳 spec 里。要彻底消掉它，得让 measureFit 按
    // 渲染时的实际像素量（fitCache 随之要按 rasterScale 分桶），代价是缩放时译文会重排——那是
    // 另一期的取舍，不在本轮。
    const oneLine = LINE_HEIGHT * parseFloat(box.fontSize);
    expect(box.scrollH - box.clientH, `含 inline-code 的块溢出超过一行 = 测量与渲染没用同一套排版 ${JSON.stringify({ ...box, oneLine })}`)
      .toBeLessThanOrEqual(oneLine);
  });

  test('57-pdf-dual-pane: 页背景取不到时，墨色按实际填下去的兜底底色推——不是按白底', async () => {
    // 下面那条对比度用例的两份 fixture 都是整页纯色，八点取样恒能取到，走的全是 pageBackground()
    // **取得到**的那条路。这条补的是**取不到**的那条：RightPage 退回去填主题纸色，而墨色若仍
    // 按白底推，midnight（--color-paper 是深蓝灰）下就是近黑字压深蓝灰，约 1.4:1。
    // 排在对比度那条前面：两条都要 midnight，下一条接着这个主题做白页、再切 vellum 做深色页。
    const fbPath = path.join(projectPath, FALLBACK_REL);
    const sel = testIdSelector(`file-pane-${fbPath}`);

    await setTheme(page, 'midnight');
    const fbPane = await openPdf(page, fbPath);
    await enterDual(page, fbPane);
    await expect.poll(
      () => sampleContrast(page, sel),
      { timeout: 10000, message: 'midnight + 取不到页背景：等右格合成、译文块着色' },
    ).not.toBeNull();

    const s = (await sampleContrast(page, sel))!;
    // ① 这一次确实走了兜底：块矩形里填的是主题纸色，不是页面本身的白。缺了这条，页面万一
    //    仍被判成白底，「midnight + 白底」本来就达标，整条用例在 bug 还在时也会绿。
    expect(s.themePaper, 'midnight 的 --color-paper 不该解析成白（否则这条用例区分不了两条路径）')
      .not.toEqual([255, 255, 255]);
    expect(s.bg, '块矩形里应当填的是主题纸色 —— 即八点取样确实没取到统一背景色').toEqual(s.themePaper);
    // ② 墨色按①里那个实际底色推，对比度达标
    expect(s.ratio, 'midnight 主题 + 取不到页背景：译文块对比度应 ≥ 4.5:1').toBeGreaterThanOrEqual(4.5);
  });

  test('57-pdf-dual-pane: 两组主题 × 背景的对比度达标——墨色由背景推导，不跟应用主题', async () => {
    // design spec §13：「两组主题 × 背景的对比度达标」是墨色由实际背景推导（Task 7 的
    // inkForBackground）这条核心主张唯一的端到端验证——单测只验了 contrast()/inkForBackground()
    // 这两个纯函数本身，没有任何东西证明它们真的接到了 RightPage 探测出的背景、真的绕过了
    // --color-ink 那条会跟主题走的默认路径。两组刻意选成会互相冲突的搭配：midnight 主题的
    // --color-ink 接近白，压在白页上先天就低对比度；vellum 主题的 --color-ink 接近黑，压在
    // 深色页上同样先天低对比度——如果实现退化成读 --color-ink，这两组里至少有一组会红。
    const whitePath = path.join(projectPath, CONTRAST_WHITE_REL);
    const darkPath = path.join(projectPath, CONTRAST_DARK_REL);

    // 上一条已经切到 midnight；这里照样再选一次，这条自己的前提写在自己身上。
    await setTheme(page, 'midnight');
    const whitePane = await openPdf(page, whitePath);
    await enterDual(page, whitePane);
    const whiteSel = testIdSelector(`file-pane-${whitePath}`);
    await expect.poll(
      () => sampleContrast(page, whiteSel),
      { timeout: 10000, message: 'midnight + 白页：等右格合成、译文块着色' },
    ).not.toBeNull();
    const whiteContrast = await sampleContrast(page, whiteSel);
    expect(whiteContrast, 'midnight 主题 + 白底 PDF：译文块对比度应 ≥ 4.5:1').not.toBeNull();
    expect(whiteContrast!.ratio, 'midnight 主题 + 白底 PDF：译文块对比度应 ≥ 4.5:1').toBeGreaterThanOrEqual(4.5);

    await setTheme(page, 'vellum');
    const darkPane = await openPdf(page, darkPath);
    await enterDual(page, darkPane);
    const darkSel = testIdSelector(`file-pane-${darkPath}`);
    await expect.poll(
      () => sampleContrast(page, darkSel),
      { timeout: 10000, message: 'vellum + 深色页：等右格合成、译文块着色' },
    ).not.toBeNull();
    const darkContrast = await sampleContrast(page, darkSel);
    expect(darkContrast, 'vellum 主题 + 深色页 PDF：译文块对比度应 ≥ 4.5:1').not.toBeNull();
    expect(darkContrast!.ratio, 'vellum 主题 + 深色页 PDF：译文块对比度应 ≥ 4.5:1').toBeGreaterThanOrEqual(4.5);
  });
});

// ── 分栏（spec v8 §3.1）：两个滚动容器 + 同步 ───────────────────────────────────────────

type PaneRow = {
  page: string;
  sized: boolean;
  dTop: number | null;
  dHeight: number | null;
  /** 右格 canvas 的左边缘是否真的落在左栏容器右边缘之外（= 在另一栏里，不是叠在左格上）。 */
  separated: boolean | null;
  dLeftCell: number | null;
};

/**
 * **按栏**比同一页的两格几何：左栏 stable 层里每个已挂载的行 n，配右栏 stable 层的行 n。
 *
 * 与旧的 rowGeometry 的差别就是这一条——两格不再在同一个 flex 行里（spec v8 §3.1 推翻了原
 * §3.1），「同一行里找另一格」的写法从此找不到东西。顶对齐现在由两件事共同保证：两栏行几何逐
 * 字段相同（同一份 sizes / layer.scale / PAGE_GAP / PAGE_PAD，行宽都是一页宽），以及滚动同步。
 *
 * `dLeftCell` 仍守左格那个 div 的**显式宽度**：它写的是未取整的 `size.w × layer.scale`，而不是
 * 让它收缩到内容宽（那会取 canvas 的 CSS 宽，react-pdf 对它取过 floor）。这个宽度是标注层的
 * 坐标基准（PdfAnnotationLayer 用 inset:0 贴上去），少 1 px 就会把整页高亮悄悄平移。判据里的
 * scale 从**行宽**现推（行宽 = `页宽 × layer.scale`，同样未取整），不从 canvas 宽推——那个数
 * 正是被 floor 过的那个，拿它当基准就等于把要测的东西当成了标尺。
 */
async function paneRowGeometry(page: Page, paneSel: string, pageW: number): Promise<PaneRow[]> {
  return page.evaluate(({ sel, pageW }) => {
    const leftPane = document.querySelector(`${sel} [data-pdf-pane="left"]`);
    const rightPane = document.querySelector(`${sel} [data-pdf-pane="right"]`);
    if (!leftPane || !rightPane) return [];
    const paneRight = leftPane.getBoundingClientRect().right;
    const rows = Array.from(
      leftPane.querySelectorAll('[data-pdf-layer="stable"] [data-pdf-page][data-pdf-mounted="1"]'),
    );
    return rows.map((row) => {
      const n = (row as HTMLElement).dataset.pdfPage ?? '?';
      const mate = rightPane.querySelector(`[data-pdf-layer="stable"] [data-pdf-page="${n}"]`);
      const left = row.querySelector('canvas:not([data-pdf-right])') as HTMLCanvasElement | null;
      const right = mate?.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement | null;
      const lr = left?.getBoundingClientRect();
      const rr = right?.getBoundingClientRect();
      const cell = left?.parentElement?.getBoundingClientRect();
      const rowW = row.getBoundingClientRect().width;
      const rowScale = rowW / pageW;
      return {
        page: n,
        // react-pdf 要等自己的 effect 跑过才给左格 canvas 写 CSS 尺寸；在那之前它是
        // 300 × 150 的固有尺寸，量出来的差值没有意义。sized 把「还没定尺寸」与「没对齐」分开。
        sized: !!left && left.style.width !== '' && !!right,
        dTop: lr && rr ? Math.abs(lr.top - rr.top) : null,
        dHeight: lr && rr ? Math.abs(lr.height - rr.height) : null,
        separated: rr ? rr.left > paneRight : null,
        dLeftCell: cell ? Math.abs(cell.width - pageW * rowScale) : null,
      };
    });
  }, { sel: paneSel, pageW });
}

/** 一栏的滚动状态。maxTop / maxLeft 是这一栏自己的滚动上界，用来先确认「有得滚」再断言同步。 */
async function paneScroll(page: Page, paneSel: string, which: 'left' | 'right') {
  return page.evaluate(({ sel, which }) => {
    const el = document.querySelector(`${sel} [data-pdf-pane="${which}"]`) as HTMLElement | null;
    if (!el) return null;
    return {
      top: el.scrollTop, left: el.scrollLeft,
      maxTop: el.scrollHeight - el.clientHeight,
      maxLeft: el.scrollWidth - el.clientWidth,
    };
  }, { sel: paneSel, which });
}

async function setPaneScroll(
  page: Page, paneSel: string, which: 'left' | 'right', axis: 'top' | 'left', value: number,
) {
  await page.evaluate(({ sel, which, axis, value }) => {
    const el = document.querySelector(`${sel} [data-pdf-pane="${which}"]`) as HTMLElement;
    if (axis === 'top') el.scrollTop = value; else el.scrollLeft = value;
  }, { sel: paneSel, which, axis, value });
}

/**
 * 两栏当前的 `scrollLeft`，外加「再往右推一大截还动不动」。
 *
 * 「到头了没有」不取 `scrollWidth − clientWidth`：那是两个**取整过**的整数属性之差，与浏览器
 * 内部真正拿来夹取的那个分数上界最多能差 1 px（两边各 0.5），而 `scrollLeft` 是分数——拿整数差
 * 当目标就只能靠放宽容差去吃掉那道取整，那是阈值不是判据。这里直接问浏览器：已经在上界上的话，
 * 再写一个更大的值进去位置一动不动（也就不会派发 scroll 事件，同步链路察觉不到这次探测）。
 */
async function paneLeftAtMax(page: Page, paneSel: string) {
  return page.evaluate((sel) => {
    const q = (w: string) => document.querySelector(`${sel} [data-pdf-pane="${w}"]`) as HTMLElement;
    const probe = (el: HTMLElement) => {
      const at = el.scrollLeft;
      el.scrollLeft = at + 1e6;
      const atMax = el.scrollLeft === at;
      if (!atMax) el.scrollLeft = at;
      return { at, atMax };
    };
    return { left: probe(q('left')), right: probe(q('right')) };
  }, paneSel);
}

/**
 * 两栏的 **border-box** 宽（getBoundingClientRect）与 wrapper 的宽。
 *
 * 不用 `clientWidth`：`.ky-scroll` 在 Chromium 下是**占位**滚动条，clientWidth 比 border-box
 * 少一条滚动条的厚度（Task 2 实测 120 vs 112）。而 paneWidths / clampSplit 里的 MIN_PANE_PX、
 * 拖动位移说的都是 border-box 那个宽，两者不能混用。
 */
async function paneBoxWidths(page: Page, paneSel: string) {
  return page.evaluate((sel) => {
    const q = (w: string) => document.querySelector(`${sel} [data-pdf-pane="${w}"]`) as HTMLElement | null;
    const l = q('left');
    const r = q('right');
    if (!l || !r) return null;
    // 左栏现在是 `<左栏相对定位父层><滚动容器 data-pdf-pane="left">`（OverlayScrollbar 的锚点，
    // Task 2）。两栏 + 分隔线共同的 flex 行是再上一层——wrap 量的是那一层，不是刚好等宽左栏的
    // 那个新父层。
    const wrap = l.parentElement!.parentElement!.getBoundingClientRect();
    return {
      left: l.getBoundingClientRect().width,
      right: r.getBoundingClientRect().width,
      wrapLeft: wrap.left,
      wrapRight: wrap.right,
      wrapWidth: wrap.width,
    };
  }, paneSel);
}

/** 分隔线命中区的中心（视口坐标）。 */
async function dividerCenter(pane: Locator) {
  const box = (await pane.getByTestId('pdf-pane-divider').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width };
}

/**
 * 在指定的那一栏上发一次 ctrl+wheel。onWheel 的 focal 是相对 `closest('[data-pdf-pane]')` 量的，
 * 所以派发目标必须是那一栏本身（`bubbles: true`，监听挂在 wrapper 上）。`fx` / `fy` 是相对该栏
 * 视口左上角的偏移，也就是实现里那个 focal。deltaY 的反推同 pinchTo。
 */
async function pinchOnPane(
  page: Page, paneSel: string, which: 'left' | 'right',
  fromPct: number, toPct: number, fx: number, fy: number,
) {
  const deltaY = (1 - toPct / fromPct) / ZOOM_SENSITIVITY;
  await page.evaluate(({ sel, which, deltaY, fx, fy }) => {
    const el = document.querySelector(`${sel} [data-pdf-pane="${which}"]`) as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', {
      ctrlKey: true, deltaY,
      clientX: r.left + fx, clientY: r.top + fy, bubbles: true, cancelable: true,
    }));
  }, { sel: paneSel, which, deltaY, fx, fy });
}

/**
 * 「这一栏视口里 (fx, fy) 那一点，压着页面内容的哪个 pt 坐标」。
 *
 * 拿第 1 页那张 canvas 的 rect 当标尺：它**就是**那一页，横跨整页宽、纵贯整页高，所以
 * `(clientX − rect.left) / rect.width × 页宽` 就是内容坐标本身。这与 spec 说的
 * `(scrollLeft + focal.x) / scale` 是同一个量，但不经过 scrollLeft、CSS zoom、layer.scale 任何
 * 一个中间量去拼——也因此不受 react-pdf 对 canvas CSS 宽取 floor 的影响：floor 同时缩在 left 与
 * width 上，比值不变。点落在 canvas 之外时是线性外推，仍是定义良好的内容坐标。
 */
async function contentPtUnder(
  page: Page, paneSel: string, which: 'left' | 'right', fx: number, fy: number,
) {
  return page.evaluate(({ sel, which, fx, fy, pageW, pageH }) => {
    const pane = document.querySelector(`${sel} [data-pdf-pane="${which}"]`) as HTMLElement | null;
    const c = pane?.querySelector(
      '[data-pdf-layer="stable"] [data-pdf-page="1"] canvas',
    ) as HTMLElement | null;
    if (!pane || !c) return null;
    const p = pane.getBoundingClientRect();
    const r = c.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: (p.left + fx - r.left) / r.width * pageW,
      y: (p.top + fy - r.top) / r.height * pageH,
    };
  }, { sel: paneSel, which, fx, fy, pageW: PAGE_W, pageH: PAGE_H });
}

test.describe('57 · 启动二：分栏几何、滚动同步、覆盖式滚动条、分隔线', () => {
  test.describe.configure({ mode: 'serial' });

  let launched: LaunchedApp;
  let page: Page;
  let pdfPath = '';
  let paneSel = '';
  let pane: Locator;

  test.beforeAll(async () => {
    launched = await launchKydog({ seed: seedWith(writePaper) });
    page = launched.page;
    pdfPath = path.join(launched.kydogHome, 'proj', PDF_REL);
    paneSel = testIdSelector(`file-pane-${pdfPath}`);
    pane = page.getByTestId(`file-pane-${pdfPath}`);
  });

  test.afterAll(async () => { await teardown(launched); });

  test('57-pdf-dual-pane: 同页两格按栏顶对齐、等高——右格真在另一栏里，滚动与缩放后仍成立', async () => {
    await openPdf(page, pdfPath);
    await enterDual(page, pane);

    const check = async (label: string) => {
      // 先把横向滚回 0：`separated`（右格 canvas 左边缘 > 左栏右边缘）这条在横向滚动过之后
      // 会失真——内容被拉到容器左边缘之外，canvas 的 rect 会伸到右栏左边缘的左侧，那是滚动的
      // 结果，不是「叠在左格上」。横向同步本身由另一条用例断言，这里只要一个确定的横向基准。
      // 纵向不动：滚动之后的对齐正是要测的东西。
      await setPaneScroll(page, paneSel, 'left', 'left', 0);
      await expect.poll(
        async () => {
          const l = await paneScroll(page, paneSel, 'left');
          const r = await paneScroll(page, paneSel, 'right');
          return l?.left === 0 && r?.left === 0;
        },
        { timeout: 5000, message: `${label}：等两栏横向都回到 0` },
      ).toBe(true);

      await expect.poll(
        async () => {
          const g = await paneRowGeometry(page, paneSel, PAGE_W);
          return g.length > 0 && g.every((r) => r.sized);
        },
        { timeout: 15000, message: `${label}：等两栏都定好尺寸` },
      ).toBe(true);
      // 同步有一帧延迟（回声锁在 rAF 里释放，spec v8 §3.1 写明了这份代价），纵向对齐先 poll
      // 到落定；真没同步的话这里超时，紧接着的断言会把实际差值报出来，不会退化成一句超时。
      await expect.poll(
        async () => {
          const g = await paneRowGeometry(page, paneSel, PAGE_W);
          return g.every((r) => (r.dTop ?? Infinity) < 0.5);
        },
        { timeout: 5000, message: `${label}：等两栏纵向同步落定` },
      ).toBe(true);

      const g = await paneRowGeometry(page, paneSel, PAGE_W);
      expect(g.length, `${label}：左栏应当有已挂载的页行`).toBeGreaterThan(0);
      for (const r of g) {
        // 两块 canvas 的 CSS 尺寸出自同一次 `size.h/w * layer.scale`，逐位相同；顶边则靠
        // 「两栏行几何逐字段相同 + scrollTop 相等」。0.5 px 只留给设备像素网格取整。
        expect(r.dTop ?? Infinity, `${label} 第 ${r.page} 页顶边`).toBeLessThan(0.5);
        expect(r.dHeight ?? Infinity, `${label} 第 ${r.page} 页高度`).toBeLessThan(0.5);
        // 只看 top/height 相等的话，右格被绝对定位盖在左格正上方也会全绿（重叠时两者的 top、
        // height 当然也相等）。这条断住「右格真的在另一栏里」：它的左边缘落在左栏容器的右边缘
        // 之外——重叠时会偏出整整一栏的宽度，不是零点几 px 的取整噪声。
        expect(r.separated, `${label} 第 ${r.page} 页右格应当落在左栏之外`).toBe(true);
        // 左格显式宽 == 页宽 × 本层缩放，逐位相等（两边都是同一个未取整的乘法，见
        // paneRowGeometry 注释）。容差 0.05 px：让它收缩到 canvas 内容宽的话，差的是一次
        // floor，非整除缩放下必然远大于这个量级。
        expect(r.dLeftCell ?? Infinity, `${label} 第 ${r.page} 页左格显式宽度`).toBeLessThan(0.05);
      }
    };

    await check('刚进对照');

    // fit-width 必须扣掉纵向滚动条厚度（Important #1，Task 2 审查发现）：栏宽从 wrapper 的
    // border-box 宽算，而栏内容的可用宽是各自的 clientWidth（= border-box − 滚动条占位厚度）。
    // 两栏现在是覆盖式滚动条，bar 恒 0；保留实测是为了判据不依赖这一点。少扣一次的话
    // pageW × fit 会比栏的 clientWidth 宽出这一份厚度，两栏各自长出一条横向滚动条。
    // scrollWidth === clientWidth 是协议层事实（没有横向溢出），不是近似或阈值。
    await expect.poll(
      async () => page.evaluate((sel) => {
        const l = document.querySelector(`${sel} [data-pdf-pane="left"]`) as HTMLElement | null;
        const r = document.querySelector(`${sel} [data-pdf-pane="right"]`) as HTMLElement | null;
        if (!l || !r) return null;
        return { l: l.scrollWidth - l.clientWidth, r: r.scrollWidth - r.clientWidth };
      }, paneSel),
      { timeout: 5000, message: '刚进对照：fit-width 扣了滚动条厚度之后两栏都不该有横向溢出' },
    ).toEqual({ l: 0, r: 0 });

    // 滚几屏：换一批挂载的页，两栏照样对齐
    await page.locator(testIdSelector(`pdf-scroll-${pdfPath}`))
      .evaluate((el) => { el.scrollTop = el.clientHeight * 4; });
    await expect(pane.getByTestId('pdf-readout')).not.toContainText(`1 / ${PAGES}`);
    await check('滚动之后');

    // 捏合放大一档、再缩小一档：两栏共用同一份 layers，layer.scale 也共用，对齐不该因此松掉。
    // 一档溢出栏宽（横向有得滚）、一档窄于栏宽（行被 items-center 居中），两种版面都过一遍。
    for (const pct of [200, 50]) {
      const startPct = readoutPct((await pane.getByTestId('pdf-readout').textContent())!);
      await pinchTo(page, pdfPath, startPct, pct);
      // 判据是「读数确实换了一档」，不钉具体百分比：pinchTo 的 deltaY 从**读数**反推，而读数
      // 是 Math.round(visualScale × 100)，起点因此天生带一位取整误差，落点常常差 1%。钉死它
      // 测的是那道取整，不是这条用例主张的对齐。
      await expect(pane.getByTestId('pdf-readout')).not.toContainText(`· ${startPct}%`);
      await check(`缩放到 ${pct}% 附近之后`);
    }
  });

  test('57-pdf-dual-pane: 两栏滚动同步——纵横两轴、两个方向都互写', async () => {
    // 起点：上一条留下的对照态，缩放在 50% 附近（页宽窄于栏宽，横向暂时没得滚）。
    await expect(pane.getByTestId(`pdf-right-scroll-${pdfPath}`)).toBeVisible();

    // 纵向：左 → 右
    const before = await paneScroll(page, paneSel, 'left');
    expect(before!.maxTop, '这份 fixture 应当有得纵向滚').toBeGreaterThan(300);
    await setPaneScroll(page, paneSel, 'left', 'top', 300);
    await expect.poll(
      async () => (await paneScroll(page, paneSel, 'right'))?.top,
      { timeout: 5000, message: '右栏应当跟到左栏的 scrollTop' },
    ).toBe(300);

    // 纵向：右 → 左（回声锁只吞「刚被写过的那个元素」发出的那一次，不该把这次真实滚动也吞掉）
    await setPaneScroll(page, paneSel, 'right', 'top', 120);
    await expect.poll(
      async () => (await paneScroll(page, paneSel, 'left'))?.top,
      { timeout: 5000, message: '左栏应当跟到右栏的 scrollTop' },
    ).toBe(120);

    // 横向要先有得滚：捏到 200% 附近才溢出。真正的前提是下面这个 maxLeft，不是读数落在哪个
    // 整数上（读数取整会让落点差 1%，见另一条用例的注释）。
    const startPct = readoutPct((await pane.getByTestId('pdf-readout').textContent())!);
    await pinchTo(page, pdfPath, startPct, 200);
    await expect.poll(
      async () => {
        const l = await paneScroll(page, paneSel, 'left');
        const r = await paneScroll(page, paneSel, 'right');
        return Math.min(l?.maxLeft ?? 0, r?.maxLeft ?? 0);
      },
      { timeout: 10000, message: '200% 之后两栏都应当有得横向滚' },
    ).toBeGreaterThan(80);

    // 横向：左 → 右。不等宽时 scrollLeft 也是**原样相等**（两栏内容左边缘对齐，spec v8 §3.1）。
    await setPaneScroll(page, paneSel, 'left', 'left', 80);
    await expect.poll(
      async () => (await paneScroll(page, paneSel, 'right'))?.left,
      { timeout: 5000, message: '右栏应当跟到左栏的 scrollLeft' },
    ).toBe(80);

    // 横向：右 → 左
    await setPaneScroll(page, paneSel, 'right', 'left', 40);
    await expect.poll(
      async () => (await paneScroll(page, paneSel, 'left'))?.left,
      { timeout: 5000, message: '左栏应当跟到右栏的 scrollLeft' },
    ).toBe(40);
  });

  test('57-pdf-dual-pane: 覆盖式滚动条——没有槽、滚动时拇指出现后淡出、拖拇指按同一映射滚且另一栏跟上', async () => {
    // 起点：上一条留下的 200% 附近，两栏纵横两条轴都溢出。

    // ① 没有槽：两栏 clientWidth === offsetWidth、clientHeight === offsetHeight。占位式滚动条
    //    会让 client 比 offset 少一条滚动条的厚度（.ky-scroll 给的是 8px），这两个数是协议层事实。
    //    这条断言测的是「量本身」，不是靠猜哪条 CSS 规则起了作用。helpers 在 macOS 上以
    //    `-AppleShowScrollBars Always` 启动，开发机与 CI 的 runner、Windows 一样画常驻的经典滚动条，
    //    所以「把 .ky-scroll-overlay 整条规则清空」与「class 名回退成 .ky-scroll」两类回归在开发机上
    //    同样会让它红（在跑着的应用里临时换 class 实测：前者两条轴各留 15px 槽，后者各 8px）——早先
    //    这里写的「macOS 默认是浮层滚动条、删规则测不出来」是那个开关加上之前的情况。起点两条轴都
    //    溢出，横向那条的槽（offsetHeight − clientHeight）也在量的范围里。
    const gutters = await page.evaluate((sel) => {
      const q = (w: string) => document.querySelector(`${sel} [data-pdf-pane="${w}"]`) as HTMLElement;
      const g = (el: HTMLElement) => ({ x: el.offsetWidth - el.clientWidth, y: el.offsetHeight - el.clientHeight });
      return { left: g(q('left')), right: g(q('right')) };
    }, paneSel);
    expect(gutters, '两栏都不该再有原生滚动条槽').toEqual({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } });

    // ② 滚一次 → 纵向拇指可见；静止 FADE_MS 之后淡出。
    const thumb = pane.getByTestId('pdf-thumb-y-left');
    await setPaneScroll(page, paneSel, 'left', 'top', 300);
    await expect(thumb).toHaveCSS('opacity', '1');
    // 拇指可见时的中心点：留着淡出之后再点这个坐标，断言那条热区收起来了。同一次 evaluate 里先做
    // 正向证明——可见时这一点确实命中拇指本身。缺了它，坐标量错了、或拇指压根不在这一点上，下面
    // 「淡出后不命中拇指」照样成立。
    const visibleHit = await page.evaluate((sel) => {
      const t = document.querySelector(`${sel} [data-testid="pdf-thumb-y-left"]`) as HTMLElement;
      const r = t.getBoundingClientRect();
      const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const el = document.elementFromPoint(center.x, center.y) as HTMLElement | null;
      return { center, isThumb: el?.getAttribute('data-testid') === 'pdf-thumb-y-left' };
    }, paneSel);
    expect(visibleHit.isThumb, '拇指可见时，它的中心点应当命中拇指本身').toBe(true);
    const thumbCenter = visibleHit.center;
    await expect(thumb).toHaveCSS('opacity', '0', { timeout: FADE_MS + 2000 });
    // 淡出之后拇指不该再挡指针（Important #1）：pointerEvents 曾经不看 shown 恒为 auto，栏边缘会有
    // 一条看不见但能点中的热区，吃掉贴边的高亮/文字注点击。同一坐标现在必须落在栏内容上，不是拇指。
    const hitAfterFade = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      return {
        isThumb: el?.getAttribute('data-testid') === 'pdf-thumb-y-left',
        insidePane: !!el?.closest('[data-pdf-pane="left"]'),
      };
    }, thumbCenter);
    expect(hitAfterFade, '淡出后拇指原来的位置不该再命中拇指——热区应随可见性收起').toEqual({ isThumb: false, insidePane: true });

    // ③ 拖拽：淡出之后拇指的 pointerEvents 已经是 none，得先来一次新的 scroll 事件让它重新可见，
    //    才摸得到它——悬停/拖拽只是让「已经可见」的拇指保持可见，不能凭空唤出一个隐形拇指
    //    （spec：可见性只由 scroll 触发）。紧接着量它的几何、把鼠标挪上去，全程压在 FADE_MS 窗口内。
    //    把拇指往下拖 Δ 像素，scrollTop 必须等于纯函数 scrollPosForThumb 的反算，右栏跟上。
    //    先把鼠标挪到拇指上（悬停让它变粗），再按住拖。轨道长按组件同一公式算：
    //    clientHeight − 2·INSET − (横向也能滚 ? HOVER_PX : 0)。
    await setPaneScroll(page, paneSel, 'left', 'top', 305);
    // 等 opacity 回到 1：这不只是「可见了」，show() 里 measure() 先于 setVisible(true) 跑，
    // 拿到 opacity: 1 就意味着组件已经按新的 scrollTop 重新量过、几何是新鲜的——不然这里读到的
    // 拇指位置可能还是淡出前那次 measure() 留下的，会把下面的反算算错。
    await expect(thumb).toHaveCSS('opacity', '1');
    const before = (await paneScroll(page, paneSel, 'left'))!;
    const metrics = await page.evaluate((sel) => {
      const el = document.querySelector(`${sel} [data-pdf-pane="left"]`) as HTMLElement;
      const t = document.querySelector(`${sel} [data-testid="pdf-thumb-y-left"]`) as HTMLElement;
      const er = el.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      return {
        clientLen: el.clientHeight, scrollLen: el.scrollHeight,
        hasX: el.scrollWidth > el.clientWidth,
        thumbTop: tr.top, thumbLeft: tr.left, thumbW: tr.width, thumbH: tr.height,
        paneTop: er.top,
      };
    }, paneSel);
    const trackLen = metrics.clientLen - 2 * THUMB_INSET_PX - (metrics.hasX ? THUMB_HOVER_PX : 0);
    const pos0 = metrics.thumbTop - metrics.paneTop - THUMB_INSET_PX;
    const delta = 60;
    const cx = metrics.thumbLeft + metrics.thumbW / 2;
    const cy = metrics.thumbTop + metrics.thumbH / 2;
    await page.mouse.move(cx, cy);
    await expect(thumb, '悬停时拇指变粗').toHaveCSS('width', `${THUMB_HOVER_PX}px`);
    await page.mouse.down();
    await page.mouse.move(cx, cy + delta, { steps: 6 });
    await page.mouse.up();
    const expected = scrollPosForThumb({ clientLen: metrics.clientLen, scrollLen: metrics.scrollLen, trackLen }, pos0 + delta);
    expect(expected, '拖了 60px 应当真的滚动了').toBeGreaterThan(before.top + 1);
    const after = (await paneScroll(page, paneSel, 'left'))!;
    expect(Math.abs(after.top - expected), `拖拽后 scrollTop=${after.top} 应等于反算 ${expected}`).toBeLessThan(1);
    await expect.poll(async () => (await paneScroll(page, paneSel, 'right'))!.top, { message: '右栏跟上' })
      .toBeCloseTo(after.top, 0);
  });

  test('57-pdf-dual-pane: 拖分隔线改两栏宽度，拖到最右右栏也不小于 MIN_PANE_PX', async () => {
    // 起点：上一条留下的对照态，分隔线还没被拖过、两栏等宽。
    // 「拖多少、左栏宽多少」的逐像素换算由 splitPane.test.ts 的 clampSplit / paneWidths 守；
    // 这里守的是产品代码有没有把它们接对：拖到钉死的终点时 DOM 与纯函数逐像素一致，双击回正中。
    const divider = pane.getByTestId('pdf-pane-divider');
    await expect(divider).toBeVisible();
    const c = await dividerCenter(pane);
    expect(c.w, '分隔线的命中区宽就是 DIVIDER_PX').toBeCloseTo(DIVIDER_PX, 1);
    const base = (await paneBoxWidths(page, paneSel))!;

    // 一路拖到 wrapper 最右边：clampSplit 的上限（usable − MIN_PANE_PX）该把右栏钉在最小宽上。
    const hugeX = base.wrapRight + 400;
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(hugeX, c.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(
      async () => (await paneBoxWidths(page, paneSel))?.right ?? Infinity,
      { timeout: 5000, message: '等拖到最右落地' },
    ).toBeLessThan(base.right);
    const pinned = (await paneBoxWidths(page, paneSel))!;
    // 断的是「DOM 与 clampSplit / paneWidths 逐像素一致」，不是「右栏 ≥ MIN_PANE_PX」。
    // 后者在这里是**构造性等号**：clampSplit 的上限就是 usable − MIN_PANE_PX，`usable ×
    // (hi/usable)` 的浮点结果再经 Blink 的 1/64 px 量化，实测正好落在 120 的刀刃上，
    // 119.99998 会让它红成一条看起来像分隔线回归的假警报。而放宽容差就是把判据换成阈值。
    // MIN_PANE_PX 这个下限本身由 splitPane.test.ts 守（纯函数，零容差）；这里守的是产品代码
    // 有没有把它接对——DOM 里那两栏必须正好是纯函数在同一组输入下算出来的宽。
    expect(pinned.right, `右栏宽应当就是 paneWidths(clampSplit(…)) 算出来的那个数 ${JSON.stringify(pinned)}`)
      .toBeCloseTo(paneWidths(pinned.wrapWidth, clampSplit(hugeX, pinned.wrapLeft, pinned.wrapWidth)).right, 0);
    // 两栏加一条分隔线恰好铺满 wrapper——右栏不是靠溢出撑住的那 120 px。
    expect(pinned.left + pinned.right + DIVIDER_PX, '两栏 + 分隔线应当铺满 wrapper')
      .toBeCloseTo(pinned.wrapWidth, 0);

    // 双击分隔线 → 回到等宽（Yee 2026-09-07：拖过之后要能一下子回正中）。分隔线此刻钉在最右，
    // 位置要重新量。判据是两栏宽之差与 paneWidths(wrapW, 0.5) 那个数，不是「分隔线大概在中间」。
    // 等宽也是下一条的起点。
    const c3 = await dividerCenter(pane);
    await page.mouse.dblclick(c3.x, c3.y);
    await expect.poll(
      async () => { const w = await paneBoxWidths(page, paneSel); return w ? Math.abs(w.left - w.right) : Infinity; },
      { timeout: 5000, message: '双击分隔线之后两栏应当等宽' },
    ).toBeLessThan(1);
    const centered = (await paneBoxWidths(page, paneSel))!;
    expect(centered.left, `等宽 = paneWidths(wrapW, 0.5).left ${JSON.stringify(centered)}`)
      .toBeCloseTo(paneWidths(centered.wrapWidth, 0.5).left, 0);
  });

  test('57-pdf-dual-pane: 两栏不等宽时内容左边缘仍对齐——窄栏滚到头，宽栏停在自己的上界', async () => {
    // 起点：上一条双击回了等宽，缩放在 200% 附近，纵向停在拖拇指拖出来的位置。
    // 纵向先回文档开头：下一条接着这条的状态，量的是第 1 页 canvas 上的内容坐标，第 1 页得在挂载
    // 窗口里。放在横向拉开差距**之前**做，免得之后再动纵向时两栏带着不等的 scrollLeft 互写。
    await setPaneScroll(page, paneSel, 'left', 'top', 0);
    await expect.poll(
      async () => (await paneScroll(page, paneSel, 'right'))?.top,
      { timeout: 5000, message: '右栏应当跟回文档开头' },
    ).toBe(0);

    // 捏到 200%：横向得先有得滚才谈得上「左边缘对齐」。起点本来就在 200% 附近（滚动同步那条捏的），
    // 这里照样捏一次，不白信前面几条留下的缩放；真正的前提由下面那个 maxLeft 断。
    const startPct = readoutPct((await pane.getByTestId('pdf-readout').textContent())!);
    await pinchTo(page, pdfPath, startPct, 200);

    // 把分隔线一路拖到 wrapper 最左边之外：clampSplit 把左栏钉在 MIN_PANE_PX，两栏从此不等宽，
    // 而**内容**宽两栏仍逐字段相同（同一份 sizes × 同一个 layer.scale）。这正是「不等宽时
    // scrollLeft 原样相等」这条约定要面对的局面。拖到钉死的终点、而不是「往左拖 150」：
    // 后者落点取决于 wrapper 宽（1024 窗口下本来就会被下限截住，余量只有二三十 px），
    // 拖到钉死处则 DOM 必须逐像素等于纯函数的结果，与窗口多宽无关（同 1732 的判据）。
    const c = await dividerCenter(pane);
    // 按下之前先确认这个点上真的是分隔线：上面刚滚过纵向，覆盖式滚动条的拇指会浮现约 1 s，
    // 它贴着左栏右缘。按在拇指上拖的就是滚动条，不是分隔线。
    await expect.poll(() => page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit?.closest('[data-testid="pdf-pane-divider"]') ? 'divider'
        : `${hit?.tagName ?? null}.${hit?.className ?? ''}[${hit?.getAttribute('data-testid') ?? ''}]`;
    }, c), { message: '分隔线中心点应当命中分隔线本身' }).toBe('divider');
    const before = (await paneBoxWidths(page, paneSel))!;
    const farLeft = before.wrapLeft - 400;
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(farLeft, c.y, { steps: 8 });
    await page.mouse.up();
    const want = paneWidths(before.wrapWidth, clampSplit(farLeft, before.wrapLeft, before.wrapWidth));
    await expect.poll(
      async () => {
        const w = await paneBoxWidths(page, paneSel);
        return w ? Math.round(w.left) : null;
      },
      { timeout: 5000, message: `等分隔线拖到最左落地：左栏应当钉在 ${JSON.stringify(want)}（拖之前 ${JSON.stringify(before)}）` },
    ).toBe(Math.round(want.left));
    const unequal = (await paneBoxWidths(page, paneSel))!;
    expect(unequal.right, `右栏宽应当就是 paneWidths(clampSplit(…)) 算出来的那个数 ${JSON.stringify(unequal)}`)
      .toBeCloseTo(want.right, 0);
    expect(unequal.right - unequal.left, '两栏确实不等宽，窄的是左栏').toBeGreaterThan(0);

    // 两栏都得有得横向滚
    await expect.poll(
      async () => {
        const l = await paneScroll(page, paneSel, 'left');
        const r = await paneScroll(page, paneSel, 'right');
        return Math.min(l?.maxLeft ?? 0, r?.maxLeft ?? 0);
      },
      { timeout: 10000, message: '不等宽之后两栏都应当有得横向滚' },
    ).toBeGreaterThan(80);

    // ① 不等宽时 scrollLeft 仍是**原样相等**（而不是按各自可滚量的比例换算）——两栏内容的
    //    左边缘因此对齐，宽栏只是往右多露一截（spec v8 §3.1）。
    await setPaneScroll(page, paneSel, 'left', 'left', 80);
    await expect.poll(
      async () => (await paneScroll(page, paneSel, 'right'))?.left,
      { timeout: 5000, message: '不等宽时右栏也应当原样跟到 80' },
    ).toBe(80);

    // ② 窄栏滚到自己的上界：写一个够大的数，让浏览器自己夹（分数上界，不经过 scrollWidth /
    //    clientWidth 那两道取整）。内容宽相同、可视宽更小 → 窄栏的上界必然更大，镜像过去的值
    //    超出宽栏的上界，宽栏该稳稳停在自己的上界上，不抛也不把窄栏拽回来。
    await setPaneScroll(page, paneSel, 'left', 'left', 1e6);
    await expect.poll(
      async () => (await paneScroll(page, paneSel, 'right'))?.left,
      { timeout: 5000, message: '窄栏滚到头之后，宽栏也该跟着往右走' },
    ).toBeGreaterThan(80);

    // 回声锁得吞掉「宽栏被夹之后发出的那次 scroll」。吞不掉的话它会把夹过的值写回窄栏，窄栏
    // 从「滚到头」被一路拽回宽栏的上界（差着两栏宽度差那么多，≈ 300 px）。留一段时间给它抖。
    await page.waitForTimeout(300);
    const ends = await paneLeftAtMax(page, paneSel);
    expect(ends.left.atMax, `窄栏应当停在自己的上界上 ${JSON.stringify(ends)}`).toBe(true);
    expect(ends.right.atMax, `宽栏应当停在自己的上界上 ${JSON.stringify(ends)}`).toBe(true);
    // 两栏各自到头，而窄栏能滚得更远——这正是「内容宽相同、可视宽不同」的直接后果。
    expect(ends.left.at, `窄栏的上界应当比宽栏大 ${JSON.stringify(ends)}`)
      .toBeGreaterThan(ends.right.at);
  });

  test('57-pdf-dual-pane: 两栏 scrollLeft 已经不等时在宽栏上捏合，鼠标下那一点不跳', async () => {
    // spec §3.1 的 v9 订正：缩放锚点的**快照与回写同取事件所在的那一栏**。
    //
    // 上一条用例造出的正是这条订正要面对的状态——窄栏横向滚到自己的上界之后，宽栏到不了那么远，
    // 两栏的 scrollLeft 从此差着两栏可视宽之差（≈ 300 px）。此时若还按「两栏 scrollLeft 恒相等」
    // 拿**左栏**的快照去配**右栏**量出来的 focal，两个量分属两个基准，回算出来的位置会差
    // `(sl_left − sl_right) × f`，鼠标下那一点当场跳掉一截。
    //
    // 判据是「鼠标压着的那个内容点，捏合前后是同一个」——协议层的恒等式，不是像素容差。
    const FOCAL = { x: 40, y: 120 };  // 贴着宽栏左边缘取焦点：那里离宽栏自己的滚动上界最远
    const readout = pane.getByTestId('pdf-readout');

    // 起点是上一条留下的状态：缩放 200% 附近、分隔线拖到了最左（左栏钉在 MIN_PANE_PX、右栏宽，
    // 两栏宽由上一条逐像素断过）、窄栏横向滚到头、纵向在文档开头。前提逐个重新断一遍，不白信上一条。
    const widths = (await paneBoxWidths(page, paneSel))!;
    expect(widths.right - widths.left, `两栏应当已经不等宽 ${JSON.stringify(widths)}`).toBeGreaterThan(0);

    // 窄栏滚到自己的上界，宽栏被夹在自己的上界上 —— 两栏 scrollLeft 从此不等（上一条已经做过，
    // 已在上界上时这一句什么都不改变）
    await setPaneScroll(page, paneSel, 'left', 'left', 1e6);
    await expect.poll(
      async () => {
        const l = await paneScroll(page, paneSel, 'left');
        const r = await paneScroll(page, paneSel, 'right');
        return l && r ? l.left - r.left : 0;
      },
      { timeout: 10000, message: '等两栏的 scrollLeft 真的拉开差距（窄栏到头、宽栏被夹）' },
    ).toBeGreaterThan(100);
    // 前提本身也断一次：两栏若仍然相等，下面那条恒等式在坏实现下照样成立，用例会白绿
    const gap = await paneScroll(page, paneSel, 'left');
    const gapR = await paneScroll(page, paneSel, 'right');
    expect(gap!.left - gapR!.left, `捏合之前两栏的 scrollLeft 必须已经不等 ${JSON.stringify({ gap, gapR })}`)
      .toBeGreaterThan(100);

    const before = await contentPtUnder(page, paneSel, 'right', FOCAL.x, FOCAL.y);
    expect(before, '右栏第 1 页应当已经挂载并定好尺寸').not.toBeNull();

    // **在右栏上**捏合一次。放大而不是缩小：两栏此刻都贴着各自的横向上界，放大让上界一起变大，
    // 正确实现有地方可去；错误实现算出来的是左栏那套坐标，写进去会被夹回上界。
    const pct0 = readoutPct((await readout.textContent())!);
    await pinchOnPane(page, paneSel, 'right', pct0, Math.round(pct0 * 1.2), FOCAL.x, FOCAL.y);
    await expect.poll(
      async () => readoutPct((await readout.textContent())!),
      { timeout: 5000, message: '等这次捏合落地（读数换档）' },
    ).toBeGreaterThan(pct0);

    const after = await contentPtUnder(page, paneSel, 'right', FOCAL.x, FOCAL.y);
    expect(after, '捏合之后右栏第 1 页仍应当在').not.toBeNull();
    // 锚点若取错栏，这里差的是 (sl_left − sl_right) × f 折算回 pt 的量级（实测 ≈ 40 pt），
    // 与下面这半个 pt 的判据差着两个数量级——不是靠容差调出来的绿。
    expect(after!.x, `鼠标下那一点的横坐标不该变 ${JSON.stringify({ before, after })}`)
      .toBeCloseTo(before!.x, 0);
    expect(after!.y, `鼠标下那一点的纵坐标不该变 ${JSON.stringify({ before, after })}`)
      .toBeCloseTo(before!.y, 0);
  });
});
