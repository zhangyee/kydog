import { test, expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector } from './helpers';
import { buildPagedPdf } from './fixtures/textPdf';
import { PAGE_GAP } from '../src/renderer/panels/main-pane/pdf/pageLayout';
import { ZOOM_SENSITIVITY } from '../src/renderer/panels/main-pane/pdf/zoomSensitivity';
// contrast() 是纯函数（luminance 算术，见文件内注释），不依赖 DOM——同 PAGE_GAP / ZOOM_SENSITIVITY
// 一样可以直接从组件目录 import 到 Node 端的 e2e 文件，不会拖入 react-pdf / pdf.js worker 的副作用
// （那两个文件都没有其他 import；inkForBackground.ts 只 import 了 pageBackground.ts 的一个类型）。
import { contrast } from '../src/renderer/panels/main-pane/pdf/inkForBackground';
import type { RGB } from '../src/renderer/panels/main-pane/pdf/pageBackground';

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
// 有 target 的那个块（视口 pt）。TARGET_INK 是这个矩形里真放的一行原文墨迹（Helvetica，
// baseline 落在矩形纵向居中附近）——「右格应该把它盖干净」这条断言得先有东西可盖才立得住，
// 不能盖的是一片本来就空白的区域（那样断言在实现错了的时候也一样绿）。
const TARGET_BLOCK = { x: 60, y: 200, w: 460, h: 120 };
const TARGET_INK = { x: 80, y: 260, text: 'residue check', size: 14 };
// 采样框：包住 TARGET_INK 的墨迹，且完全落在 TARGET_BLOCK 内部（不挨边，不吃 BLOCK_PAD 外扩）。
const TARGET_SAMPLE = { x: 65, y: 235, w: 300, h: 40 };
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

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  const pdf = buildPagedPdf(PAGES, PAGE_W, PAGE_H, TARGET_INK);
  await fs.writeFile(path.join(projectPath, PDF_REL), pdf);
  await fs.writeFile(path.join(projectPath, ZH_REL), buildSidecar(pdf));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

// Task 8 四态用例的最小 fixture：就地造，不建独立文件（Task 9 再统一整理成 e2e/fixtures 的常设份）。
const NONE_REL = 'plain.pdf';
const INVALID_REL = 'bad-translation.pdf';
const MISMATCH_REL = 'stale-translation.pdf';
const READY_REL = 'ok-translation.pdf';

/** 无边车（none）、边车不是合法 JSON（invalid）、摘要对不上（mismatch）、正常（ready）各一份。
 *  四份都是一页空白 PDF——四态测的是工具栏/Notice 对 store 状态的响应，不需要页面内容或译文
 *  块几何，用最小 PDF 省去 buildSidecar 那套逐页塞块的开销。 */
async function seedFourStates(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });

  const none = buildPagedPdf(1, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, NONE_REL), none);
  // 不写 .plain.pdf.zh.json —— pdf.translation.load 对 ENOENT 返回 { doc: null }，即「未找到译文」

  const invalid = buildPagedPdf(1, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, INVALID_REL), invalid);
  // 不是合法 JSON：主进程 JSON.parse 直接抛 KydogError，同 55 的「坏 JSON 边车」用例手法
  await fs.writeFile(path.join(projectPath, `.${INVALID_REL}.zh.json`), '{broken');

  const stale = buildPagedPdf(1, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, MISMATCH_REL), stale);
  await fs.writeFile(path.join(projectPath, `.${MISMATCH_REL}.zh.json`), JSON.stringify({
    version: 1, pdf: MISMATCH_REL, lang: { in: 'en', out: 'zh' },
    // 摘要写死成不可能匹配真实字节的值——mismatch 只看摘要，不看这份 PDF 实际长什么样。
    source: { sha256: '0'.repeat(64), bytes: 1 },
    blocks: [],
  }));

  const ready = buildPagedPdf(1, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, READY_REL), ready);
  await fs.writeFile(path.join(projectPath, `.${READY_REL}.zh.json`), JSON.stringify({
    version: 1, pdf: READY_REL, lang: { in: 'en', out: 'zh' },
    source: { sha256: createHash('sha256').update(ready).digest('hex'), bytes: ready.byteLength },
    blocks: [],
  }));

  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

