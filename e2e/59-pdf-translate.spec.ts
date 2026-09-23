import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector, type LaunchedApp } from './helpers';
import { buildNoTextPdf, buildPagedPdf } from './fixtures/textPdf';
import { RPC_CHANNEL } from '../src/shared/protocol';
import type { TranslatedDoc } from '../src/shared/zhSidecar';

/**
 * 翻译流水线的端到端用例（spec `2026-09-05-pdf-translation-pipeline-design.md`）。
 *
 * 逐页响应走 `KYDOG_TRANSLATE_FIXTURE`（launchKydog 的 translateFixture 选项）：主进程仍走
 * `pdfTranslatePage.ts` 那条同样的 semaphore 与并发路径，只是不碰上游模型。fixture 的形状是
 * `{ "<页码>": [{ text, stopReason }] }`，`text` 是 §6 那份 `%%` 协议的原样输出——解析与三层
 * 校验在渲染层，e2e 与生产因此跑的是同一份纯函数。响应**按页、按调用顺序出队**，队列在一次启动
 * 里是全局的（不分 PDF、不分作业），取空当场报错——所以一次启动里跑几趟作业，fixture 就得按这几趟
 * 真正消费的顺序拼好（见下面三个 fixture 常量的注释）。
 *
 * **三次启动，每次一个起点**（`docs/e2e-guide.md` §2：串行共用一次启动，每个说法仍是一条独立的
 * `test()`；上一条的状态是下一条的起点）：
 *   - A「首次翻译、作业停在半路」：无边车的 plain.pdf，闸门扣住第 1 页的版面请求——进双栏、右格空白、
 *     边车重探、取消都在同一趟作业上看；最后换第二份 PDF（没有文本层 + 坏边车）看失败路径。
 *   - B「从对照态出发」：有可用译文的 ok.pdf——确认框取消 / 确认、对照中取消重译、重译本页、
 *     跑到底的全部重译、最后删除译文（删边车那步只能放最后）。
 *   - D「跑完之后」：plain.pdf 一趟带失败页的翻译停在 finalize、放行跑完——然后看结果：像素、
 *     「N 页翻译失败」的落点与寿命、重试失败页。
 * 各段开头写了段内的顺序约束。
 *
 * 流水线本身的分支（重试、截断对半拆、补漏、空译文判失败、脚标记号、两步协议、标题字号、页回收）
 * 不在这里：它们是纯逻辑，由 `translateDoc.test` / `translateProtocol.test` / `layoutProtocol.test`
 * / `buildBlocks.test` / `blockLayout.test` / `fitFontScale.test` / `pageLifecycle.test` 等单测守；
 * 按 L 的放行判据由 `annotationKeys.test` 守，resolveModel 那句「没有可用的模型」由
 * `pdfTranslationResolveModel.test` 守。这里只留单测证明不了的：渲染层与主进程真服务之间的往返、
 * 盘上的边车、右格真画出来的像素与真实版面几何。
 *
 * 「哪几页失败」这个信号最终**收口进了边车**（`TranslatedDoc.failedPages`，跑翻译那一趟写）。
 * 在那之前它只从 `onProgress` 侧信道漏出一个瞬时数字、由渲染层的 store 存着，于是「这个数字
 * 该活多久」被迫成了一个下游问题：保留会在 agent 重写边车后显示陈旧计数，归零则让它撑不过一次
 * 切窗口（focus 重探）。落进边车之后它天然描述当前这份 doc，两难自己消失。守这件事的是 D 段的
 * 两条用例：跑完仍显示、**切一次窗口之后仍显示**（重探从盘上读回真值——那条是这套修法的回归点）。
 */

// A：一趟作业，被取消在第 1 页的版面上；放行之后那条版面响应照常落地，runPage 随即在两步之间的
// 取消检查点上早退（translateDoc「版面已回、第二步还没发」），只吃掉第 1 页的版面响应。第二份 PDF
// 抽不出字，一条都不吃。
const TRANSLATE_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4.json');
// B：从对照态出发的三趟作业共用一份，按消费顺序拼接：
//   ① 对照中发起、被取消的全部重译（同上，放行之后只落地第 1 页的版面）→ 第 1 页头一条（版面）；
//   ② 重译第 2 页 → 第 2 页第一对（译文「第二页的译文」）；
//   ③ 跑到底的全部重译 → 第 1 页余下那一对、第 2 页第二对、第 3、4 页各一对。
const FROM_READY_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4-from-ready.json');
// D：第 2 页版面合法（`1 | text`），坏的是第二步。全文跑现在是**两轮**（translateDoc 的
// FULL_RUN_PAGE_ATTEMPTS）：主轮两次翻译响应都不是 id 头（parseTranslations 两次都抛
// GroupError），收尾重试那一轮整页重来（版面再一次 + 翻译一次）仍然不是 id 头，页号 2 才被记进
// failedPages；其余三页正常成功——用来验证「1 页失败」这个信号真的落进了边车、并且活得够久。
// **撑到 300+ 字的是收尾轮那一条**（悬停原因那条量换行用）：边车记的是最后一轮的原因。
// 第 2 页末尾那一对（版面 + 「第二页的译文（重试之后）」）留给「重试失败页」发起的第二趟。
const FAIL_THEN_RETRY_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4-one-fails-then-retry.json');

const PAGE_W = 595;
const PAGE_H = 842;
// 4 页：fixture 逐页给响应，页数只要够「多页并发」这条路径成立即可。作业停在哪儿由下面的闸门
// 决定，不由页数多少决定——所以这里没有必要堆页数去换时间窗口。
const PAGES = 4;

const PLAIN_REL = 'plain.pdf';          // 无边车 → 翻译键的动作是「跑流水线」
const SCAN_REL = 'scan.pdf';            // A 段第二份：没有文本层 + 结构坏掉的边车（invalid 态）
const SCAN_ZH_REL = '.scan.pdf.zh.json';
const READY_REL = 'ok.pdf';             // 有可用译文 → 先进对照，再重新翻译
const READY_ZH_REL = '.ok.pdf.zh.json';

// buildPagedPdf 每页写一行 24 pt 的「Page N」，基线在 PDF y = h - 60，换成 scale 1 视口坐标
// （y 向下）大致落在 y ∈ [43, 60]、x ∈ [40, 115]。这个框把那行墨迹整个包住——**右格空不空白**
// 的判据就采在它里面：空白时逐像素都是主题纸色，照常合成时这里有原文的暗像素。
const INK = { x: 30, y: 35, w: 110, h: 30 };
// ok.pdf 那份边车里唯一一条有 target 的块。刻意避开 INK：重译前要能同时观察到「右格照常合成
// （INK 里有墨迹）」与「译文块渲染出来了」，两者不能互相遮挡。
const READY_BLOCK = { x: 60, y: 200, w: 460, h: 120 };
// 越界块（I-1 回归）：x + width、y + height 都远超 595×842，filterByGeometry 会把它从内存里的
// doc.blocks 过滤掉、Notice 显示「1 条译文块超出页面范围，已跳过」。它照样是一条合法的
// TranslatedDoc.Block（schema 不管上界，只有 filterByGeometry 管），留在磁盘上。
const DROPPED_BLOCK_ID = 'seed-dropped';

const LOAD = 'pdf.translation.load';

async function seedPlain(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, PLAIN_REL), buildPagedPdf(PAGES, PAGE_W, PAGE_H));
  // 不写 .plain.pdf.zh.json —— pdf.translation.load 对 ENOENT 返回 { doc: null }，即 `none` 态
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

/**
 * A 段：plain.pdf（同 seedPlain）之外再放一份 scan.pdf——没有文本层（内容流里只有图形算子），
 * 旁边摆一份结构坏掉的边车。
 *
 * 两样凑在一起才测得到「确认框取消不该抹掉仍然成立的提示」：坏边车让翻译键处在 invalid 态（主键的
 * 动作是「覆盖磁盘上那份坏文件」，要先过 confirm），没有文本层让任何一次真发起的翻译都在抽取阶段
 * 失败、在 Notice 上留下一条「翻译失败：这份 PDF 没有文本层」。
 */
async function seedFirstRun(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, PLAIN_REL), buildPagedPdf(PAGES, PAGE_W, PAGE_H));
  await fs.writeFile(path.join(projectPath, SCAN_REL), buildNoTextPdf(PAGES, PAGE_W, PAGE_H));
  // kind 不认识 → validateTranslatedDoc 拒整份文件 → pdf.translation.load 抛 → setLoadError。
  await fs.writeFile(path.join(projectPath, SCAN_ZH_REL), JSON.stringify({
    version: 1, pdf: SCAN_REL, lang: { in: 'en', out: 'zh' },
    blocks: [{
      id: 'bad1', page: 1, x: 60, y: 200, width: 100, height: 20,
      fontSize: 11, kind: 'paragraph', source: 'a body paragraph', target: '译文',
    }],
  }, null, 2));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

