import { test, expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector } from './helpers';
import { buildPagedPdf } from './fixtures/textPdf';
import { ZOOM_SENSITIVITY } from '../src/renderer/panels/main-pane/pdf/zoomSensitivity';
// splitPane.ts 整个文件都是纯算（两个常量 + 三个纯函数，无 import），所以连函数一起拿过来用：
// 拖分隔线那条用例要断的是「DOM 与这两个纯函数逐像素一致」，照抄一份公式到测试里等于把被测的
// 算法抄了两遍，抄错了两边一起错。
import { clampSplit, DIVIDER_PX, MIN_PANE_PX, paneWidths } from '../src/renderer/panels/main-pane/pdf/splitPane';
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
// 一行带降部的字：g / y / p / q 的尾巴在基线下 0.207 × 14 ≈ 2.9 pt（pdf.js 对 Helvetica 的度量：
// ascent 0.718、descent −0.207，与 e2e 打包里 pdfjs-dist 同一份表）。块的字身框到基线为止，
// 老盖子只外扩 1.5 pt，剩下 ~1.4 pt 的尖会露出来——这条用例就采那条带。
const DESC_INK = { x: 80, y: 400, text: 'gypq gypq gypq', size: 14 };
const DESC_BLOCK = { x: 78, y: 400 - 14, w: 120, h: 14 };                       // 字身框：基线 − 字高 → 基线
const DESC_INKBOX = { top: 400 - 0.718 * 14, bottom: 400 + 0.207 * 14 };       // 墨迹框
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
    blocks.push({
      id: `b${p}-desc`, page: p, x: DESC_BLOCK.x, y: DESC_BLOCK.y, width: DESC_BLOCK.w, height: DESC_BLOCK.h,
      fontSize: 14, kind: 'text', source: 'gypq gypq gypq', target: '降部', ink: DESC_INKBOX,
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
  const pdf = buildPagedPdf(PAGES, PAGE_W, PAGE_H, [TARGET_INK, DESC_INK]);
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

// 脚标渲染（spec 2026-09-07-pdf-translation-scripts §6 / §8 / §9）：s1 带一个下标、一个上标占位符，
// s0 是同一串文字平排、同 bbox——两块的 data-fit 与 scrollHeight 相等，才说明 relative 偏移没撑高行框。
//
// s2 是「隔离比较」用的第三个块：target 跟 s1 逐字相同、placeholders 的 text 也不变，
// 唯独去掉 script 字段，且 kind 从 formula 改成 citation（原因见下）。s1 与 s2 里那两个 span
// 因此是同一个字符、同一块几何，唯一的差别就是 SCRIPT_STYLE 有没有生效——几何断言要比的是
// s1 与 s2 的差值，不能直接比字体框边缘（原因见下面用例里的注释）。
//
// 为什么 kind 改成 citation 而不是照抄 formula：TranslationBlocks.tsx 的 segStyle() 只在
// segment 带 script 时才会剥掉 formula 的 italic（脚标不该继承数学斜体，见该文件注释）——
// 也就是说，若 s2 的占位符仍标 kind: formula 但不带 script，它会保留 italic，而 s1 里同一个
// 字符（带 script）反而没有 italic。这样 s1 与 s2 就不止差 SCRIPT_STYLE 一个变量，还多出一个
// italic 有没有的 confound，会把「s1 的 sup.top 该比 s2 更小」这条断言的方向搅乱（italic 触发
// 的字体回退可能换成另一张度量表——实测就是这样翻车的，见下方用例的失败记录）。citation 的
// KIND_STYLE 是空对象，跟 formula 剥完 italic 之后一样——s1 与 s2 的差距因此精确收敛成
// 「SCRIPT_STYLE 加了没加」这一件事。不能用 kind: 'text'：Placeholder.kind 是协议层字段，
// 合法取值只有 PLACEHOLDER_KINDS（zhSidecar.ts）里的 formula / citation / inline-code 三个，
// 'text' 是 splitPlaceholders 给纯文本段落自己加的种类，不是边车能写的占位符 kind。
const SCRIPT_REL = 'scripts.pdf';
const SCRIPT_TEXT = '节点 ni 属于集合 X2';

function buildScriptSidecar(pdf: Buffer): string {
  const geom = { page: 1, x: 60, width: 460, height: 60, fontSize: 12, kind: 'text', source: 'node ni in set X2' };
  return JSON.stringify({
    version: 1,
    pdf: SCRIPT_REL,
    lang: { in: 'en', out: 'zh' },
    source: { sha256: createHash('sha256').update(pdf).digest('hex'), bytes: pdf.byteLength },
    blocks: [
      { id: 's1', y: 200, ...geom, target: '节点 n{v1} 属于集合 X{v2}',
        placeholders: [{ id: 'v1', kind: 'formula', text: 'i', script: 'sub' }, { id: 'v2', kind: 'formula', text: '2', script: 'sup' }] },
      { id: 's0', y: 300, ...geom, target: SCRIPT_TEXT },
      // 与 s1 唯一的差别是 SCRIPT_STYLE 没有生效（没有 script 字段；kind 改 citation 是为了
      // 不多引入 italic 这个 confound——见上面的说明）。
      { id: 's2', y: 400, ...geom, target: '节点 n{v1} 属于集合 X{v2}',
        placeholders: [{ id: 'v1', kind: 'citation', text: 'i' }, { id: 'v2', kind: 'citation', text: '2' }] },
    ],
  }, null, 2);
}

async function seedScripts(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  const pdf = buildPagedPdf(1, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, SCRIPT_REL), pdf);
  await fs.writeFile(path.join(projectPath, `.${SCRIPT_REL}.zh.json`), buildScriptSidecar(pdf));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

// Notice 那六条分支里，原先只有「译文文件有误」与「版本不匹配」两条有用例。这两份 fixture 补
// 上剩下两条**译文侧**的：几何越界被丢块（dropped > 0）、边车没写 source 摘要（version
// unknown，spec §12 明确列出的一态）。两条都是「能用但要提示」，不像前两条那样禁用对照。
const DROPPED_REL = 'dropped-blocks.pdf';
const UNKNOWN_REL = 'no-digest.pdf';

async function seedNotices(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });

  // 两条块：一条在页内，一条 y 直接越出页底（842 pt 的页放到 y = 900）→ filterByGeometry 丢掉它。
  // 留一条合法的，是为了让 doc 非空、version 仍是 ok——否则会先撞上别的分支。
  const dropped = buildPagedPdf(1, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, DROPPED_REL), dropped);
  await fs.writeFile(path.join(projectPath, `.${DROPPED_REL}.zh.json`), JSON.stringify({
    version: 1, pdf: DROPPED_REL, lang: { in: 'en', out: 'zh' },
    source: { sha256: createHash('sha256').update(dropped).digest('hex'), bytes: dropped.byteLength },
    blocks: [
      { id: 'ok1', page: 1, x: 60, y: 200, width: 460, height: 120, fontSize: 11, kind: 'text', source: 'a', target: '甲' },
      { id: 'bad1', page: 1, x: 60, y: 900, width: 460, height: 120, fontSize: 11, kind: 'text', source: 'b', target: '乙' },
    ],
  }));

  // 不写 source：checkVersion 返回 unknown —— 可用，但没法确认译文与这份 PDF 是不是同一版。
  const unknown = buildPagedPdf(1, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, UNKNOWN_REL), unknown);
  await fs.writeFile(path.join(projectPath, `.${UNKNOWN_REL}.zh.json`), JSON.stringify({
    version: 1, pdf: UNKNOWN_REL, lang: { in: 'en', out: 'zh' },
    blocks: [
      { id: 'ok1', page: 1, x: 60, y: 200, width: 460, height: 120, fontSize: 11, kind: 'text', source: 'a', target: '甲' },
    ],
  }));

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
    if (await right.count() > 0) { await settleLayers(pane); return; }
    await page.keyboard.press('l');
    if (await right.count() > 0) { await settleLayers(pane); return; }
    await page.waitForTimeout(200);
  }
  throw new Error('按 L 没能进入双栏对照：译文边车迟迟没加载');
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