// 对比度 e2e（design spec §13）的最小 fixture：一份白底、一份深底，各配一条有 target 的块。
// 不复用 seedAll 的 paper.pdf——那份 fixture 是给对齐/残留/字号三条用例的，混进一份深色页
// 会让读 seedAll 的人多想一层「这份深色底是给谁用的」；仿 seedFourStates 的先例，各测试自带
// 自己需要的最小 fixture，互不牵连。
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

async function seedFallbackBg(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  const pdf = buildPagedPdf(1, PAGE_W, PAGE_H, undefined, undefined, FALLBACK_PATCH);
  await fs.writeFile(path.join(projectPath, FALLBACK_REL), pdf);
  await fs.writeFile(
    path.join(projectPath, `.${FALLBACK_REL}.zh.json`),
    buildContrastSidecar(FALLBACK_REL, pdf),
  );
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
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

async function seedMono(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  const pdf = buildPagedPdf(1, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, MONO_REL), pdf);
  await fs.writeFile(path.join(projectPath, `.${MONO_REL}.zh.json`), buildMonoSidecar(pdf));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

async function seedContrast(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });

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

  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
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
 * 按 L 进对照。译文边车是另一条异步链路（读字节 → sha256 → RPC → store），可能比首屏渲染晚
 * 到；没到之前 L 是禁用态、按下去什么都不发生。所以这里重试：**判据是右格出没出来**，
 * 不是等一个拍脑袋的毫秒数。按下后立刻再查一次，成了就返回——切换是同步 commit，不会出现
 * 「按成功了但还没反映到 DOM」而被下一轮重复按回去的情况。
 */
async function enterDual(page: Page, pane: Locator) {
  const right = pane.locator('[data-pdf-right="1"]');
  await pane.locator('[data-testid^="pdf-scroll-"]').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 25; i++) {
    if (await right.count() > 0) return;
    await page.keyboard.press('l');
    if (await right.count() > 0) return;
    await page.waitForTimeout(200);
  }
  throw new Error('按 L 没能进入双栏对照：译文边车迟迟没加载');
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
}