async function seedReady(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  const pdf = buildPagedPdf(PAGES, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, READY_REL), pdf);
  // 摘要就地按同一份字节算真值：写死常量的话 fixture 一改就悄悄变成 mismatch，而 mismatch 与
  // ready 在这条用例里是两个不同的起点，整条会以看不出原因的方式失效。
  await fs.writeFile(path.join(projectPath, READY_ZH_REL), JSON.stringify({
    version: 1,
    pdf: READY_REL,
    lang: { in: 'en', out: 'zh' },
    source: { sha256: createHash('sha256').update(pdf).digest('hex'), bytes: pdf.byteLength },
    blocks: [{
      id: 'seed1', page: 1,
      x: READY_BLOCK.x, y: READY_BLOCK.y, width: READY_BLOCK.w, height: READY_BLOCK.h,
      fontSize: 11, kind: 'text', source: 'a body paragraph', target: '这是上一版的译文',
    }, {
      // 越界块：不在任何一次内存合成里出现（filterByGeometry 丢它），但必须在磁盘上活下来——
      // I-1 钉的就是这个（见 DROPPED_BLOCK_ID 上面的注释）。
      id: DROPPED_BLOCK_ID, page: 1, x: 900, y: 900, width: 40, height: 10,
      fontSize: 11, kind: 'text', source: 'off-page paragraph', target: '这条块本不该出现在任何页面上',
    }],
  }, null, 2));
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
 * 按 L 进对照。判据是协议事实，不是反复按：翻译键报出 ready 态（`翻译对照 · L`：边车已加载、
 * 摘要对得上、页尺寸就绪）之前按 L 什么都不会发生，之后按一次就进。原来的写法是每 200 ms 按一次
 * 直到右格出来。
 */
async function enterDual(page: Page, pane: Locator) {
  await expect(pane.getByTestId('pdf-translate'), '等译文边车加载完（ready 态）再按 L')
    .toHaveAttribute('aria-label', '翻译对照 · L');
  await pane.locator('[data-testid^="pdf-scroll-"]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('l');
  await expect(pane.locator('[data-pdf-right="1"]').first(), '按 L 应当进入双栏对照').toBeVisible();
}

/**
 * 「重新翻译」会覆盖磁盘上已有的边车（invalid / mismatch 主键、active 态的 pdf-retranslate 键
 * 三个入口皆是），项目负责人拍板走统一的 confirm() 对话框（PdfFileTab 里三处判据见 onToggleDual
 * / onRetranslate 的注释）。三个入口弹出的是同一个 ConfirmHost/ConfirmDialog，这里只封一遍
 * 「确认」分支，不在每条用例里重复断言对话框长什么样——对话框本身的行为已经是别处（如
 * 10-delete-thread）测过的通用组件。
 */
async function confirmRetranslate(page: Page) {
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-dialog-confirm').click();
}

// ── 翻译闸门 ───────────────────────────────────────────────────────────────────
//
// 「作业进行中」的那几条断言（右格空白、取消、focus 重探）都要求作业**确定地**停在半路。
// fixture 的响应是从内存里取的，一趟 4 页跑完只要几十毫秒——靠堆页数去换一个时间窗口就是拿墙上
// 时间当判据，用例会以「有时候没赶上」的形式红。
//
// 所以把 `pdf.translation.layout` 这一条 RPC 在**主进程**扣住：其余 RPC 原样透传，被扣的那几条等
// releaseGate 才真的落到 handler 上。作业于是**必然**停在「第一页的版面请求已发出、未落地」这个
// 状态上（translateDoc 先单跑第 1 页拿 docTitle，所以扣住的恰好是一条），停多久由用例说了算。
// 对渲染层而言这与「模型很慢」一模一样：请求真的在飞，只是不回来。
//
// **为什么不在渲染层包 window.kydog**：contextBridge 把它挂成
// `writable: false, configurable: false` 的数据属性（实测：直接赋值静默无效，defineProperty 抛
// 「Cannot redefine property」），包不上。主进程这一侧走 Playwright 的 `app.evaluate`，动的是
// `ipcMain._invokeHandlers` 这张表——Electron 的内部字段，所以下面对它的形状做了显式校验：
// 哪天它变了名字，用例会当场炸，而不是「什么都没扣住却全绿」。
//
// 一次启动只装一次（再装会在 handler 外面再包一层）；同一个进程里要再停一趟作业，用 rearmGate
// 换扣哪几条、把闸门关回去。计数从装上那一刻起累计，不清零。
//
// 这是测试侧的注入，产品代码一行都不用改——同 57 给 document.fonts.load 包一层人为延迟的做法。
type GateHost = { app: ElectronApplication };
type Counts = Record<string, number>;
type Gate = {
  held: Array<() => void>;
  open: boolean;
  /** 要扣住的方法名。其余 RPC 只计数、原样透传。 */
  hold: string[];
  /** 每个 `pdf.translation.*` 方法各被调过几次（进 handler 就记，扣住与否无关）。 */
  started: Counts;
  /** 各已经**跑完**几次（handler 返回之后才记，也就是回复已经发出）。 */
  done: Counts;
};
type GateGlobal = { __kydogTranslateGate?: Gate };

/**
 * `hold`：要扣住哪几条方法。默认扣 `pdf.translation.layout`（作业停在「第一页的版面请求已发出、
 * 未落地」）；传 `['pdf.translation.save']` 则让翻译整趟跑完、确定地停在 **finalize** 阶段
 * ——那是取消键该禁用的那一档，除此之外没有别的办法把作业钉在这个只有一次 IPC 往返宽的窗口里。
 */
async function installTranslateGate({ app }: GateHost, hold: string[] = ['pdf.translation.layout']) {
  const installed = await app.evaluate(({ ipcMain }, arg) => {
    const handlers = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, (...a: unknown[]) => unknown>;
    })._invokeHandlers;
    if (!(handlers instanceof Map)) return 'no-map';
    if ((globalThis as GateGlobal).__kydogTranslateGate) return 'already-installed';
    const orig = handlers.get(arg.channel);
    if (!orig) return 'no-handler';
    const gate: Gate = { held: [], open: false, hold: arg.hold, started: {}, done: {} };
    (globalThis as GateGlobal).__kydogTranslateGate = gate;
    handlers.set(arg.channel, async (...args: unknown[]) => {
      const method = (args[1] as { method?: string } | undefined)?.method ?? '';
      const counted = method.startsWith('pdf.translation.');
      if (counted) gate.started[method] = (gate.started[method] ?? 0) + 1;
      if (gate.hold.includes(method) && !gate.open) {
        await new Promise<void>((resolve) => { gate.held.push(resolve); });
      }
      try {
        return await orig(...args);
      } finally {
        // finally 而不是 then：抛错的那次也得计数，否则「流水线排空了没有」这条判据会永远等下去。
        if (counted) gate.done[method] = (gate.done[method] ?? 0) + 1;
      }
    });
    return 'ok';
  }, { channel: RPC_CHANNEL, hold });
  if (installed !== 'ok') throw new Error(`装不上翻译闸门：ipcMain 的 handler 表对不上（${installed}）`);
}

/** 同一次启动里再停一趟作业：换扣哪几条、把闸门关回去。上一趟扣住的必须已经放完。 */
async function rearmGate({ app }: GateHost, hold: string[]) {
  const ok = await app.evaluate((_electron, h) => {
    const g = (globalThis as GateGlobal).__kydogTranslateGate;
    if (!g || g.held.length > 0) return false;
    g.hold = h;
    g.open = false;
    return true;
  }, hold);
  if (!ok) throw new Error('重新扣闸门失败：闸门没装上，或上一趟还有请求扣着没放');
}

/** 闸门看到的调用计数。方法名 → 次数；没被调过的方法不在表里（读的时候 `?? 0`）。 */
function gateCounts({ app }: GateHost): Promise<{ started: Counts; done: Counts }> {
  return app.evaluate(() => {
    const g = (globalThis as GateGlobal).__kydogTranslateGate;
    return { started: { ...(g?.started ?? {}) }, done: { ...(g?.done ?? {}) } };
  });
}

/**
 * 「渲染层已经把此前所有 IPC 回复处理完了」这道栅栏。
 *
 * 用来把「取消之后不再发请求、不写盘」这类**不发生**的断言从墙上时间上摘下来：等一个拍脑袋的
 * 毫秒数，在 CI 负载下等不够就是**假绿**（真有 bug 也看不见），这是全套里最不该留的那种判据。
 *
 * 成立的理由：`window.kydog.invoke` 的回复与这条 fence 自己的回复走 ipcRenderer 的**同一条
 * 管道**、严格 FIFO。调用方先确认在途的那条请求在主进程侧已经跑完（`done` 计数 → 回复已经
 * 发出），再从渲染层自己发这一条；主进程收到它必然更晚，回复也必然更晚。所以这条 fence 一
 * 返回，前面那条回复的续体（真要写盘 / 真要派发下一页的话就在那里发出）必定已经跑完。
 *
 * 借 `pdf.translation.load` 当 fence 是因为它无副作用、参数最简单（读一次边车，没有就返回
 * `{ doc: null }`）。注意它自己也会被闸门记成一次 load。
 */
async function fenceRendererIpc(page: Page, pdfPath: string) {
  await page.evaluate((p) => window.kydog.invoke('pdf.translation.load', { pdfPath: p }), pdfPath);
}

/** 当前被扣住的翻译请求条数。-1 = 闸门没装上。 */
function heldCount({ app }: GateHost): Promise<number> {
  return app.evaluate(() => (globalThis as GateGlobal).__kydogTranslateGate?.held.length ?? -1);
}

/** 放行：此后的请求直接透传，已扣住的那几条立刻继续。 */
async function releaseGate({ app }: GateHost) {
  await app.evaluate(() => {
    const g = (globalThis as GateGlobal).__kydogTranslateGate;
    if (!g) return;
    g.open = true;
    for (const resume of g.held.splice(0)) resume();
  });
}