test('57-pdf-dual-pane: 右格拷的是左格位图，译文块与右格底图同坐标系', async () => {
  // 几何（顶对齐、等高、真在另一栏里、左格显式宽）由「同页两格按栏顶对齐」那条用例管，这条只管
  // **画了什么**：右格的位图是不是真从左格拷过来的一份，以及译文 HTML 层是不是压在同一套坐标上。
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

    await enterDual(page, pane);

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
    await expect.poll(async () => page.evaluate(({ lsel, rsel }) => {
      const l = document.querySelector(`${lsel} canvas`) as HTMLCanvasElement | null;
      const r = document.querySelector(`${rsel} canvas[data-pdf-right]`) as HTMLCanvasElement | null;
      return !!l && !!r && l.width > 0 && r.width === l.width;
    }, { lsel: leftRowSel(paneSel, 1), rsel: rightRowSel(paneSel, 1) }),
    { timeout: 10000, message: '等右格合成' }).toBe(true);

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
      const c = document.querySelector(`${sel} canvas[data-pdf-right]`) as HTMLCanvasElement | null;
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
    }, { sel: rightRowSel(paneSel, 1), box: TARGET_SAMPLE, pageW: PAGE_W });
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

    // 给 document.fonts.load 包一道**由测试自己开关的闸门**（真实加载照常发生，只是把 "resolve"
    // 这件事扣在闸门后面）——不赌真实加载会不会恰好落在某个时间点上，而是自己造一段"肯定还没
    // 到位"的窗口。实现如果按 spec 内部 await 这个调用，闸门没开之前就不该已经测过；不 await
    // 的话，会在闸门后面就测完并把（可能用了回退字体量出来的）结果写进 state。
    //
    // 早先这里写的是 setTimeout 的定时延迟，判据里就混进了一个墙上时间：enterDual 要等缩放
    // 双缓冲顶替完才返回（settleLayers），慢机上这一段能吃掉一秒以上，延迟不够长时读到的
    // 已经是量完的字号，用例的前提自己先不成立（CI darwin-arm64 实测读到 4.32605px）。
    // 加长延迟只是把这个赌注推远，闸门则彻底不赌：什么时候放行由测试说了算。
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
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 翻译键六态——none / invalid / mismatch 从禁用变可点即现翻，tooltip 随态而变，ready 仍进对照', async () => {
  const launched = await launchKydog({ seed: seedFourStates });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');

    // 每次 openPdf 都切到一个新 tab（前一个 tab 的 pane 随之被 display:none 藏起来），所以
    // Notice 文案的可见性断言必须紧跟在对应的 openPdf 之后，不能攒到最后一起查。
    //
    // tooltip 文案走 aria-label 断言，不走 hover：IconButton 把 `aria-label={ariaLabel ?? tooltip}`
    // 无条件写在按钮元素本身上（不受 disabled 影响，见 IconButton.tsx），比真的悬停触发 Tooltip
    // 组件更直接、也更不脆——这里要验证的是"文案对不对"，不是"Tooltip 组件本身能不能弹出来"。
    // 只断言按钮可点（toBeEnabled）而不看 tooltip 文案，会让这条用例退化成"三个态都可点"、
    // 分不出 none（翻译）与 invalid/mismatch（重新翻译）这两种不同语义。
    const none = await openPdf(page, path.join(projectPath, NONE_REL));
    const noneBtn = none.getByTestId('pdf-translate');
    await expect(noneBtn).toBeEnabled();
    await expect(noneBtn).toHaveAttribute('aria-label', '翻译 · L');

    const invalid = await openPdf(page, path.join(projectPath, INVALID_REL));
    const invalidBtn = invalid.getByTestId('pdf-translate');
    await expect(invalidBtn).toBeEnabled();
    await expect(invalidBtn).toHaveAttribute('aria-label', '重新翻译 · L');
    await expect(invalid.getByText(/译文文件有误/)).toBeVisible();

    const mismatch = await openPdf(page, path.join(projectPath, MISMATCH_REL));
    const mismatchBtn = mismatch.getByTestId('pdf-translate');
    await expect(mismatchBtn).toBeEnabled();
    await expect(mismatchBtn).toHaveAttribute('aria-label', '重新翻译 · L');
    await expect(mismatch.getByText(/另一个版本的 PDF/)).toBeVisible();

    const ready = await openPdf(page, path.join(projectPath, READY_REL));
    const readyBtn = ready.getByTestId('pdf-translate');
    await expect(readyBtn).toBeEnabled();
    await expect(readyBtn).toHaveAttribute('aria-label', '翻译对照 · L');
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

    // 分栏之后一行恒是**一页**宽（两栏各 map 一遍同一份 sizes，行宽都是 `size.w × scale`），
    // 不再是 v7 之前那个「一行 = 2 × 595pt + 16pt 间距」的单容器版面。变窄的是**视口**：进对照
    // 那一刻左栏从铺满 wrapper 变成约一半，而 fit 对着较窄那一栏。默认窗口（main pane 减去两条
    // 侧栏之后）的一半明显放不下 595pt，所以缩放会被降到刚好放下，读数跟着变小。
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
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    const readout = pane.getByTestId('pdf-readout');
    const before = await readout.textContent();

    await enterDual(page, pane);
    // 提交收敛之后位图与显示同档、外层 zoom 回到 1——下面的判据就建立在这个前提上：还没还原时
    // zoom 恒为 1，还原了就是 1 / fit。fit 不猜数字，从协议层事实现推：对照期间清晰层左格
    // canvas 的 CSS 宽就是 size.w × layer.scale。
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
      .toBeCloseTo(PAGE_W / duringW, 1);
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
    // 测不出「右格是不是真的没有标注层」这件事。`[data-pdf-page]` 两栏都有，先限到右栏。
    const rightCell = pane
      .locator('[data-pdf-pane="right"] [data-pdf-page="1"] [data-pdf-right="1"]')
      .locator('xpath=..');
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