function parseRgb(css: string): RGB {
  const m = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) throw new Error(`无法从 computed style 解析颜色：${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 读一个译文块的 computed color、以及右格底图在这个块矩形正中心的像素，算 WCAG 对比度。
 * 采中心点而不是像 TARGET_SAMPLE 那样避让墨迹：译文块本身是叠在底图上的 HTML 层，不进
 * canvas 绘制，所以矩形内任一点的底图像素都只是 RightPage 填的纯色，不需要避开什么。
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
    const row = document.querySelector(`${sel} [data-pdf-layer="stable"] [data-pdf-page="1"]`);
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
    const c = document.querySelector(`${sel} [data-pdf-layer="stable"] canvas:not([data-pdf-right])`);
    const w = c ? (c as HTMLCanvasElement).style.width : '';
    return w ? parseFloat(w) : 0;
  }, paneSel);
}

/** 清晰层外层的 CSS zoom（= visualScale / layer.scale）。位图与显示同档时它是 1。 */
async function stableLayerZoom(page: Page, paneSel: string): Promise<number | null> {
  return page.evaluate((sel) => {
    const l = document.querySelector(`${sel} [data-pdf-layer="stable"]`);
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

type RowGeom = { page: string; sized: boolean; dTop: number | null; dHeight: number | null; dGap: number | null };

/**
 * 清晰层里每个已挂载页行的左右两格几何差。读的是 getBoundingClientRect，含外层 zoom。
 * `dGap` 补的是「并排」这一维：只看 top/height 相等，右格被绝对定位盖在左格正上方时两者
 * 照样成立（重叠时两者的 top 与 height 当然也相等）——两格真正并排，还得是右格左边缘落在
 * 「左格右边缘 + 页间距」上。`pageGap` 传的是 PAGE_GAP（pt，scale 1 下的值），乘的 scale
 * 从 `lr.width / pageW` 现推——CSS 宽本就是 `size.w * layer.scale`（见 task-6 report），
 * 不猜一个写死的缩放比例。
 */
async function rowGeometry(page: Page, paneSel: string, pageW: number, pageGap: number): Promise<RowGeom[]> {
  return page.evaluate(({ sel, pageW, pageGap }) => {
    const rows = Array.from(
      document.querySelectorAll(`${sel} [data-pdf-layer="stable"] [data-pdf-page][data-pdf-mounted="1"]`),
    );
    return rows.map((row) => {
      const left = row.querySelector('canvas:not([data-pdf-right])') as HTMLCanvasElement | null;
      const right = row.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement | null;
      const lr = left?.getBoundingClientRect();
      const rr = right?.getBoundingClientRect();
      const scale = lr ? lr.width / pageW : null;
      return {
        page: (row as HTMLElement).dataset.pdfPage ?? '?',
        // react-pdf 要等自己的 effect 跑过才给左格 canvas 写 CSS 尺寸；在那之前它是
        // 300 × 150 的固有尺寸，量出来的差值没有意义。sized 把「还没定尺寸」与「没对齐」分开。
        sized: !!left && left.style.width !== '' && !!right,
        dTop: lr && rr ? Math.abs(lr.top - rr.top) : null,
        dHeight: lr && rr ? Math.abs(lr.height - rr.height) : null,
        dGap: lr && rr && scale !== null ? Math.abs((rr.left - (lr.left + lr.width)) - pageGap * scale) : null,
      };
    });
  }, { sel: paneSel, pageW, pageGap });
}

test('57-pdf-dual-pane: 两栏同页顶对齐、等高，滚动与缩放后仍成立', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));

    await enterDual(page, pane);

    const check = async (label: string) => {
      await expect.poll(
        async () => {
          const g = await rowGeometry(page, paneSel, PAGE_W, PAGE_GAP);
          return g.length > 0 && g.every((r) => r.sized);
        },
        { timeout: 15000, message: `${label}：等两格都定好尺寸` },
      ).toBe(true);
      const g = await rowGeometry(page, paneSel, PAGE_W, PAGE_GAP);
      for (const r of g) {
        expect(r.dTop ?? Infinity, `${label} 第 ${r.page} 页顶边`).toBeLessThan(0.5);
        expect(r.dHeight ?? Infinity, `${label} 第 ${r.page} 页高度`).toBeLessThan(0.5);
        // 右格左边缘 ≈ 左格右边缘 + 页间距——只看 top/height 相等的话，右格被绝对定位盖在
        // 左格正上方也会全绿（重叠时两者的 top、height 当然也相等）。这条断住「两格并排」
        // 本身，而不只是「两格一样大」。容差比 dTop/dHeight 松：dTop/dHeight 是两块 canvas
        // 同一次 `size.h/w * layer.scale` 乘法算出来的 CSS 尺寸，逐位相同（实测差值为 0）；
        // dGap 还要再跨一层 `zoom: visualScale / layer.scale`（PdfFileTab.tsx 行的外层样式）——
        // `zoom` 会让浏览器重新走一次布局，缩放不是 1 时各元素独立按设备像素网格取整，实测
        // 150% 缩放、Retina（DPR 2）下单条能到 ~0.52 CSS px。2px 仍比这类取整噪声宽出几倍，
        // 但远小于「重叠」会出现的偏差量级（右格叠在左格上时 dGap 会偏出几百 px，即左格整页宽）。
        expect(r.dGap ?? Infinity, `${label} 第 ${r.page} 页两格间距`).toBeLessThan(2);
      }
    };

    await check('刚进对照');

    // 右格确实合成过、且拷的是左格位图：
    // ① 位图尺寸逐字段等于左格 —— 只有合成 effect 会去写它，没跑过就还是 canvas 的固有 300 × 150；
    // ② 那行字所在的矩形里，两格像素逐字节相同、且真有暗像素。这一条同时钉住两件事：
    //    drawImage 真的拷了内容（不是一张空白），以及**没有 target 的块不被填色**
    //    （fixture 把这行字划成了一个无 target 的块，谁把「有没有 target」这条判据丢了，字就没了）。
    await expect.poll(async () => page.evaluate((sel) => {
      const row = document.querySelector(`${sel} [data-pdf-layer="stable"] [data-pdf-page="1"]`);
      const l = row?.querySelector('canvas:not([data-pdf-right])') as HTMLCanvasElement | null;
      const r = row?.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement | null;
      return !!l && !!r && l.width > 0 && r.width === l.width && r.height === l.height;
    }, paneSel), { timeout: 10000, message: '等右格合成' }).toBe(true);

    const sample = await page.evaluate(({ sel, ink, pageW }) => {
      const row = document.querySelector(`${sel} [data-pdf-layer="stable"] [data-pdf-page="1"]`)!;
      const l = row.querySelector('canvas:not([data-pdf-right])') as HTMLCanvasElement;
      const r = row.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement;
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
    }, { sel: paneSel, ink: INK, pageW: PAGE_W });
    expect(sample.same, '右格在无 target 的块矩形里应与左格逐字节相同').toBe(true);
    expect(sample.dark, '右格那行原文应当还在（有暗像素）').toBeGreaterThan(0);

    // 滚几屏：换一批挂载的页，两格照样对齐
    await scroll.evaluate((el) => { el.scrollTop = el.clientHeight * 4; });
    await expect(pane.getByTestId('pdf-readout')).not.toContainText(`1 / ${PAGES}`);
    await check('滚动之后');

    // 捏合到 150%，等新层顶替，两格照样对齐（两栏的 CSS 尺寸出自同一个 layer.scale）。
    // deltaY 不能再写死 -66.67：那个值是按「进对照后仍是 100%」反推的，Task 8 的 fit-width
    // 会在行宽装不下时先把进对照的起始缩放降下来（本 fixture 装不下，见「进入对照时按需
    // fit-width」那条用例），实际起点因此不再是 100%。这里先读真实起点，再按同一个乘法公式
    // （`targetScale.current * (1 - deltaY * ZOOM_SENSITIVITY)`，见 PdfFileTab.tsx 的 onWheel）
    // 反推要多大的 deltaY 才能落在 150%。ZOOM_SENSITIVITY 从 zoomSensitivity.ts import（同
    // PAGE_GAP 一样，是抽出来给两边共用的纯常量，不拖 react-pdf / pdf.js worker 那串副作用），
    // 不再照抄字面量。
    const startPct = readoutPct((await pane.getByTestId('pdf-readout').textContent())!);
    await pinchTo(page, pdfPath, startPct, 150);
    await expect(pane.getByTestId('pdf-readout')).toContainText('150%');
    // 等顶替：判据是协议层事实——清晰层的左格 canvas 换成了按新缩放开的那一张（CSS 宽从
    // 595 变成 892），不是「等 800 ms」。双缓冲期间 stable 还是旧层，这个数就还没变。
    await expect.poll(
      async () => page.evaluate((sel) => {
        const c = document.querySelector(`${sel} [data-pdf-layer="stable"] canvas:not([data-pdf-right])`);
        return c ? parseFloat((c as HTMLCanvasElement).style.width) : 0;
      }, paneSel),
      { timeout: 15000, message: '等新层顶替' },
    ).toBeGreaterThan(PAGE_W);
    await expect(pane.locator('[data-pdf-layer]')).toHaveCount(1);
    await check('缩放之后');
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 右栏在有 target 的块矩形内没有原文残留', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

    await enterDual(page, pane);

    // 等右格真的合成过一次（位图尺寸落地才有意义可读），同上面用例的判据
    await expect.poll(async () => page.evaluate((sel) => {
      const row = document.querySelector(`${sel} [data-pdf-layer="stable"] [data-pdf-page="1"]`);
      const l = row?.querySelector('canvas:not([data-pdf-right])') as HTMLCanvasElement | null;
      const r = row?.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement | null;
      return !!l && !!r && l.width > 0 && r.width === l.width;
    }, paneSel), { timeout: 10000, message: '等右格合成' }).toBe(true);

    // 把译文 HTML 层临时藏掉，只看底图——这条只验合成阶段（RightPage 的 fillRect），
    // 不牵涉 TranslationBlocks 本身画了什么。
    await page.evaluate((sel) => {
      document.querySelectorAll<HTMLElement>(`${sel} [data-translation-blocks]`)
        .forEach((el) => { el.style.visibility = 'hidden'; });
    }, paneSel);

    // TARGET_SAMPLE 包住 TARGET_INK 那行真实原文墨迹，且完全落在 TARGET_BLOCK 矩形内部。
    // 这行墨迹是 seedAll 特意放进去的（buildPagedPdf 的 extra 参数）——不放的话这里本来就是
    // 空白页背景，"盖没盖"这条断言在实现错了的时候也会一样绿（这正是 Task 6 报告提醒过的
    // 「验收标准要能证伪」那类坑：断言必须先有东西可盖，才谈得上"盖没盖住"）。
    const uniform = await page.evaluate(({ sel, box, pageW }) => {
      const row = document.querySelector(`${sel} [data-pdf-layer="stable"] [data-pdf-page="1"]`);
      const c = row?.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement | null;
      if (!c) return false;
      const ctx = c.getContext('2d')!;
      const S = c.width / pageW;
      const d = ctx.getImageData(
        Math.round(box.x * S), Math.round(box.y * S),
        Math.round(box.w * S), Math.round(box.h * S),
      ).data;
      for (let i = 4; i < d.length; i += 4) {
        if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false;
      }
      return true;
    }, { sel: paneSel, box: TARGET_SAMPLE, pageW: PAGE_W });
    expect(uniform, '有 target 的块矩形内应当已被页背景色盖平，不留原文墨迹').toBe(true);
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 字号测量必须等字体真的到位——先量后到位会被人为延迟当场抓到', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

    // 给 document.fonts.load 包一层确定性的人为延迟（真实加载照常发生，只是把"resolve" 这件事
    // 晚一点交给页面代码）——不赌真实网络/磁盘加载会不会恰好落在某个时间点上，而是自己制造一段
    // "肯定还没到位"的窗口。实现如果按 spec 内部 await 这个调用，这段窗口内就不该已经测过；
    // 不 await 的话，会在窗口内就测完并把（可能用了回退字体量出来的）结果写进 state。
    const DELAY_MS = 1500;
    await page.evaluate((delay) => {
      const orig = document.fonts.load.bind(document.fonts);
      document.fonts.load = (font: string, text?: string) =>
        orig(font, text).then((faces) => new Promise<FontFace[]>((r) => setTimeout(() => r(faces), delay)));
    }, DELAY_MS);

    await enterDual(page, pane);

    // 朴素占位值：fontSize(11) × SIZE_MUL('text')(1) × fit(测量落地前的占位 1) × rasterScale(1)。
    // LONG_ZH 足够长（binary search 门槛之上，见常量定义处的推算），真测过一次之后 fit 必然 ≠ 1，
    // 字号必然偏离这个值——用"偏离朴素值"当作"已经测过"的判据。
    const NAIVE = '11px';
    const block1 = page.locator(`${paneSel} [data-translation-block="b1-text"]`);
    await expect(block1).toBeVisible();

    // 延迟窗口内：字体"到位"这件事被我们钉死晚了 DELAY_MS 才会发生。按 spec 先 await 再量的
    // 实现，此刻测量还没跑完，字号应当还是朴素占位值。
    const duringDelay = await block1.evaluate((el) => getComputedStyle(el).fontSize);
    expect(duringDelay, '人为延迟窗口内不该已经量完——量完了说明没有真的等字体到位就测了').toBe(NAIVE);

    // 等延迟过去、字体真正就绪
    await expect.poll(
      async () => block1.evaluate((el) => getComputedStyle(el).fontSize),
      { timeout: DELAY_MS + 5000, message: '等延迟过去、字体真正就绪之后量出真实字号' },
    ).not.toBe(NAIVE);
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 翻译键四态——无边车 / 边车有误 / 摘要不匹配都禁用，正常可点', async () => {
  const launched = await launchKydog({ seed: seedFourStates });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');

    // 每次 openPdf 都切到一个新 tab（前一个 tab 的 pane 随之被 display:none 藏起来），所以
    // Notice 文案的可见性断言必须紧跟在对应的 openPdf 之后，不能攒到最后一起查。
    const none = await openPdf(page, path.join(projectPath, NONE_REL));
    await expect(none.getByTestId('pdf-translate')).toBeDisabled();

    const invalid = await openPdf(page, path.join(projectPath, INVALID_REL));
    await expect(invalid.getByTestId('pdf-translate')).toBeDisabled();
    await expect(invalid.getByText(/译文文件有误/)).toBeVisible();

    const mismatch = await openPdf(page, path.join(projectPath, MISMATCH_REL));
    await expect(mismatch.getByTestId('pdf-translate')).toBeDisabled();
    await expect(mismatch.getByText(/另一个版本的 PDF/)).toBeVisible();

    const ready = await openPdf(page, path.join(projectPath, READY_REL));
    await expect(ready.getByTestId('pdf-translate')).toBeEnabled();
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 进入对照时按需 fit-width，退出还原（连位图层一起还原）', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    const readout = pane.getByTestId('pdf-readout');
    const before = await readout.textContent();
    const beforeW = await stableCanvasWidth(page, paneSel);
    expect(beforeW, '进对照前清晰层的左格 canvas 应当已经定好 CSS 尺寸').toBeGreaterThan(0);

    // 一行是 2 × 595pt + 16pt 间距 = 1206pt，默认窗口宽度（main pane 减去两条侧栏之后）明显
    // 装不下——进对照应当把缩放降到刚好放下，读数因此跟着变小。
    await enterDual(page, pane);
    const during = await readout.textContent();
    expect(during, '进对照后行宽放不下，读数应当已经变小').not.toBe(before);
    expect(readoutPct(during!)).toBeLessThan(readoutPct(before!));
    // 位图层也跟着降下来（进对照那一次缩放同样排了提交）
    await expect.poll(
      () => stableCanvasWidth(page, paneSel),
      { timeout: 15000, message: '等进对照后的清晰层提交' },
    ).toBeLessThan(beforeW);

    // 退出：还原成进入前的缩放
    await page.keyboard.press('l');
    await expect(pane.locator('[data-pdf-right="1"]')).toHaveCount(0);
    await expect(readout).toHaveText(before!);
    // 读数回到进入前只说明 CSS zoom 那个数字回来了——位图层若停在 fit 那一档，画面就是被放大
    // 两倍显示的糊图，而且在用户下一次捏合之前不会自愈。判据取协议层事实：清晰层左格 canvas
    // 的 CSS 宽（= size.w × layer.scale）必须回到进对照前那个值。
    await expect.poll(
      () => stableCanvasWidth(page, paneSel),
      { timeout: 15000, message: '等退出对照后的清晰层提交' },
    ).toBe(beforeW);
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 捏合过之后再按 L，不拿陈旧锚点把视图弹回去', async () => {
  // 这条守的是「改缩放的路径必须走同一个入口」：进/出对照也是一次缩放改动，既要显式清掉上一次
  // 捏合留下的回算锚点，也要排一次清晰层提交。现有那条 fit-width 用例的顺序是「进对照 → 捏合」，
  // 从不在捏合之后再切 dual，而那正是唯一能撞上陈旧锚点的顺序。
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));
    const readout = pane.getByTestId('pdf-readout');

    // 1. 先捏合一次（这一步才会写下 zoomAnchor），等新层顶替
    const startPct = readoutPct((await readout.textContent())!);
    await pinchTo(page, pdfPath, startPct, 150);
    await expect(readout).toContainText('150%');
    await expect.poll(
      () => stableCanvasWidth(page, paneSel),
      { timeout: 15000, message: '等捏合后的新层顶替' },
    ).toBeGreaterThan(PAGE_W);

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
    const after = await scroll.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    expect(after.top, '按 L 之后不该弹回文档开头').toBeGreaterThan(0);
    expect(after.top, '按 L 之后 scrollTop 只该被新的滚动上界夹一下，不该被锚点回算改写')
      .toBeCloseTo(Math.min(beforeTop, after.max), 0);

    // 提交也必须排上：位图层收敛到新缩放之后，外层 CSS zoom（visualScale / layer.scale）回到 1。
    // 不排提交的话它会一直停在 fit / 上一次捏合的比值上（实测约 0.5），画面一直糊着。
    await expect.poll(
      () => stableLayerZoom(page, paneSel),
      { timeout: 15000, message: '等进对照后的清晰层提交，外层 zoom 收敛回 1' },
    ).toBeCloseTo(1, 2);
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 左栏可标注，右格内没有标注层', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const pane = await openPdf(page, pdfPath);

    await enterDual(page, pane);
    await pane.getByTestId('pdf-tool-highlight').click();

    const layer = pane.getByTestId('pdf-annotation-layer-1');
    const box = (await layer.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 21, { steps: 8 });
    await page.mouse.up();
    await expect(pane.locator('[data-annotation-id]')).toHaveCount(1);

    // 选择器必须限定在右格子树内——左格有标注，全局（或只限定到 pane 根）查一定命中，
    // 测不出「右格是不是真的没有标注层」这件事。
    const rightCell = pane.locator('[data-pdf-page="1"] [data-pdf-right="1"]').locator('xpath=..');
    await expect(rightCell.locator('[data-annotation-id]')).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 两组主题 × 背景的对比度达标——墨色由背景推导，不跟应用主题', async () => {
  // design spec §13：「两组主题 × 背景的对比度达标」是墨色由实际背景推导（Task 7 的
  // inkForBackground）这条核心主张唯一的端到端验证——单测只验了 contrast()/inkForBackground()
  // 这两个纯函数本身，没有任何东西证明它们真的接到了 RightPage 探测出的背景、真的绕过了
  // --color-ink 那条会跟主题走的默认路径。两组刻意选成会互相冲突的搭配：midnight 主题的
  // --color-ink 接近白，压在白页上先天就低对比度；vellum 主题的 --color-ink 接近黑，压在
  // 深色页上同样先天低对比度——如果实现退化成读 --color-ink，这两组里至少有一组会红。
  const launched = await launchKydog({ seed: seedContrast });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');

    const whitePath = path.join(projectPath, CONTRAST_WHITE_REL);
    const darkPath = path.join(projectPath, CONTRAST_DARK_REL);

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
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 含 inline-code 的块，量的和画的是同一套排版——不溢出', async () => {
  // 测量宿主与渲染必须同一套 span 结构（同一份 SEG_STYLE），且要等 --font-mono 那条栈到位。
  // 用纯文本量的话，inline-code 段按 serif 的宽度算行数，画出来却是等宽字体：行数变多，
  // 「刚好装下」的比例一渲染就溢出成块内滚动条——而 spec 的立场是溢出只在收到下限 0.5 仍
  // 装不下时才允许发生。这段文本离下限远得很（见 MONO_CODE 处的推算）。
  const launched = await launchKydog({ seed: seedMono });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', MONO_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await enterDual(page, pane);

    const block = page.locator(`${paneSel} [data-translation-block="m1"]`);
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
    expect(box.clientH, '块高应当是 bbox 高（120pt × rasterScale）那个量级').toBeGreaterThan(50);
    // 唯一的判据：画出来的内容装得进块里。测量用 serif、渲染用 mono 时这里会明显超出。
    expect(box.scrollH, `含 inline-code 的块不该溢出：测量与渲染必须用同一套排版 ${JSON.stringify(box)}`)
      .toBeLessThanOrEqual(box.clientH + 1);
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 关 tab 之后，在途的译文加载不会把桶重建回来', async () => {
  // 关 tab 时 `drop(tab.id)` 是同步的，而在途的 `pdf.translation.load` 随后才 resolve——它的
  // setLoaded 里有 `?? emptyTBucket()`，会把桶连同整份 TranslatedDoc 原地重建，此后再没有人
  // 释放它（组件已经卸载，不会再有第二次 drop）。
  //
  // 判据取协议层事实：store 里还挂着几个译文桶（__kydogTranslationBuckets 探针）。组件卸载
  // 之后这条路径不再有任何 DOM 痕迹，别的地方观察不到。
  const launched = await launchKydog({ seed: seedContrast });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', CONTRAST_WHITE_REL);
    await openPdf(page, pdfPath);
    const count = () => page.evaluate(
      () => (window as unknown as { __kydogTranslationBuckets?: number }).__kydogTranslationBuckets ?? -1,
    );
    await expect.poll(count, { timeout: 10000, message: '等译文桶建起来' }).toBe(1);

    // 同一次 evaluate 里先发 focus（触发一次重探，RPC 就此在途）、再点关闭按钮：两件事落在
    // 同一个任务里，RPC 绝无可能在中间 resolve，「关 tab 时正好有一趟在途」因此是确定的，
    // 不靠抢时间窗口。
    await page.evaluate((sel) => {
      window.dispatchEvent(new Event('focus'));
      (document.querySelector(sel) as HTMLElement).click();
    }, testIdSelector(`tab-close-${pdfPath}`));
    await expect(page.getByTestId(`file-pane-${pdfPath}`)).toHaveCount(0);

    // 在途那趟落地要走一个 IPC 往返，给它足够时间；桶数必须一直是 0。
    await page.waitForTimeout(1500);
    expect(await count(), '关 tab 之后在途的加载不该把译文桶重建回来').toBe(0);
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 页背景取不到时，墨色按实际填下去的兜底底色推——不是按白底', async () => {
  // 上面那条用例的两份 fixture 都是整页纯色，八点取样恒能取到，走的全是 pageBackground()
  // **取得到**的那条路。这条补的是**取不到**的那条：RightPage 退回去填主题纸色，而墨色若仍
  // 按白底推，midnight（--color-paper 是深蓝灰）下就是近黑字压深蓝灰，约 1.4:1。
  const launched = await launchKydog({ seed: seedFallbackBg });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', FALLBACK_REL);
    const sel = testIdSelector(`file-pane-${pdfPath}`);

    await setTheme(page, 'midnight');
    const pane = await openPdf(page, pdfPath);
    await enterDual(page, pane);
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
  } finally {
    await teardown(launched);
  }
});