// ── 像素采样 ───────────────────────────────────────────────────────────────────

type RightPixels = {
  total: number;
  /** 右格这一块里逐像素等于主题纸色的像素数。空白分支下应当 === total。 */
  paper: number;
  /** 右格这一块里的暗像素数（原文墨迹）。空白分支下应当是 0。 */
  dark: number;
  /** 左格同一块里的暗像素数——「这里本来就有东西可盖」的前提，缺了它整条断言不成立。 */
  leftDark: number;
  themePaper: [number, number, number];
} | null;

/**
 * 取第 1 页左右两格在同一个矩形里的像素，并把当前主题的 `--color-paper` 解析成 sRGB
 * （在页内过一次 1×1 画布，同 RightPage 的 themePaperRgb —— 主题 token 是 oklch()，
 * computed style 不再折算成 rgb()）。
 *
 * 右格还没定好位图尺寸时返回 null，调用方先用它 poll 就绪，再对数值本身断言——这样失败时报的是
 * 真实像素数，不是一个含糊的超时。
 */
async function sampleRight(
  page: Page, paneSel: string, box: { x: number; y: number; w: number; h: number },
): Promise<RightPixels> {
  return page.evaluate(({ sel, box, pageW }) => {
    // 对照是左右两个滚动栏，两栏的页行**都**带 data-pdf-page / data-pdf-layer（靠外面那层
    // `[data-pdf-pane]` 区分，见 PdfFileTab 的 renderLayers）。左右两格因此不在同一行里，
    // 各自按栏找；不限栏的话 querySelector 命中的是文档序在前的左栏那一行，里面没有右格。
    const pane = (w: string) => `${sel} [data-pdf-pane="${w}"] [data-pdf-layer="stable"] [data-pdf-page="1"]`;
    const left = document.querySelector(`${pane('left')} canvas`) as HTMLCanvasElement | null;
    const right = document.querySelector(`${pane('right')} canvas[data-pdf-right]`) as HTMLCanvasElement | null;
    if (!left || !right || left.width === 0 || right.width !== left.width) return null;
    const S = right.width / pageW;                       // 位图像素 / pt
    const rect: [number, number, number, number] = [
      Math.round(box.x * S), Math.round(box.y * S), Math.round(box.w * S), Math.round(box.h * S),
    ];
    const rd = right.getContext('2d')!.getImageData(...rect).data;
    const ld = left.getContext('2d')!.getImageData(...rect).data;
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const pctx = probe.getContext('2d')!;
    pctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-paper').trim();
    pctx.fillRect(0, 0, 1, 1);
    const p = pctx.getImageData(0, 0, 1, 1).data;
    let total = 0; let paper = 0; let dark = 0; let leftDark = 0;
    for (let i = 0; i < rd.length; i += 4) {
      total++;
      if (rd[i] === p[0] && rd[i + 1] === p[1] && rd[i + 2] === p[2]) paper++;
      if (rd[i] < 128) dark++;
      if (ld[i] < 128) leftDark++;
    }
    return { total, paper, dark, leftDark, themePaper: [p[0], p[1], p[2]] as [number, number, number] };
  }, { sel: paneSel, box, pageW: PAGE_W });
}

/** 等右格定好位图尺寸并采一次样。 */
async function waitSample(page: Page, paneSel: string, box: typeof INK, label: string) {
  await expect.poll(
    () => sampleRight(page, paneSel, box),
    { timeout: 15000, message: `${label}：等右格定好位图尺寸` },
  ).not.toBeNull();
  return (await sampleRight(page, paneSel, box))!;
}

/** 等作业跑到被扣住的那条请求上 —— 作业确定地停在半路的那一刻。默认扣的是第一页的版面请求
 * （`pdf.translation.layout`，见 installTranslateGate）。 */
async function waitJobParked(host: GateHost, message = '等作业跑到第一页的版面请求上（抽取完成）') {
  await expect.poll(() => heldCount(host), { timeout: 30000, message }).toBeGreaterThan(0);
}

/** 边车读回来。落盘是原子的（atomicWrite），所以只要文件在，内容就是完整的一份。 */
async function readSidecar(file: string): Promise<TranslatedDoc> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as TranslatedDoc;
}

/** 等译文边车出现在磁盘上。 */
async function waitSidecar(file: string) {
  await expect.poll(
    () => fs.stat(file).then(() => true, () => false),
    { timeout: 20000, message: `等译文边车落盘：${file}` },
  ).toBe(true);
}

/**
 * 单栏 / 双栏的**版面**区别。
 *
 * 分栏改造（spec v8 §3.1）之前，两格在同一个 flex 行里，行宽是 `(dual ? w * 2 + PAGE_GAP : w)
 * × scale`，「仍是单栏」于是取「行宽 ÷ 左格宽」。改造之后行宽恒是**一页**宽，那个比值在双栏下
 * 也是 1 —— 老写法会在留在双栏时照样绿，是个测不出东西的断言。
 *
 * 现在的区别落在栏本身：单栏只有左栏一个滚动容器，它是 wrapper 里唯一的在流子元素（Notice /
 * 工具栏 / 浮条都是 absolute），宽度因此就是 wrapper 的宽；双栏则多出一条分隔线和右栏，左栏
 * 宽掉到 `(wrapper − DIVIDER_PX) × split` ≈ 一半。三个数一起取，任何一处留在双栏都会被抓到。
 */
async function paneLayout(page: Page, paneSel: string) {
  return page.evaluate((sel) => {
    const left = document.querySelector(`${sel} [data-pdf-pane="left"]`) as HTMLElement | null;
    if (!left) return null;
    // 左栏是 `<左栏相对定位父层><滚动容器 data-pdf-pane="left">`（OverlayScrollbar 的锚点，
    // Task 2）——那层父层与左栏恒等宽，量它当 wrapW 会让下面「仍是单栏」的三条断言恒真。
    // 两栏 + 分隔线共同的 flex 行是再上一层，同 57 的 paneBoxWidths。
    return {
      leftW: left.getBoundingClientRect().width,
      wrapW: left.parentElement!.parentElement!.getBoundingClientRect().width,
      rightPanes: document.querySelectorAll(`${sel} [data-pdf-pane="right"]`).length,
      dividers: document.querySelectorAll(`${sel} [data-testid="pdf-pane-divider"]`).length,
    };
  }, paneSel);
}

/**
 * 把读数滚到第 n 页：把第 n 页那一行（两栏页行始终在 DOM，见 renderLayers 头上的注释）在
 * 视口里居中，靠 `getBoundingClientRect` 现量、不重算 unitLayout 的常量。
 *
 * 原来按 `(scrollHeight / pages) * (n - 1) + clientHeight * 0.4` 起点 + 定比偏移的公式在本机
 * 量到会越过第 2 页直接落在第 3 页：4 页 fit-width 在这条用例的窗口宽度下 zoomPct 是 61%，
 * clientHeight（730px）比一整页缩放后的高度（842 × 0.61 ≈ 514px）还大——视口本身能同时露出一页
 * 多，`clientHeight * 0.4`（292px）这个偏移量本身就超过半页，会把居中点推进下一页的地界。
 * `mostVisiblePage`（pageReadout.ts）判的是哪页在视口里重叠面积最大，视口比页还高时这个偏移量
 * 越大越容易被推给邻页，公式因此对视口/页面的相对大小很敏感。把目标页整行居中不受这个比例影响：
 * 量的是这一页自己的矩形，与视口比页大还是小无关。
 */
async function scrollToPage(page: Page, pane: Locator, paneSel: string, n: number) {
  await page.evaluate(({ sel, n }) => {
    const el = document.querySelector(`${sel} [data-pdf-pane="left"]`) as HTMLElement;
    const row = document.querySelector(
      `${sel} [data-pdf-pane="left"] [data-pdf-layer="stable"] [data-pdf-page="${n}"]`,
    ) as HTMLElement;
    const elRect = el.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    el.scrollTop += (rowRect.top - elRect.top) + rowRect.height / 2 - el.clientHeight / 2;
  }, { sel: paneSel, n });
  await expect(pane.getByTestId('pdf-readout')).toContainText(`${n} / ${PAGES}`);
}

/** 按 id 比对两份边车里某几页的块——「pages 之外逐字不变」这条判据的落点。 */
function blocksOf(doc: TranslatedDoc, pages: number[]) {
  return doc.blocks.filter((b) => pages.includes(b.page));
}

// ═══ A 首次翻译：作业停在半路 ═══════════════════════════════════════════════════
//
// 段内顺序：一趟作业从第一条发起、停在第 1 页的版面上，前三条都看它（进双栏与右格空白 → 边车重探
// → 取消）；取消那条放行闸门、作业收尾之后，最后一条才换第二份 PDF。边车重探那条数的是**全局**的
// load 计数（闸门不分 PDF），所以必须在打开第二份 PDF 之前做完。