test('57-pdf-dual-pane: Notice——几何越界丢块、没写源摘要，两条都提示且都不禁用对照', async () => {
  const launched = await launchKydog({ seed: seedNotices });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');

    // 每次 openPdf 都切到新 tab（前一个 pane 被 display:none 藏起来），断言必须紧跟其后。
    const dropped = await openPdf(page, path.join(projectPath, DROPPED_REL));
    await expect(dropped.getByTestId('pdf-notice')).toHaveText(/1 条译文块超出页面范围，已跳过/);
    // 只是丢了一条越界的块，剩下的照样能对照——这条提示不该顺手把功能关掉
    await expect(dropped.getByTestId('pdf-translate')).toBeEnabled();

    const unknown = await openPdf(page, path.join(projectPath, UNKNOWN_REL));
    await expect(unknown.getByTestId('pdf-notice')).toHaveText(/未记录源文件摘要/);
    await expect(unknown.getByTestId('pdf-translate')).toBeEnabled();
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

    // 同 551：限到 stable 层。缩放双缓冲期间两层各渲染一份同页的块，不限层这条 toHaveCount(1)
    // 会红在 2 上，而红的原因跟这条用例要验的排版一致性毫无关系。
    const block = page.locator(`${rightRowSel(paneSel, 1)} [data-translation-block="m1"]`);
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
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 脚标占位符按下标 / 上标排——字号更小、基线偏移，且不改行框高度', async () => {
  const launched = await launchKydog({ seed: seedScripts });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', SCRIPT_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await enterDual(page, pane);

    // 必须限到右栏 stable 层（rightRowSel 是本文件已有的 helper）：缩放双缓冲期间两层各渲染
    // 一份同页的块，不限层这里就是 strict mode 命中两个（899990c 为此修过本文件两条用例）。
    const s1 = page.locator(`${rightRowSel(paneSel, 1)} [data-translation-block="s1"]`);
    const s0 = page.locator(`${rightRowSel(paneSel, 1)} [data-translation-block="s0"]`);
    const s2 = page.locator(`${rightRowSel(paneSel, 1)} [data-translation-block="s2"]`);
    await expect(s1).toHaveCount(1);
    await expect(s1).toHaveText(SCRIPT_TEXT);
    // 等三块的测量都落地（data-fit 只在 fits 落地后才挂）
    await expect.poll(async () => s1.getAttribute('data-fit'), { timeout: 15000, message: 's1 字号测量' }).not.toBeNull();
    await expect.poll(async () => s0.getAttribute('data-fit'), { timeout: 15000, message: 's0 字号测量' }).not.toBeNull();
    await expect.poll(async () => s2.getAttribute('data-fit'), { timeout: 15000, message: 's2 字号测量' }).not.toBeNull();

    // 为什么不直接比字体框边缘（sub.bottom > text.bottom、sup.top < text.top）：
    // 正文是中文，实际落在 Noto Serif SC / Songti SC；脚标只有一个拉丁字符，走的是字体栈里
    // 更靠前的 Source Serif 4——两边字形来自不同字体。但真正让「比边缘」这条路走不通的，
    // 不止是字体不同源：实测发现（用 Range 对照过 Element 的 getBoundingClientRect，两者
    // 数值一致，不是量法的问题）浏览器算一个 inline span 的行框边缘时，用的是它*自己*的
    // font-size 乘无单位 line-height 再对半分——跟正文同一行但字号更小的 span，行框天然更矮，
    // 上下两条边缘都会向基线方向收拢，收拢的量往往比 0.15em / 0.36em 这组位移本身还大。
    // 于是脚标即使真被位移推开了，边缘也可能量不出来、甚至量出反方向——这正是这条断言之前
    // 稳定翻车的地方（12pt 块下 sub.bottom 只比 text.bottom 低 0.297px，不过 0.5px 门槛；
    // sup.top 反而比 text.top 还大，方向都不对），换成 s1/s2 隔离比较之后依然翻车，数值分毫
    // 不差——说明问题不在「两块比较 vs 单块比较」，在「边缘」这个量本身。
    //
    // 而截图（.superpowers/sdd/2026-09-07-pdf-translation-scripts/scripts-render.png，人眼可查）
    // 看得很清楚：上标「2」确实顶在正文字符的顶部附近，下标「i」
    // 确实沉到正文下方——视觉上没有问题。能把这份视觉直觉转成断言的，是**行框中点**而不是
    // 边缘：`position: relative; top: Xem` 是一次纯平移，对边缘和中点施加的是同一个像素位移；
    // 而「字号变小→行框收拢」这个会污染判断的效应，边缘各自被推向基线（一个往下一个往上），
    // 中点受到的净影响很小（本例中量出来只有 0.2px 量级）。换算下来 sub 中点差值约 1.55px、
    // sup 中点差值约 -1.16px（下面 s2 是完全平排的对照组，中点差值恒为 0）——同一组数据，
    // 边缘量出来是「过不了 0.5px 门槛、方向还错」，中点量出来是「方向对、留了一个多像素的
    // 余量」，两者不是同一件事的两种写法，是中点排除了边缘量法自带的那份噪声。
    //
    // 隔离比较本身仍然保留：s2 与 s1 是同一段文字、同一块几何，placeholders 里唯独没有
    // script 字段（kind 改成 citation 而不是照抄 formula——见上面 buildScriptSidecar 的注释,
    // 否则会多引入 italic 这个 confound）。s1 与 s2 里对应位置的 span 因此是完全同源的字符，
    // 唯一的差别就是 SCRIPT_STYLE 有没有生效；s2 的中点差值恒为 0，天然是一份「没有任何脚标
    // 效应」的对照基线。
    //
    // 定位 span 用位置序号、不用 data-script：s2 的占位符没有 script 字段，渲染不出 data-script
    // 属性。splitPlaceholders 的输出顺序是确定的——按 target 里 {vN} 出现的先后，先把前面的
    // 纯文本段推进去，再推占位符段——s1 与 s2 的 target/placeholders 除 script 外逐字相同，
    // 所以两块的 span 顺序也逐一对应：下标 0 是 v1 前的正文，下标 1 是 v1（sub 位），下标 2 是
    // v1、v2 之间的正文，下标 3 是 v2（sup 位）。取 querySelectorAll('span') 的第 0/1/3 个。
    const measure = (block: Locator) => block.evaluate((el) => {
      const spans = Array.from(el.querySelectorAll('span'));
      const center = (sp: Element) => {
        const r = sp.getBoundingClientRect();
        return (r.top + r.bottom) / 2;
      };
      return {
        textCenter: center(spans[0]), subCenter: center(spans[1]), supCenter: center(spans[3]),
        subPx: parseFloat(getComputedStyle(spans[1]).fontSize),
        supPx: parseFloat(getComputedStyle(spans[3]).fontSize),
      };
    });
    const geo1 = await measure(s1);
    const geo2 = await measure(s2);

    // 字号：0.73em 在 s1 上生效，s2 没有——同一个字符（'i' / '2'）s1 的字号应严格小于 s2 的。
    // 证伪：把 SCRIPT_STYLE 改成 {} → s1 的 subPx/supPx 会等于 s2 的（同一字体同一字号），两条转红。
    expect(geo1.subPx, '下标字号应小于同字符不带脚标的字号').toBeLessThan(geo2.subPx);
    expect(geo1.supPx, '上标字号应小于同字符不带脚标的字号').toBeLessThan(geo2.supPx);

    // 下标方向：s1 的「sub 中点相对正文中点的差值」应比 s2 的同一差值（恒为 0）更大——
    // 中点更靠下才是下标该有的方向。证伪：SCRIPT_STYLE 改 {} 之后 s1 也退化成中点差值 0，
    // 不再大于 s2 的 0，转红。
    const subDelta1 = geo1.subCenter - geo1.textCenter;
    const subDelta2 = geo2.subCenter - geo2.textCenter;
    expect(subDelta1, `下标中点相对正文中点的差值应比不带脚标时更大（s1=${subDelta1}, s2=${subDelta2}）`)
      .toBeGreaterThan(subDelta2);

    // 上标方向：同理，s1 的「sup 中点相对正文中点的差值」应比 s2 的更小（更靠上）。
    const supDelta1 = geo1.supCenter - geo1.textCenter;
    const supDelta2 = geo2.supCenter - geo2.textCenter;
    expect(supDelta1, `上标中点相对正文中点的差值应比不带脚标时更小（s1=${supDelta1}, s2=${supDelta2}）`)
      .toBeLessThan(supDelta2);

    // §9 待实测：relative 偏移不改行框——同文、同 bbox 的平排块，fit 与 scrollHeight 都相同。
    expect(await s1.getAttribute('data-fit')).toBe(await s0.getAttribute('data-fit'));
    const h1 = await s1.evaluate((el) => el.scrollHeight);
    const h0 = await s0.evaluate((el) => el.scrollHeight);
    expect(h1, `带脚标 ${h1} 与平排 ${h0} 的行框高度应相同`).toBe(h0);
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

test('57-pdf-dual-pane: 同页两格按栏顶对齐、等高——右格真在另一栏里，滚动与缩放后仍成立', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

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
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 两栏滚动同步——纵横两轴、两个方向都互写', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

    await enterDual(page, pane);
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

    // 横向要先有得滚：进对照会 fit-width（页宽 = 栏宽），捏到 200% 附近才溢出。真正的前提是
    // 下面这个 maxLeft，不是读数落在哪个整数上（读数取整会让落点差 1%，见另一条用例的注释）。
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
  } finally {
    await teardown(launched);
  }
});

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

test('57-pdf-dual-pane: 两栏不等宽时内容左边缘仍对齐——窄栏滚到头，宽栏停在自己的上界', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

    await enterDual(page, pane);

    // 捏到 200%：进对照会 fit-width（页宽正好贴住较窄那栏），横向得先有得滚才谈得上「左边缘对齐」。
    const startPct = readoutPct((await pane.getByTestId('pdf-readout').textContent())!);
    await pinchTo(page, pdfPath, startPct, 200);

    // 把分隔线往左拖 150 px：两栏从此不等宽，而**内容**宽两栏仍逐字段相同（同一份 sizes ×
    // 同一个 layer.scale）。这正是「不等宽时 scrollLeft 原样相等」这条约定要面对的局面。
    const c = await dividerCenter(pane);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x - 150, c.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(
      async () => {
        const w = await paneBoxWidths(page, paneSel);
        return w ? w.right - w.left : 0;
      },
      { timeout: 5000, message: '等分隔线拖动落地：右栏应当比左栏宽出约 300' },
    ).toBeGreaterThan(200);

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
  } finally {
    await teardown(launched);
  }
});

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
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    const readout = pane.getByTestId('pdf-readout');

    await enterDual(page, pane);
    await pinchTo(page, pdfPath, readoutPct((await readout.textContent())!), 200);

    // 分隔线往左拖 150：左栏变窄、右栏变宽，两栏可视宽从此差约 300
    const c = await dividerCenter(pane);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x - 150, c.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(
      async () => {
        const w = await paneBoxWidths(page, paneSel);
        return w ? w.right - w.left : 0;
      },
      { timeout: 5000, message: '等分隔线拖动落地：右栏应当比左栏宽出约 300' },
    ).toBeGreaterThan(200);

    // 窄栏滚到自己的上界，宽栏被夹在自己的上界上 —— 两栏 scrollLeft 从此不等
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
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 拖分隔线改两栏宽度，拖到最右右栏也不小于 MIN_PANE_PX', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

    await enterDual(page, pane);
    const divider = pane.getByTestId('pdf-pane-divider');
    await expect(divider).toBeVisible();
    const c = await dividerCenter(pane);
    expect(c.w, '分隔线的命中区宽就是 DIVIDER_PX').toBeCloseTo(DIVIDER_PX, 1);

    // 按住之后先原地挪一小段：clampSplit 把「指针到 wrapper 左边缘的距离」直接当左栏宽，而
    // 命中区中心比左栏右边缘还靠右 DIVIDER_PX / 2。先挪一次把基准落到指针上，后面那 150 才是
    // 干干净净的 150（不然会多出这半条命中区的宽度）。
    // 等的是「左栏真的变宽了」，不是「左栏有宽度」——后者进对照之后恒真，poll 会立刻通过，
    // 那时 React 可能还没 commit 这次拖动，读走的 base 是拖动前的宽度，下面那个 150 就变成
    // 160（多算了上面这 10）。
    const l0 = (await paneBoxWidths(page, paneSel))!.left;
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 10, c.y, { steps: 3 });
    await expect.poll(
      async () => (await paneBoxWidths(page, paneSel))?.left ?? 0,
      { timeout: 5000, message: '等第一次拖动落地' },
    ).toBeGreaterThan(l0 + 5);
    const base = (await paneBoxWidths(page, paneSel))!;

    // 再往右挪一段：左栏宽 +DX、右栏宽 −DX（两栏加分隔线恒等于 wrapper，见 paneWidths）。
    // DX 从**当前窗口实际的可用余量**算，不写死：clampSplit 的上限是 usable − MIN_PANE_PX，
    // 写死 150 的话，主面板窄到左栏离上限不足 150 时这一段会被 clamp 掉——量到的位移就不是
    // 150，而这条用例断的恰恰是「位移等量」。CI darwin-arm64 的主面板只有 474 px 宽，左栏
    // 上限 348，从 248 出发只挪得动 100，于是红在 348 上（本机窗口宽，从来撞不到）。
    // 取余量的一半：既保证落点离上限还有距离（这一段不会被 clamp），又保证 DX 本身够大。
    const usable = base.wrapWidth - DIVIDER_PX;
    const DX = Math.min(150, Math.floor((usable - MIN_PANE_PX - base.left) / 2));
    expect(DX, `主面板窄到没有可用的拖动余量，这条用例失去意义 ${JSON.stringify(base)}`)
      .toBeGreaterThan(20);
    await page.mouse.move(c.x + 10 + DX, c.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(
      async () => (await paneBoxWidths(page, paneSel))?.left ?? 0,
      { timeout: 5000, message: '等第二次拖动落地' },
    ).toBeGreaterThan(base.left + DX - 2);
    const moved = (await paneBoxWidths(page, paneSel))!;
    // ±2 px 是断言容差（设备像素网格 / LayoutUnit 取整），不是判据：位移本身由 clampSplit
    // 逐像素定义，实现算错的话差的是整栏的量级。
    expect(moved.left - base.left, `左栏应当加宽 ${DX} ${JSON.stringify({ base, moved, DX })}`)
      .toBeGreaterThan(DX - 2);
    expect(moved.left - base.left).toBeLessThan(DX + 2);
    expect(base.right - moved.right, `右栏应当同量变窄 ${JSON.stringify({ base, moved, DX })}`)
      .toBeGreaterThan(DX - 2);
    expect(base.right - moved.right).toBeLessThan(DX + 2);

    // 再一路拖到 wrapper 最右边：clampSplit 的上限（usable − MIN_PANE_PX）该把右栏钉在最小宽上。
    // 分隔线已经被上一次拖动挪走了，位置必须重新量——按老坐标按下去按的是左栏，什么都不会发生。
    const c2 = await dividerCenter(pane);
    // 位移量跟着上面那个 DX 走，不写死：窄窗口下 DX 会小于 150，写死 100 会红在「分隔线没挪够」
    // 上，而它其实挪的正是 clampSplit 允许的那一段（1024 px 窗口实测 DX≈54，分隔线挪了 64）。
    expect(c2.x, `分隔线应当跟着上一次拖动往右挪了 DX=${DX}`).toBeGreaterThan(c.x + DX - 2);
    const hugeX = base.wrapRight + 400;
    await page.mouse.move(c2.x, c2.y);
    await page.mouse.down();
    await page.mouse.move(hugeX, c2.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(
      async () => (await paneBoxWidths(page, paneSel))?.right ?? Infinity,
      { timeout: 5000, message: '等拖到最右落地' },
    ).toBeLessThan(moved.right);
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
    const c3 = await dividerCenter(pane);
    await page.mouse.dblclick(c3.x, c3.y);
    await expect.poll(
      async () => { const w = await paneBoxWidths(page, paneSel); return w ? Math.abs(w.left - w.right) : Infinity; },
      { timeout: 5000, message: '双击分隔线之后两栏应当等宽' },
    ).toBeLessThan(1);
    const centered = (await paneBoxWidths(page, paneSel))!;
    expect(centered.left, `等宽 = paneWidths(wrapW, 0.5).left ${JSON.stringify(centered)}`)
      .toBeCloseTo(paneWidths(centered.wrapWidth, 0.5).left, 0);

    // 拖完滚一次：分隔线换了宽度，同步链路照旧（两个容器没被重建，监听也没被摘掉）。
    await setPaneScroll(page, paneSel, 'left', 'top', 240);
    await expect.poll(
      async () => (await paneScroll(page, paneSel, 'right'))?.top,
      { timeout: 5000, message: '拖完之后两栏的 scrollTop 仍应当相等' },
    ).toBe(240);
  } finally {
    await teardown(launched);
  }
});