test.describe('59-pdf-translate · A 首次翻译，作业停在半路', () => {
  test.describe.configure({ mode: 'serial' });

  let launched: LaunchedApp;
  let pdfPath = '';
  let paneSel = '';
  let pane: Locator;
  /** 发起作业之前闸门记到的 load 次数——边车重探那条用它算「focus 真的发出了一趟」。 */
  let loadsBeforeStart = 0;

  test.beforeAll(async () => {
    launched = await launchKydog({ seed: seedFirstRun, translateFixture: TRANSLATE_FIXTURE });
    pdfPath = path.join(launched.kydogHome, 'proj', PLAIN_REL);
    paneSel = testIdSelector(`file-pane-${pdfPath}`);
  });
  test.afterAll(async () => { await teardown(launched); });

  // 「右半边」是分栏改造之前的说法（那时两格在同一个滚动容器的同一行里）。现在浮层的父层就是
  // **右栏**那个容器的兄弟（PdfFileTab 里右栏与 TranslationProgress 的共同 relative 父层），
  // 措辞跟着 DOM 走。
  test('59-pdf-translate: 点翻译键立刻进双栏，右格是空白像素、右栏里有进度浮层', async () => {
    const { page } = launched;
    pane = await openPdf(page, pdfPath);

    // 二期起「没有译文」从禁用变成可点：动作是跑翻译流水线，不是进对照。
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await installTranslateGate(launched);
    loadsBeforeStart = (await gateCounts(launched)).started[LOAD] ?? 0;
    // 发起方式同时给下一条（边车重探）造好起点：同一次 evaluate 里先发 focus、再点键。两件事落在
    // 同一个任务里，focus 发出的那趟 load 绝无可能在中间 resolve，「启动作业时正好有一趟在途」
    // 因此是确定的，不靠抢时间窗口。对这一条而言它就是「点翻译键」。
    await page.evaluate((sel) => {
      window.dispatchEvent(new Event('focus'));
      (document.querySelector(sel) as HTMLElement).click();
    }, testIdSelector('pdf-translate'));

    // 进对照与浮层是**点下去那一刻**发生的：startTranslation 在第一个 await 之前就 setDual +
    // setJob，不等抽取跑完。
    await expect(pane.getByTestId('pdf-translate-progress')).toBeVisible();
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();
    // 「在右栏里」取几何，不取「元素在不在」：浮层是右栏容器的兄弟、absolute 居中（放进滚动
    // 容器会跟着内容滚走），挂错父层的话它会居中在整个 wrapper 上，横向中心落到左栏里去。
    const overlayIn = await page.evaluate((sel) => {
      const o = document.querySelector(`${sel} [data-testid="pdf-translate-progress"]`);
      const r = document.querySelector(`${sel} [data-pdf-pane="right"]`);
      if (!o || !r) return null;
      const ob = o.getBoundingClientRect();
      const rb = r.getBoundingClientRect();
      return { cx: ob.left + ob.width / 2, rl: rb.left, rr: rb.right };
    }, paneSel);
    expect(overlayIn, '应当同时量得到浮层与右栏').not.toBeNull();
    expect(overlayIn!.cx, `进度浮层的横向中心应当落在右栏里 ${JSON.stringify(overlayIn)}`)
      .toBeGreaterThan(overlayIn!.rl);
    expect(overlayIn!.cx).toBeLessThan(overlayIn!.rr);

    await waitJobParked(launched);
    await expect(pane.getByTestId('pdf-translate'), '翻译进行中翻译键禁用').toBeDisabled();

    const s = await waitSample(page, paneSel, INK, '翻译进行中');
    // 只断言「浮层在」是不够的：右格照常合成时那条也会绿。判据取像素本身。
    expect(s.themePaper, '主题纸色不该正好是纯白——否则「空白」与「照常合成一张白页」区分不开')
      .not.toEqual([255, 255, 255]);
    expect(s.leftDark, '左格这一块里得真有原文墨迹，右格「空白」才谈得上是把东西藏住了')
      .toBeGreaterThan(0);
    expect(s.paper, `右格这一块应当逐像素都是主题纸色 ${JSON.stringify(s)}`).toBe(s.total);
    expect(s.dark, '右格不该留下任何原文墨迹').toBe(0);
  });

  test('59-pdf-translate: 翻译期间的边车重探不会把用户踢出对照', async () => {
    const { page } = launched;
    const progress = pane.getByTestId('pdf-translate-progress');

    // ① 作业**启动前就已经在途**的那一趟 load（上一条发起作业时一并发出的 focus）。挡住它的是
    //    startTranslation 里那句 translationSeq 自增——loadTranslation 开头那道 job 闸只管**之后**
    //    发起的重探，挡不住已经在途的这趟；它落地时盘上还没有边车，setLoaded(null) 会把 dual 收掉。
    //
    //    原来这里等的是 1 秒墙上时间（「一个 IPC 往返绰绰有余」）：等不够就假绿。改成两道确定的
    //    栅栏——主进程侧所有已发出的 load 都跑完（作业期间 job 闸不再发新的，所以这个差会收敛到 0），
    //    再走一次 fenceRendererIpc，保证它们的续体在渲染层也已经跑完。
    await expect.poll(async () => {
      const c = await gateCounts(launched);
      return (c.started[LOAD] ?? 0) - (c.done[LOAD] ?? 0);
    }, { timeout: 15000, message: '等启动作业前在途的那趟 load 在主进程侧跑完' }).toBe(0);
    const inFlight = (await gateCounts(launched)).started[LOAD] ?? 0;
    // ≥ 而不是 ===：打开 PDF 时那几趟自动加载（sizes 落地会重跑一次）与装闸门撞在一起的话会多记一趟；
    // 要证明的只是 focus 那一趟真的发出去了。
    expect(inFlight - loadsBeforeStart, 'focus 应当真的发出了一趟 load（与点键同一个任务，启动作业时它在途）')
      .toBeGreaterThanOrEqual(1);
    await fenceRendererIpc(page, pdfPath);
    await expect(progress).toBeVisible();
    expect(await pane.locator('[data-pdf-right="1"]').count(), '启动作业前在途的那趟加载不该收掉 dual')
      .toBeGreaterThan(0);

    // ② 翻译期间再触发一次 focus（真人切个窗口就会发生）：这次由 loadTranslation 开头的 job 闸
    //    挡住，压根不发 RPC——闸门的计数只多出 fence 自己那一次。上面 ① 就是同一条用例里的正向：
    //    没有作业时 focus 确实会发一趟 load。原来这里也是等 1 秒。
    const beforeFocus = (await gateCounts(launched)).started[LOAD] ?? 0;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await fenceRendererIpc(page, pdfPath);
    const afterFocus = (await gateCounts(launched)).started[LOAD] ?? 0;
    expect(afterFocus - beforeFocus, '翻译期间的 focus 不该发出 load（多出来的一次是 fence 自己）').toBe(1);
    await expect(progress).toBeVisible();
    expect(await pane.locator('[data-pdf-right="1"]').count(), '翻译期间的 focus 重探不该收掉 dual')
      .toBeGreaterThan(0);
  });

  test('59-pdf-translate: 取消退回单栏，磁盘上什么都没写', async () => {
    const { page } = launched;
    const sidecar = path.join(path.dirname(pdfPath), `.${PLAIN_REL}.zh.json`);
    const right = pane.locator('[data-pdf-right="1"]');
    const progress = pane.getByTestId('pdf-translate-progress');

    // 起点：前两条留下的那趟作业，停在第 1 页的版面请求上。下面「退回单栏」那两条否定断言的正向。
    await expect(progress).toBeVisible();
    await expect(right.first()).toBeVisible();

    await pane.getByTestId('pdf-translate-cancel').click();
    await expect(right, '取消要退回单栏').toHaveCount(0);
    await expect(progress).toHaveCount(0);

    // 取消这一刻，被扣住的仍是第 1 页的版面请求：第二步要等第一步的响应解析完才知道发哪几个
    // 可译组，这一步压根没有机会发出——这条断言只在**此刻**（还没放行）成立，落死在这里。
    const parked = await gateCounts(launched);
    expect(parked.started['pdf.translation.layout'], '取消那一刻只发出过第 1 页的版面请求').toBe(1);
    expect(parked.started['pdf.translation.translate'] ?? 0, '被扣住的是版面，第二步根本没发出过')
      .toBe(0);

    // 放行被扣住的那条请求：它落地时代际已经失配，组装与写盘都不该再发生。不放行的话这条用例
    // 只证明了「取消那一刻还没写盘」，证明不了「在途的请求跑完之后也不写」——而那正是 jobSeq
    // 要挡的东西。
    //
    // 「此后什么都不发生」这件事以前等的是 1.5 秒墙上时间：等不够就假绿（Task 15 要摘掉的
    // 就是这条）。改成两道确定的栅栏——① 主进程侧确认被扣住的那条请求真的跑完（回复已发出），
    // ② 再走一次 fenceRendererIpc，保证那条回复的续体在渲染层也已经跑完（见该函数的注释）。
    await releaseGate(launched);
    await expect.poll(
      async () => (await gateCounts(launched)).done['pdf.translation.layout'] ?? 0,
      { timeout: 15000, message: '等被扣住的那条版面请求真的跑完' },
    ).toBeGreaterThan(0);
    await fenceRendererIpc(page, pdfPath);

    const counts = await gateCounts(launched);
    // 不再往下派页——worker 循环的取消检查点挡的是**页 2-4**，钉住的是这一半。第 1 页自己放行之后
    // 发不发第二步是 runPage 两步之间那道检查点的事（页内，不是 worker 派发新页），由
    // translateDoc.test「版面已回、第二步还没发时取消」守，所以这里只认 layout 的计数：
    // `jobSeq.current += 1` 那行去掉之后，被放行的第一页落地时会照常把其余三页派出去——而它们
    // **先于**这条 fence 发出（同一条管道 FIFO），所以这里读到的必然是 4。
    expect(counts.started['pdf.translation.layout'], '取消之后不该再派新的页')
      .toBe(1);
    expect(counts.started['pdf.translation.save'] ?? 0, '取消之后不该发出任何写盘请求').toBe(0);
    const exists = await fs.stat(sidecar).then(() => true, () => false);
    expect(exists, `取消之后不该有译文边车：${sidecar}`).toBe(false);
  });

  test('59-pdf-translate: 覆盖确认框点取消——一条仍然成立的错误提示不该被顺手抹掉', async () => {
    // 复审点名的一条：`onToggleDual` 里那句 `setTranslateError(null)` 原先排在 `confirm()`
    // **之前**，于是「按翻译键 → 看到确认框 → 取消」会顺手清掉一条此刻仍然成立的提示，而这一刻
    // 什么都没发生——用户按下取消，界面上唯一的线索却没了。
    //
    // 触发条件要两样东西同时成立：翻译键处在 invalid / mismatch（动作会覆盖磁盘上已有的边车，
    // 因而先过 confirm），并且 Notice 上正挂着一条 translateError。scan.pdf 把两样都造出来（见
    // seedFirstRun）：坏边车给 invalid 态，没有文本层让第一次确认过的翻译在抽取阶段失败。
    //
    // 顺带收进来两条原本各自单独启动的说法：翻译失败要把 translateError 显示在 Notice 上并**退回
    // 单栏**（原来借「没配模型」那条触发，要一份单独的设置、多一次启动），退回的是真的单栏**几何**
    // （原「没有文本层」那条）。
    const { page } = launched;
    const scanPath = path.join(path.dirname(pdfPath), SCAN_REL);
    const scanZh = path.join(path.dirname(pdfPath), SCAN_ZH_REL);
    const scanSel = testIdSelector(`file-pane-${scanPath}`);
    const zhBefore = await fs.readFile(scanZh, 'utf8');
    const scan = await openPdf(page, scanPath);
    const key = scan.getByTestId('pdf-translate');
    const notice = scan.getByTestId('pdf-notice');
    const right = scan.locator('[data-pdf-right="1"]');
    const progress = scan.getByTestId('pdf-translate-progress');

    // 前提：坏边车真的让这份 PDF 处在 invalid 态（主键可点、Notice 报的是边车有误，不是翻译失败）。
    await expect(key).toBeEnabled();
    await expect(notice).toContainText('译文文件有误');
    const single = await paneLayout(page, scanSel);
    expect(single, '点之前就该量得到左栏').not.toBeNull();
    expect(single!.rightPanes, '点之前是单栏').toBe(0);
    expect(single!.leftW, '单栏时左栏就是 wrapper 那么宽').toBeCloseTo(single!.wrapW, 0);

    // 先真发起一次并让它失败，把那条提示挂上去（invalid 态覆盖已有边车 → 先过确认框）。
    // 闸门扣住 resolveModel：作业停在「已进对照、还没开始抽取」这一刻——下面「退回单栏」那几条
    // 否定断言的正向证明（同一条用例里）：它真的进过双栏，版面也真的变过。
    await rearmGate(launched, ['pdf.translation.resolveModel']);
    await key.click();
    await confirmRetranslate(page);
    await waitJobParked(launched, '等作业停在 resolveModel 上（已进对照、还没开始抽取）');
    await expect(progress).toBeVisible();
    await expect(right.first()).toBeVisible();
    await expect.poll(async () => {
      const l = await paneLayout(page, scanSel);
      return !!l && l.rightPanes > 0 && l.dividers > 0 && l.leftW < l.wrapW - 1;
    }, { timeout: 10000, message: '作业进行中应当是双栏版面（右栏 + 分隔线、左栏变窄）' }).toBe(true);

    // 放行：抽取阶段每页零行 → translateDoc 的 `work.length === 0` 抛错中止（spec §4：「这页没字」
    // 与「这页抽取失败」是两件事，前者整份为空就是扫描件）。进来之前不在对照中（wasDualRef 为
    // false），catch 分支因此把 dual 收掉。
    await releaseGate(launched);
    await expect(notice, 'Notice 应当报出抽取阶段那句原话').toContainText('翻译失败：这份 PDF 没有文本层');
    await expect(right, '翻译失败要退回单栏').toHaveCount(0);
    await expect(progress).toHaveCount(0);
    // 「仍是单栏」取版面几何，不取「那块 canvas 在不在」：留在双栏的话左栏只有 wrapper 的一半宽，
    // 还多出一条分隔线和一个右栏容器。三条都断，任何一处没退干净都会红。
    await expect.poll(
      async () => (await paneLayout(page, scanSel))?.leftW,
      { timeout: 10000, message: '等失败之后退回单栏' },
    ).toBeCloseTo(single!.wrapW, 0);
    const after = (await paneLayout(page, scanSel))!;
    expect(after.leftW, `左栏应当仍铺满 wrapper ${JSON.stringify(after)}`).toBeCloseTo(after.wrapW, 0);
    expect(after.rightPanes, '不该留下右栏').toBe(0);
    expect(after.dividers, '不该留下分隔线').toBe(0);
    // 顺带确认这条失败路径什么都没写盘：那份坏边车逐字节原样。
    expect(await fs.readFile(scanZh, 'utf8'), '抽取阶段就中止，不该碰盘上的边车').toBe(zhBefore);

    // 再按一次，这次在确认框上点取消：什么都没发生，提示就该原样还在。
    await key.click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

    await expect(notice, '取消覆盖之后那条提示仍然成立，不该被清掉')
      .toContainText('翻译失败：这份 PDF 没有文本层');
  });
});

// ═══ B 从对照态出发 ═════════════════════════════════════════════════════════════
//
// 段内顺序（fixture 按这个顺序拼，见 FROM_READY_FIXTURE）：
//   1. 确认框取消 → 再点确认，留下一趟停在第 1 页版面上的全部重译（正向证明）；
//   2. 取消这趟、放行——只落地第 1 页的版面，吃掉第 1 页头一条响应；
//   3. 重译第 2 页——必须在任何一趟全部重译跑完**之前**：越界块与 seed1 只活在种子边车里；
//   4. 跑到底的全部重译；
//   5. 删除译文——删了边车，只能放最后。
// 全程不离开对照：进对照前的读数记在第 1 条，删除译文那条要拿它比「缩放还原」。

test.describe('59-pdf-translate · B 从对照态出发', () => {
  test.describe.configure({ mode: 'serial' });

  let launched: LaunchedApp;
  let pdfPath = '';
  let zhPath = '';
  let paneSel = '';
  let pane: Locator;
  /** 进对照之前的读数（页码 · 缩放）。 */
  let readoutBefore = '';

  test.beforeAll(async () => {
    launched = await launchKydog({ seed: seedReady, translateFixture: FROM_READY_FIXTURE });
    pdfPath = path.join(launched.kydogHome, 'proj', READY_REL);
    zhPath = path.join(launched.kydogHome, 'proj', READY_ZH_REL);
    paneSel = testIdSelector(`file-pane-${pdfPath}`);
  });
  test.afterAll(async () => { await teardown(launched); });

  /** 种子边车里那条块，限 stable 层（见「被取消」那条里关于双缓冲 strict mode 的注释）。 */
  const seed1 = (page: Page) => page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="seed1"]`);

  test('59-pdf-translate: 「重新翻译」确认框点取消——边车不变，没有发起任何翻译请求', async () => {
    // 三个入口（invalid/mismatch 主键、active 态的 pdf-retranslate）共用 PdfFileTab 里同一处
    // confirm() 调用（见 onToggleDual / onRetranslate 的注释），机制一致，这里只测一个入口的取消
    // 分支就够——挑 active 态的 pdf-retranslate 键，因为它最常用、断言起来也最直接（旧块原样还在）。
    //
    // 断言要落在协议层事实上，不是「弹出过一次对话框」这类过程性动作：
    //   ① 磁盘上的边车字节逐字节不变（不是只看 mtime）；
    //   ② `pdf.translation.layout` / `pdf.translation.translate` / `pdf.translation.save` 一次都
    //      没被调用过——装闸门直接读 started 计数，不靠等一段墙上时间去猜「后面没有再发生什么」；
    //   ③ 界面原样留在对照中，旧译文块还在。
    // 末尾点一次「确认」当同一条用例里的正向证明：计数器与浮层在真发起时确实会动。
    const { page } = launched;
    pane = await openPdf(page, pdfPath);
    readoutBefore = (await pane.getByTestId('pdf-readout').textContent()) ?? '';
    const before = await fs.readFile(zhPath, 'utf8');
    const progress = pane.getByTestId('pdf-translate-progress');

    await enterDual(page, pane);
    await expect(seed1(page)).toBeVisible();

    await installTranslateGate(launched);
    await pane.getByTestId('pdf-retranslate').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

    // 确认框已经关掉、点取消这一路 confirm() 的 promise 直接 resolve(false)，压根没有一条 IPC
    // 请求发出过——不需要 fenceRendererIpc 那套栅栏（那是用来等一条**已经发出**的请求收尾）。
    const counts = await gateCounts(launched);
    expect(counts.started['pdf.translation.layout'] ?? 0, '取消之后不该发出任何版面请求').toBe(0);
    expect(counts.started['pdf.translation.translate'] ?? 0, '取消之后不该发出任何翻译请求').toBe(0);
    expect(counts.started['pdf.translation.save'] ?? 0, '取消之后不该发出任何写盘请求').toBe(0);
    expect(await fs.readFile(zhPath, 'utf8'), '取消之后边车必须逐字节保持不变').toBe(before);

    await expect(progress).toHaveCount(0);
    await expect(pane.getByTestId('pdf-translate')).toHaveAttribute('aria-label', '退出对照 · L');
    await expect(pane.getByTestId('pdf-retranslate'), '仍是 active 态，「重新翻译」键还在').toBeVisible();
    await expect(seed1(page), '旧译文块原样还在').toBeVisible();

    // 正向：同一个键、同一个确认框，这次点「确认」——版面请求真的发出、浮层真的出来。这趟作业停在
    // 第 1 页的版面上，留给下一条去取消。
    await pane.getByTestId('pdf-retranslate').click();
    await confirmRetranslate(page);
    await waitJobParked(launched);
    expect((await gateCounts(launched)).started['pdf.translation.layout'], '点确认就发出第 1 页的版面请求')
      .toBe(1);
    await expect(progress).toBeVisible();
  });

  test('59-pdf-translate: 对照中发起的重新翻译被取消——不会把用户踢出对照（wasDual 修复）', async () => {
    // 这才是真正钉住 wasDual 修复的用例：从 active 态（dual === true）发起重译，取消。修复前
    // cancelTranslation 无条件 setDual(false)，会把用户踢出这个本来完好的对照视图——store 里
    // 那份旧 doc 还在、右格本可以照常合成，退回单栏是纯粹的体验退化，不是任何数据一致性要求。
    const { page } = launched;
    const progress = pane.getByTestId('pdf-translate-progress');

    // 起点：上一条从对照中发起、停在第 1 页版面上的那趟作业。也是下面浮层消失那条的正向。
    await expect(progress).toBeVisible();

    await pane.getByTestId('pdf-translate-cancel').click();
    await expect(progress).toHaveCount(0);
    await expect(pane.locator('[data-pdf-right="1"]').first(), '取消对照中的重译不该把用户踢出对照')
      .toBeVisible();
    await expect(pane.getByTestId('pdf-translate')).toHaveAttribute('aria-label', '退出对照 · L');
    await expect(pane.getByTestId('pdf-retranslate'), '仍是 active 态，「重新翻译」键还在')
      .toBeVisible();
    // Minor #5（Task 14 审查发现）：`[data-pdf-right="1"]` 只是右格那块 canvas 本身，不管它画的
    // 是内容还是一整格纸色都在——只断言它可见证明不了「对照视图还能用」，「留在 dual 但右格永久
    // 空白」这种更糟的状态照样能让上面那几行绿。这里补上 store 里那份旧 doc（cancel 不动它）
    // 应当重新渲染出来的具体那个块：job 收掉之后 `!translating` 重新为真，TranslationBlocks
    // 才会渲染（见 RightPage 里的注释），能看到 seed1 就说明取消之后合成的确实是可用的旧译文，
    // 不是空壳。
    // 定位限死在 **stable 层**上：缩放走双缓冲，顶替完成之前 layers 有两份，同一个块在 DOM 里
    // 就有两个（进对照那一下的 fit-width 提交在机器忙时能拖到这里还没顶替完）——不限层的话
    // Playwright 会以 strict mode violation 间歇性地红在这一行，而那与本条要钉的东西无关。
    // 取 stable 层不是放宽：它就是用户此刻真正看着的那一层（incoming 层压在它下面，zIndex 0）。
    await expect(seed1(page), '取消之后旧译文块应当重新出现——右格是真的可用，不是空壳').toBeVisible();

    // 放行被扣住的那条请求：它落地时代际已经失配，不该再把 job / dual 写回去。
    //
    // 原来这里等的是 1 秒墙上时间。改成确定的栅栏（同 A 段取消那条）：主进程侧等被扣住的那条版面
    // 请求真的跑完（回复已发出），再走一次 fenceRendererIpc 让它的续体在渲染层跑完——那条回复是
    // 这趟作业最后一次落地：第 1 页在两步之间的检查点上早退，worker 也不再派页。
    expect(await heldCount(launched), '上一条留下的那条版面请求此刻还扣着').toBe(1);
    const c0 = await gateCounts(launched);
    await releaseGate(launched);
    await expect.poll(
      async () => (await gateCounts(launched)).done['pdf.translation.layout'] ?? 0,
      { timeout: 15000, message: '等被扣住的那条版面请求真的跑完' },
    ).toBe(c0.started['pdf.translation.layout'] ?? 0);
    await fenceRendererIpc(page, pdfPath);
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();
    await expect(progress, '作废的那趟作业不该把进度写回来').toHaveCount(0);
    await expect(seed1(page)).toBeVisible();
  });

  test('59-pdf-translate: 部分跑的 base 是盘上的原文——越界块不会被顺手从磁盘上抹掉（final review I-1）', async () => {
    // 越界块（DROPPED_BLOCK_ID，见 seedReady 里那条种子边车）在内存里从来不存在：loadTranslation
    // 用 filterByGeometry 把它滤掉才存进 store，Notice 显示「已跳过」、右格也画不出它。如果
    // startTranslation 拿 store 里那份已过滤的 doc 当「重译本页」的 base，pages 之外的块会在
    // 「原样带过来」那步直接漏掉这一条——合并结果整份落盘，等于把它从磁盘上永久抹掉（违反
    // spec §8 不变量 #7）。这里重译与它无关的第 2 页，只测「pages 之外的块」这条合并路径，钉住
    // base 必须来自重新探盘（pdf.translation.load），不是 store 里那份几何过滤后的内存副本。
    const { page } = launched;

    const before = await readSidecar(zhPath);
    const droppedBefore = before.blocks.find((b) => b.id === DROPPED_BLOCK_ID);
    expect(droppedBefore, '种子边车里那条越界块得先在盘上').toBeDefined();
    // 它在内存里已经被几何过滤丢了：Notice 显示「已跳过」，右格也没有它的踪影——这是过滤
    // 本身该有的样子，不是本条要钉的 bug；本条钉的是它在**磁盘**上活不活得下来。
    await expect(pane.getByTestId('pdf-notice')).toContainText('1 条译文块超出页面范围，已跳过');
    await expect(seed1(page), '同一份边车里的另一条块是渲染出来的（下面那条否定断言的正向）').toBeVisible();
    await expect(page.locator(`${paneSel} [data-translation-block="${DROPPED_BLOCK_ID}"]`)).toHaveCount(0);

    await scrollToPage(page, pane, paneSel, 2);
    await pane.getByTestId('pdf-retranslate-page').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('重译第 2 页');
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });
    await expect.poll(async () => (await readSidecar(zhPath)).blocks.find((b) => b.page === 2)?.target, { timeout: 15000 })
      .toBe('第二页的译文');

    // 关键断言：越界块必须仍在磁盘上，逐字相等——不是「还有条 id 一样的块」，是同一条块的每个
    // 字段都没被重新生成或截断过。
    const after = await readSidecar(zhPath);
    const droppedAfter = after.blocks.find((b) => b.id === DROPPED_BLOCK_ID);
    expect(droppedAfter, '越界块必须仍在磁盘上，一个字节都不能丢').toEqual(droppedBefore);
    // 收尾：等这一趟跑完之后的重新加载落进界面，下一条从一个静止的对照态出发。
    await expect(page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="p2-b01"]`))
      .toHaveText('第二页的译文');
  });

  test('59-pdf-translate: 已在对照中点「重新翻译」键——右格回到空白，跑完出现新块', async () => {
    // 从 active 态（dual 已经是 true）走真正的 pdf-retranslate 按钮发起：进入 startTranslation 时
    // wasDual 为 true，这是 wasDual 这条修复（Task 14）要保的路径。
    const { page } = launched;
    const blocks = page.locator(`${paneSel} [data-translation-block]`);

    // 取样在第 1 页：上一条滚到了第 2 页，先滚回来。
    await scrollToPage(page, pane, paneSel, 1);
    await expect(blocks.first(), '进对照后旧译文块可见').toBeVisible();
    await expect(seed1(page), '上一版的块此刻在（下面「不该还留在那儿」的正向）').toBeVisible();
    await expect(pane.getByTestId('pdf-translate')).toHaveAttribute('aria-label', '退出对照 · L');
    const retranslateBtn = pane.getByTestId('pdf-retranslate');
    await expect(retranslateBtn, '「重新翻译」键只在 active 态渲染').toBeVisible();
    await expect(retranslateBtn).toHaveAttribute('aria-label', '全部重译');

    // 先证明「有东西可消失」：右格照常合成（INK 那一块里原文墨迹还在）。
    const before = await waitSample(page, paneSel, INK, '重译之前');
    expect(before.leftDark, '左格这一块里得有原文墨迹').toBeGreaterThan(0);
    expect(before.dark, '重译之前右格是照常合成的：这一块里应当有原文墨迹').toBeGreaterThan(0);

    await rearmGate(launched, ['pdf.translation.layout']);
    await retranslateBtn.click();
    await confirmRetranslate(page);
    await waitJobParked(launched);

    const during = await waitSample(page, paneSel, INK, '按「重新翻译」键之后进行中');
    expect(during.paper, `重译期间右格应当逐像素都是主题纸色 ${JSON.stringify(during)}`).toBe(during.total);
    // 译文层若不整层关掉，这里会是「空白底图 + 上一版译文浮在上面」——store 里那份 doc 还在，
    // 块照样有得渲染，所以这条不是恒真的。
    await expect(blocks, '重译期间旧译文块必须一并消失').toHaveCount(0);
    // 仍在对照中，没有被踢出单栏——这条断言只有在从 dual === true 发起、且这一趟没出错时才成立，
    // 单独放这里是因为它此刻还测不出 wasDual 的修复（成功路径压根不碰 setDual），真正测到修复的
    // 是上面「被取消」那条用例。
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();

    // 放行 → 新边车落盘 → 走现有的 loadTranslation 重新加载 → 右格恢复合成、**新**块出现。
    //
    // 判据必须落在「是不是新那一版」上，不能只问「有没有块」：清掉 job 那一刻译文层就会重新
    // 渲染，而 store 里此刻还是上一版的 doc——「有块」在没重新加载的情况下也成立（实测：把
    // 「先清 job、再 loadTranslation」调换顺序，只问有没有块的写法照样全绿）。所以这里认块的
    // **id**：新的一版由 buildBlocks 按页与最小行号编号（p1-b01），旧的那条是 fixture 里写死
    // 的 seed1，两者不可能混淆。这条因此真的钉住了那个顺序：反过来的话那趟加载会被 job 闸自己
    // 挡掉，边车虽然落了盘，界面上却永远停在上一版。
    await releaseGate(launched);
    const fresh = page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="p1-b01"]`);
    await expect(fresh, '跑完之后应当渲染的是新这一版的译文块').toBeVisible({ timeout: 15000 });
    // 这条**不**限 stable 层：toHaveCount(0) 不受 strict mode 影响（限层是为了双缓冲两层并存时
    // 同一个块两份会 strict mode 违规，那只发生在单命中的断言上），限了反而更弱——残留在
    // incoming 层上的旧块会被放过。否定断言要泛选。
    await expect(
      page.locator(`${paneSel} [data-translation-block="seed1"]`),
      '上一版的块不该还留在那儿',
    ).toHaveCount(0);
    const after = await waitSample(page, paneSel, INK, '重译之后');
    expect(after.paper, `跑完之后右格不该还是一片主题纸色 ${JSON.stringify(after)}`).toBeLessThan(after.total);
  });

  test('59-pdf-translate: 「删除译文」删掉边车、退回单栏、缩放还原、主键回到「翻译」；取消则什么都不动', async () => {
    const { page } = launched;
    // 读数里带着页码：进对照前记下的是第 1 页，比之前先回到第 1 页。
    await scrollToPage(page, pane, paneSel, 1);
    const del = pane.getByTestId('pdf-translate-delete');
    await expect(del).toBeVisible();
    // 下面几条「没了」的正向：此刻右栏、分隔线、「重新翻译」键都在。
    await expect(pane.getByTestId('pdf-retranslate')).toBeVisible();
    const dual = (await paneLayout(page, paneSel))!;
    expect(dual.rightPanes, `此刻是双栏 ${JSON.stringify(dual)}`).toBeGreaterThan(0);
    expect(dual.dividers).toBeGreaterThan(0);

    // 取消：文件仍在、仍在对照
    await del.click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('删除译文');
    await page.getByTestId('confirm-dialog-cancel').click();
    expect(await fs.stat(zhPath).then(() => true, () => false)).toBe(true);
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();

    // 确认：文件没了 → 单栏几何 → 读数还原 → 主键回到「翻译 · L」
    await del.click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect.poll(() => fs.stat(zhPath).then(() => true, () => false), { timeout: 10000 }).toBe(false);
    await expect.poll(async () => (await paneLayout(page, paneSel))?.rightPanes, { timeout: 10000 }).toBe(0);
    const layout = (await paneLayout(page, paneSel))!;
    expect(layout.dividers).toBe(0);
    expect(layout.leftW).toBeCloseTo(layout.wrapW, 0);
    await expect(pane.getByTestId('pdf-readout')).toHaveText(readoutBefore);
    await expect(pane.getByTestId('pdf-translate')).toHaveAttribute('aria-label', '翻译 · L');
    await expect(pane.getByTestId('pdf-retranslate')).toHaveCount(0);
  });
});

// ═══ D 跑完之后 ═══════════════════════════════════════════════════════════════
//
// 段内顺序：第一条发起唯一一趟完整翻译（第 2 页失败）、停在 finalize 再放行跑完；中间三条只读
// 结果（像素、Notice、边车、focus 重探），不发起作业；最后一条「重试失败页」改写第 2 页，放最后。
// 闸门在第一条装上、此后一直透传，计数从那一趟之前开始累计。

test.describe('59-pdf-translate · D 跑完之后', () => {
  test.describe.configure({ mode: 'serial' });

  let launched: LaunchedApp;
  let pdfPath = '';
  let sidecar = '';
  let paneSel = '';
  let pane: Locator;

  test.beforeAll(async () => {
    launched = await launchKydog({ seed: seedPlain, translateFixture: FAIL_THEN_RETRY_FIXTURE });
    pdfPath = path.join(launched.kydogHome, 'proj', PLAIN_REL);
    sidecar = path.join(launched.kydogHome, 'proj', `.${PLAIN_REL}.zh.json`);
    paneSel = testIdSelector(`file-pane-${pdfPath}`);
  });
  test.afterAll(async () => { await teardown(launched); });

  test('59-pdf-translate: finalize 阶段（正在写盘）取消键禁用，且那一档的三个数字都是真值', async () => {
    // spec §9.3 的提交点：jobSeq 挡得住「写渲染层的 store」，挡不住一次**已经发出的 save**。
    // 所以取消入口在进入 finalize 的那一刻关闭——否则会出现「取消了但边车落了盘」的中间态。
    //
    // finalize 只有一次 IPC 往返那么宽，靠时机去抓抓不住。把闸门改成扣 `pdf.translation.save`：
    // 翻译整趟照常跑完，作业**确定地**停在「已经 setJob(finalize)、save 请求已发出未落地」这一刻。
    //
    // 这个「确定地停在 finalize」的落点也是全仓唯一能看住 M-1 的地方，所以顺带把那一档的读数一起
    // 钉在这里：曾经硬写过一版 `{ done: 0, total: 1, failed: 0 }`，后果是保存那一刻进度条从 100%
    // 打回 0%、「N 页失败」凭空消失，而当时没有任何断言会因此变红。fixture 因此选带失败页的那份
    // （第 2 页两次响应都不是 id 头）——三个数字这才与那组硬写值**逐个**不同，换成全成功的 fixture
    // 只有 done/total 有区分力，failed 那位又回到零覆盖。
    const { page } = launched;
    pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await installTranslateGate(launched, ['pdf.translation.save']);
    await pane.getByTestId('pdf-translate').click();

    await waitJobParked(launched, '等作业跑到写盘请求上（进入 finalize）');

    // 浮层还在，而且报的是 finalize 那一档的文案——不然下面那条 disabled 可能是别的原因。
    const progress = pane.getByTestId('pdf-translate-progress');
    await expect(progress).toBeVisible();
    await expect(progress, 'finalize 那一档的三个数字都得是这一趟的真值：4 页全翻完、其中 1 页失败')
      .toContainText('正在保存 · 4 / 4 · 1 页失败');
    await expect(pane.getByTestId('pdf-translate-cancel'), 'finalize 之后不再给取消').toBeDisabled();

    // 放行：这一趟照常写盘、重新加载，画面进对照。钉住「禁用的是取消，不是把作业卡死了」。
    await releaseGate(launched);
    await waitSidecar(sidecar);
    await expect(progress).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="p1-b01"]`)).toBeVisible({ timeout: 20000 });
  });

  // 渲染类断言一律取像素或磁盘，不取「元素在不在」：`[data-pdf-right="1"]` 那块 canvas 不管画的是
  // 内容还是一整格纸色都在，而译文块 div 只要 store 里有 doc 就渲染得出来，两者都证明不了画对了。
  // 边车本身解析得对不对（块 id、target）是 translateDoc / zhSidecar 的单测的事，这里只借它的几何。
  test('59-pdf-translate: 跑完之后边车落盘可解析，右格那一块的原文墨迹被译文块盖掉', async () => {
    const { page } = launched;
    const b1 = (await readSidecar(sidecar)).blocks.find((b) => b.id === 'p1-b01');
    expect(b1, '第 1 页应当有一个块，借它的几何当取样矩形').toBeDefined();

    // 译文块渲染出来了，文字就是 fixture 给第 1 页的那句。
    await expect(page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="p1-b01"]`)).toHaveText('第一页的译文');

    // 像素：右格这一块里的原文墨迹没了（RightPage 按页背景色把块矩形填平了），左格同一块里
    // 还在。取样矩形直接用边车里那个块**自己的几何**内缩 1 pt，不写死坐标——写死的话 fixture
    // PDF 的排版一改就会悄悄采到块外面去，而块外面本来就是白纸，`dark === 0` 恒成立，这条
    // 断言会退化成永远绿。内缩 1 pt 是为了避开 fillRect 的取整边界（实际覆盖区还要再外扩一个
    // BLOCK_PAD，所以内缩之后必然仍在覆盖区里）。
    const inner = { x: b1!.x + 1, y: b1!.y + 1, w: b1!.width - 2, h: b1!.height - 2 };
    const s = await waitSample(page, paneSel, inner, '跑完之后');
    expect(s.leftDark, '左格这一块里得真有原文墨迹，右格「盖掉了」才谈得上').toBeGreaterThan(0);
    expect(s.dark, `右格这一块不该还留着原文墨迹 ${JSON.stringify(s)}`).toBe(0);
  });

  test('59-pdf-translate: 跑完之后仍能看到「N 页翻译失败」——失败页号随边车落盘', async () => {
    // Task 14 审查发现：Notice 原来判的是 `t?.job && t.job.failed > 0`，而作业完成后 job 整个变
    // null——「这趟有几页失败」在跑完那一刻，也就是用户最需要看到它的时刻，必然读不到。最终修法是
    // 让 translateDoc 把失败页号写进 doc.failedPages 一起落盘，Notice 从 store 里那份 doc 现读。
    // 第一条那趟：第 2 页版面正常、翻译两次响应的头行都不是 `g<n>`（parseTranslations 两次都抛
    // 「组头不是 id」，runPage 重试一次后把页号 2 记下），其余三页正常——作业整体仍然成功跑完、
    // 写盘、走 loadTranslation 重新加载。
    const { page } = launched;
    await expect(pane.getByTestId('pdf-notice'), '作业跑完之后这条消息仍应可见')
      .toContainText('1 页翻译失败（第 2 页），右栏保留原文');
    // 顺带钉住信号的落点：Notice 上那句话的来源是**边车里的页号**，不是内存里某个作业留下的
    // 数字。页号而不是计数——计数是逐页信号的有损汇总，长度随时能推出来，反过来不行。
    const saved = await readSidecar(sidecar);
    expect(saved.failedPages, '失败页号应当写进边车').toEqual([2]);
    // 第 2 页版面正常、卡在第二步：两次响应的头行都不是 `g<n>`，parseTranslations 判「组头不是
    // id」。前缀 `翻译：` 说明是第二步失的（`版面：` 是第一步的前缀，两者不该混）。
    expect(saved.failureReasons?.['2'], '失败原因应当随页号一起落盘').toMatch(/^翻译：组头不是 id/);
    // 悬停 Notice → Tooltip 里每页一行原因
    await pane.getByTestId('pdf-notice').hover();
    const tip = page.getByTestId('pdf-notice-reasons');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('第 2 页：');
    await expect(tip).toContainText('组头不是 id');
    // fixture 里第 2 页第一条响应文本被撑到 300+ 字符（模型输出原样被 JSON.stringify 回显进
    // 原因串），真实场景下这类长原因会把没有 max-width / white-space: normal 的面板宽出窗口。
    //
    // 只断 getBoundingClientRect() 的 left/right 不够：容器有 overflow: visible（默认值），
    // `max-width` 只钳容器**自己这个盒子**的宽度，`white-space: nowrap` 时那一整行文字仍会
    // 照常画到盒子外面——盒子的 rect 依旧乖乖落在 max-width 之内，但真正画出来的字远远宽出去，
    // 实测过：去掉 `white-space: normal` 之后 clientWidth 还是 520，scrollWidth 却蹿到 3323，
    // 只断 rect 的话这条用例会假绿。scrollWidth 才是「有没有真的换行」的信号：换行成立时内容
    // 撑不出容器本身的宽度，scrollWidth ≈ clientWidth；不换行则一整行文字的固有宽度全部计入
    // scrollWidth，远超 clientWidth。
    const rect = await tip.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left, right: r.right, innerWidth: window.innerWidth,
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      };
    });
    expect(rect.scrollWidth, `原因文本没有真的换行，撑出了容器本身 ${JSON.stringify(rect)}`)
      .toBeLessThanOrEqual(rect.clientWidth + 1);   // +1 容小数像素舍入
    expect(rect.left, `原因面板不该宽出视口左边 ${JSON.stringify(rect)}`).toBeGreaterThanOrEqual(0);
    expect(rect.right, `原因面板不该宽出视口右边 ${JSON.stringify(rect)}`).toBeLessThanOrEqual(rect.innerWidth);
    // 失败页不该把用户踢出双栏——它只是那一页保留原文，不是整趟作业失败。
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();
  });

  test('59-pdf-translate: 切一次窗口（focus 重探）之后「N 页翻译失败」仍在——信号在边车里，不在内存里', async () => {
    // **这条是「失败页信号收口到边车」那轮修复的回归点。**
    //
    // 收口之前，「哪几页失败」只从 onProgress 这条侧信道漏出一个瞬时数字、存在渲染层的 store 里，
    // 而边车里一个字节都没记。于是「这个数字该活多久」变成一个下游问题，两种写法都是错的：
    // 保留 → agent 只重写边车（PDF 没变、checkVersion 仍判 ok）时会挂着上一份的陈旧计数；
    // 归零 → 这条提示撑不过一次切窗口，因为 loadTranslation 挂在 window 的 focus 上，真人 alt-tab
    // 回来就会重探一次边车。这条用例守的是后者：跑完一趟带失败页的翻译，派发一次 focus，提示还得在。
    //
    // 判据全在协议层，没有等墙上时间：
    //   ① 边车里确实有 failedPages（读盘，逐字节的事实）；
    //   ② focus 真的触发了一次 pdf.translation.load（闸门的 started 计数，不是「大概会发生」）；
    //   ③ 那次重探**已经落进渲染层的 store**——靠 fenceRendererIpc 这道栅栏：loadTranslation 在
    //      focus 回调里同步发出 invoke，排在 fence 自己那条之前，同一条 FIFO 管道，所以 fence 一
    //      返回，重探的续体（setLoaded）必定已经跑完。此后 Notice 上还有没有那句话，是确定的。
    const { page } = launched;
    await expect(pane.getByTestId('pdf-notice'), '跑完之后应显示 1 页失败')
      .toContainText('1 页翻译失败（第 2 页），右栏保留原文');
    expect((await readSidecar(sidecar)).failedPages, '失败页号应当写进边车').toEqual([2]);

    // 闸门第一条就装上了、此后一条都不扣，这里只用它数 pdf.translation.* 的调用次数。
    const before = (await gateCounts(launched)).started[LOAD] ?? 0;

    // 切一次窗口。真人 alt-tab 回来就是这个事件，spec §3.4 靠它重探边车（边车是点号开头的
    // 文件，fileWatcher 跳过它，没有 file.changed 可用）。
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await fenceRendererIpc(page, pdfPath);

    const after = (await gateCounts(launched)).started[LOAD] ?? 0;
    expect(after - before, 'focus 应当真的触发一次重探（另一次是 fence 自己）').toBe(2);

    // 关键断言：重探回来之后提示仍在。信号在盘上，不是内存里某个数字的余额。
    await expect(pane.getByTestId('pdf-notice'), '切一次窗口不该把「N 页翻译失败」抹掉')
      .toContainText('1 页翻译失败（第 2 页），右栏保留原文');
    // 顺带确认重探没有把用户踢出对照（setLoaded 的 dual 维持，与本条正交但同一条路径）。
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();
  });

  test('59-pdf-translate: 「重试失败页」只重翻失败页，其它页的块逐字不变，键随失败页一起消失', async () => {
    const { page } = launched;
    const before = await readSidecar(sidecar);
    expect(before.failedPages).toEqual([2]);
    // 首趟（两轮）：版面 4 页各一次 + 第 2 页在收尾轮整页重来一次 = 5；翻译第 2 页主轮两次
    // + 收尾轮一次（收尾轮每步只发一次）+ 其余三页各一次 = 6。闸门装在首趟发起之前，中间几条
    // 只发过 load，所以这两个数就是首趟的。
    const firstRun = await gateCounts(launched);
    expect(firstRun.done['pdf.translation.layout']).toBe(5);
    expect(firstRun.done['pdf.translation.translate']).toBe(6);

    const retry = pane.getByTestId('pdf-retry-failed');
    await expect(retry).toBeVisible();
    await expect(pane.getByTestId('pdf-retry-failed-count')).toHaveText('1');
    // 下面「不弹确认」的正向：旁边那颗会覆盖译文的「重译本页」是要弹确认的（点取消，什么都不动）。
    await pane.getByTestId('pdf-retranslate-page').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await retry.click();
    // 不弹确认：什么都不覆盖
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });
    await expect.poll(async () => (await readSidecar(sidecar)).failedPages, { timeout: 15000 }).toBeUndefined();
    const after = await readSidecar(sidecar);
    expect(after.failureReasons).toBeUndefined();
    expect(after.blocks.find((b) => b.page === 2)?.target).toBe('第二页的译文（重试之后）');
    expect(blocksOf(after, [1, 3, 4]), 'pages 之外的块逐字不变').toEqual(blocksOf(before, [1, 3, 4]));
    // 重试失败页只重发第 2 页，而且第一轮就成了：版面 + 翻译各多一次（它最多跑三轮，
    // RETRY_FAILED_PAGE_ATTEMPTS——成了就不再跑第二轮，所以只多这一次）。
    const secondRun = await gateCounts(launched);
    expect(secondRun.done['pdf.translation.layout']).toBe(6);
    expect(secondRun.done['pdf.translation.translate']).toBe(7);
    await expect(retry, '没有失败页了，键消失').toHaveCount(0);
    await expect(pane.locator('[data-pdf-right="1"]').first(), '仍在对照中').toBeVisible();
  });
});