import { FADE_MS, THUMB_HOVER_PX, THUMB_INSET_PX, scrollPosForThumb } from '../src/renderer/panels/main-pane/pdf/overlayScrollbar';

test('57-pdf-dual-pane: 覆盖式滚动条——没有槽、滚动时拇指出现后淡出、拖拇指按同一映射滚且另一栏跟上', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await enterDual(page, pane);

    // ① 没有槽：两栏 clientWidth === offsetWidth、clientHeight === offsetHeight。占位式滚动条
    //    会让 client 比 offset 少 8px（globals.css 里 .ky-scroll 给的宽），这两个数是协议层事实。
    //    这条断言测的是「量本身」，不是靠猜哪条 CSS 规则起了作用——留意它在这台 macOS 机器上测不出
    //    「把 .ky-scroll-overlay 整条规则清空」这类回归：macOS 默认就是滚动时才现的浮层滚动条，
    //    裸 overflow-auto 不加任何自定义样式本来就不占位，删规则在这里仍然绿，不是断言失效，是这条
    //    回归在这台机器上本来就不存在。真正会红、且已经在 Step 6 复现过的，是「class 名回退成
    //    .ky-scroll」这个具体场景——`.ky-scroll::-webkit-scrollbar { width: 8px }` 强制 Blink 走
    //    classic 模式、留 8px 槽。在 Windows / Linux（默认经典滚动条，不是浮层模式）上，删掉
    //    `.ky-scroll-overlay` 整条规则本身也会让这条断言红——只是这台 macOS 机器测不出那一支。
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
    // 拇指可见时的中心点：留着淡出之后再点这个坐标，断言那条热区收起来了。
    const thumbCenter = await page.evaluate((sel) => {
      const t = document.querySelector(`${sel} [data-testid="pdf-thumb-y-left"]`) as HTMLElement;
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, paneSel);
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
  } finally {
    await teardown(launched);
  }
});

test('57-pdf-dual-pane: 盖子按墨迹矩形——最后一行的降部不再从块底漏出来', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await enterDual(page, pane);
    await expect.poll(async () => page.evaluate(({ lsel, rsel }) => {
      const l = document.querySelector(`${lsel} canvas`) as HTMLCanvasElement | null;
      const r = document.querySelector(`${rsel} canvas[data-pdf-right]`) as HTMLCanvasElement | null;
      return !!l && !!r && l.width > 0 && r.width === l.width;
    }, { lsel: leftRowSel(paneSel, 1), rsel: rightRowSel(paneSel, 1) }), { timeout: 10000 }).toBe(true);

    // 采样带：基线下 1.5–3 pt（老盖子的下沿到降部尖之间），x 取那行字的范围。
    const band = { x: DESC_INK.x, y: DESC_INK.y + 1.5, w: DESC_BLOCK.w - 4, h: 1.5 };
    // 判据是「这条带是不是一色」，不是「够不够黑」。绝对亮度阈值（原来写的是三通道和 < 300）
    // 只在开发机那种大位图上成立：对照的 rasterScale 只有 0.39 上下，14 pt 字的降部尖缩到亚
    // 像素，抗锯齿把它抹成浅灰，数出来永远是 0——红的原因跟「盖子盖没盖住」毫无关系。
    // 盖住了就是被填成同一个页背景色（一色），没盖住就有墨迹（不止一色）；这个判据不含任何
    // 阈值，也不随缩放变，与上面「有 target 的块矩形内没有原文残留」那条同一手法。
    const uniform = await page.evaluate(({ lsel, rsel, band, pageW }) => {
      const oneColor = (c: HTMLCanvasElement) => {
        const S = c.width / pageW;
        const d = c.getContext('2d')!.getImageData(
          Math.round(band.x * S), Math.round(band.y * S),
          Math.max(1, Math.round(band.w * S)), Math.max(1, Math.round(band.h * S)),
        ).data;
        for (let i = 4; i < d.length; i += 4) {
          if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false;
        }
        return true;
      };
      return {
        left: oneColor(document.querySelector(`${lsel} canvas`) as HTMLCanvasElement),
        right: oneColor(document.querySelector(`${rsel} canvas[data-pdf-right]`) as HTMLCanvasElement),
      };
    }, { lsel: leftRowSel(paneSel, 1), rsel: rightRowSel(paneSel, 1), band, pageW: PAGE_W });
    expect(uniform.left, '左格那条带里得真有降部墨迹（不该是一色），右格「盖住了」才谈得上').toBe(false);
    expect(uniform.right, `右格那条带该被页背景色填平、不再有降部尖 ${JSON.stringify(uniform)}`).toBe(true);
  } finally {
    await teardown(launched);
  }
});
