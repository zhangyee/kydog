import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector } from './helpers';
import { buildNoTextPdf, buildPagedPdf } from './fixtures/textPdf';
import { RPC_CHANNEL } from '../src/shared/protocol';
import type { TranslatedDoc } from '../src/shared/zhSidecar';

/**
 * 翻译流水线的端到端用例（spec `2026-09-05-pdf-translation-pipeline-design.md`）。
 *
 * 逐页响应走 `KYDOG_TRANSLATE_FIXTURE`（launchKydog 的 translateFixture 选项）：主进程仍走
 * `pdfTranslatePage.ts` 那条同样的 semaphore 与并发路径，只是不碰上游模型。fixture 的形状是
 * `{ "<页码>": [{ text, stopReason }] }`，`text` 是 §6 那份 `%%` 协议的原样输出——解析与三层
 * 校验在渲染层，e2e 与生产因此跑的是同一份纯函数。
 *
 * 本文件先由 Task 13 接线出五条（计划里的第 2 / 4 / 9 / 10 / 11 条），Task 14 又补了四条零回归；
 * Task 15 收尾，补上剩下的第 3 / 5 / 6 / 7 / 12 条与「finalize 阶段取消键禁用」这条缺口
 * （第 1 条「无边车 → 键可点 + tooltip 含『翻译』」不在这里重复：可点由下面第一条用例断言，
 * tooltip 文案由 `57-pdf-dual-pane` 的「翻译键六态」用例逐字断言过 `aria-label = 翻译 · L`；
 * 第 8 条 mismatch 走的是下面「重新翻译」那条用例的入口）。
 * Task 14 把第 9 条（对照中「重新翻译」键）从 mismatch 入口代替升级成走真正的 `pdf-retranslate`
 * 按钮（原来那条 mismatch 入口的用例留着不删——机制仍然一致，多测一条入口无害），并补了一条不
 * 在原始 13 条清单内的回归用例：从 active 态（`dual === true`）发起的重译一旦被取消，不该把
 * 用户踢出这个本来完好的对照视图（PdfFileTab 的 `wasDualRef` 修复，Task 14 审查发现的真 bug）。
 *
 * Task 14 审查（Needs fixes）之后又补了两条零回归覆盖：
 *   - 没配模型时点翻译，`translateError` 要能在 Notice 上显示出来（本任务的头号要求，之前完全
 *     没有 e2e 钉住——上一版实现者验证过一次就删了 scratch 用例，`translateError` 这行 props
 *     去掉照样全绿）。
 *   - 一趟作业**跑完之后**，若有页失败，「N 页翻译失败」这条消息仍要可见——`job.failed` 在
 *     job 完成后整个变 null，用它判的话这条消息在用户最需要看到它的那一刻必然读不到。
 *
 * 「哪几页失败」这个信号最终**收口进了边车**（`TranslatedDoc.failedPages`，跑翻译那一趟写）。
 * 在那之前它只从 `onProgress` 侧信道漏出一个瞬时数字、由渲染层的 store 存着，于是「这个数字
 * 该活多久」被迫成了一个下游问题：保留会在 agent 重写边车后显示陈旧计数，归零则让它撑不过一次
 * 切窗口（focus 重探）。落进边车之后它天然描述当前这份 doc，两难自己消失。守这件事的是下面
 * 三条用例：跑完仍显示、重译取消仍显示（doc 没变）、**切一次窗口之后仍显示**（重探从盘上读回
 * 真值——那条是这套修法的回归点）。
 */

const TRANSLATE_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4.json');
// 页 2 的响应故意不含 "|"：parseGroups 两次都抛 GroupError（runPage 重试一次），页号 2 被记进
// failedPages，其余三页正常成功——用来验证「1 页失败」这个信号真的落进了边车、并且活得够久。
const ONE_FAIL_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4-one-fails.json');
// 页 1 的第一条响应是空译文（`1 | text` 后面直接 %%，parseGroups 判 GroupError），第二条合法：
// runPage 重试一次就成了，这一页最终**有译文**且不计入失败。
const RETRY_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4-retry.json');
// 页 1 两条响应都是空译文：重试也救不回来，这一页判失败、不产块 → 右格那一块保留原文。
const EMPTY_TARGET_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4-empty-target.json');
// 页 1 第一条响应 stopReason=length（截断），随后两条是对半拆之后各半页的合法响应。
const TRUNCATED_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4-truncated.json');

const PAGE_W = 595;
const PAGE_H = 842;
// 4 页：fixture 逐页给响应，页数只要够「多页并发」这条路径成立即可。作业停在哪儿由下面的闸门
// 决定，不由页数多少决定——所以这里没有必要堆页数去换时间窗口。
const PAGES = 4;

const PLAIN_REL = 'plain.pdf';          // 无边车 → 翻译键的动作是「跑流水线」
const READY_REL = 'ok.pdf';             // 有可用译文 → 先进对照，再重新翻译
const READY_ZH_REL = '.ok.pdf.zh.json';

// buildPagedPdf 每页写一行 24 pt 的「Page N」，基线在 PDF y = h - 60，换成 scale 1 视口坐标
// （y 向下）大致落在 y ∈ [43, 60]、x ∈ [40, 115]。这个框把那行墨迹整个包住——**右格空不空白**
// 的判据就采在它里面：空白时逐像素都是主题纸色，照常合成时这里有原文的暗像素。
const INK = { x: 30, y: 35, w: 110, h: 30 };
// ok.pdf 那份边车里唯一一条有 target 的块。刻意避开 INK：重译前要能同时观察到「右格照常合成
// （INK 里有墨迹）」与「译文块渲染出来了」，两者不能互相遮挡。
const READY_BLOCK = { x: 60, y: 200, w: 460, h: 120 };

async function seedPlain(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, PLAIN_REL), buildPagedPdf(PAGES, PAGE_W, PAGE_H));
  // 不写 .plain.pdf.zh.json —— pdf.translation.load 对 ENOENT 返回 { doc: null }，即 `none` 态
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

// 同 seedPlain，只是设置里不给默认模型：pdf.translation.resolveModel 在 startTranslation 的
// 第一个 await 上就抛 llm.not_configured，不需要 translateFixture / 闸门——这条错误路径走不到
// 任何一次 pdf.translation.page 调用。
async function seedNoModel(home: string) {
  await seedSettings(home, { providerConfigured: false });
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, PLAIN_REL), buildPagedPdf(PAGES, PAGE_W, PAGE_H));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

// 没配模型 **且** 边车结构坏掉：翻译键因此处在 invalid 态（主键的动作是「覆盖磁盘上那份坏文件」，
// 要先过 confirm），而任何一次真发起的翻译都会在 resolveModel 上失败、在 Notice 上留下一条
// 「翻译失败：没有可用的模型」。两者凑在一起才测得到「确认框取消不该抹掉仍然成立的提示」。
async function seedInvalidNoModel(home: string) {
  await seedSettings(home, { providerConfigured: false });
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, PLAIN_REL), buildPagedPdf(PAGES, PAGE_W, PAGE_H));
  // kind 不认识 → validateTranslatedDoc 拒整份文件 → pdf.translation.load 抛 → setLoadError。
  await fs.writeFile(path.join(projectPath, `.${PLAIN_REL}.zh.json`), JSON.stringify({
    version: 1, pdf: PLAIN_REL, lang: { in: 'en', out: 'zh' },
    blocks: [{
      id: 'bad1', page: 1, x: 60, y: 200, width: 100, height: 20,
      fontSize: 11, kind: 'paragraph', source: 'a body paragraph', target: '译文',
    }],
  }, null, 2));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

// 每页两行的变体：截断那条用例要的是「一页拆得开」——buildPagedPdf 默认每页只有一行页码，
// 单行被截断时 runBatch 无处可拆（它会直接抛「单行输出仍被截断」，那是另一条路径）。
// extra 那行放在 y = 300，与页码那行（y ≈ 43–60）离得足够远，两个组的覆盖矩形不会互相
// 盖住对方的行——否则 checkGroupGeometry 会先把这一页判掉，测不到拆分本身。
async function seedTwoLines(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(
    path.join(projectPath, PLAIN_REL),
    buildPagedPdf(PAGES, PAGE_W, PAGE_H, { x: 40, y: 300, text: 'The second line of this page', size: 12 }),
  );
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

// 没有文本层的 PDF（内容流里只有图形算子）。不给 translateFixture：抽取阶段就中止，走不到
// 任何一次 pdf.translation.page 调用。
async function seedNoText(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, PLAIN_REL), buildNoTextPdf(PAGES, PAGE_W, PAGE_H));
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

/** 按 L 进对照，同 57 的写法：判据是右格出没出来，不等一个拍脑袋的毫秒数。 */
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
// 「作业进行中」的那几条断言（右格空白、取消、按 L、focus 重探）都要求作业**确定地**停在半路。
// fixture 的响应是从内存里取的，一趟 4 页跑完只要几十毫秒——靠堆页数去换一个时间窗口就是拿墙上
// 时间当判据，用例会以「有时候没赶上」的形式红。
//
// 所以把 `pdf.translation.page` 这一条 RPC 在**主进程**扣住：其余 RPC 原样透传，被扣的那几条等
// releaseGate 才真的落到 handler 上。作业于是**必然**停在「第一页的翻译请求已发出、未落地」这个
// 状态上（translateDoc 先单跑第 1 页拿 docTitle，所以扣住的恰好是一条），停多久由用例说了算。
// 对渲染层而言这与「模型很慢」一模一样：请求真的在飞，只是不回来。
//
// **为什么不在渲染层包 window.kydog**：contextBridge 把它挂成
// `writable: false, configurable: false` 的数据属性（实测：直接赋值静默无效，defineProperty 抛
// 「Cannot redefine property」），包不上。主进程这一侧走 Playwright 的 `app.evaluate`，动的是
// `ipcMain._invokeHandlers` 这张表——Electron 的内部字段，所以下面对它的形状做了显式校验：
// 哪天它变了名字，用例会当场炸，而不是「什么都没扣住却全绿」。
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
 * `hold`：要扣住哪几条方法。默认扣 `pdf.translation.page`（作业停在「第一页请求已发出、
 * 未落地」）；传 `['pdf.translation.save']` 则让翻译整趟跑完、确定地停在 **finalize** 阶段
 * ——那是取消键该禁用的那一档，除此之外没有别的办法把作业钉在这个只有一次 IPC 往返宽的窗口里。
 */
async function installTranslateGate({ app }: GateHost, hold: string[] = ['pdf.translation.page']) {
  const installed = await app.evaluate(({ ipcMain }, arg) => {
    const handlers = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, (...a: unknown[]) => unknown>;
    })._invokeHandlers;
    if (!(handlers instanceof Map)) return 'no-map';
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
 * `{ doc: null }`）。
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

/** 等第一页的翻译请求发出来并被闸门扣住 —— 作业确定地停在半路的那一刻。 */
async function waitJobParked(host: GateHost) {
  await expect.poll(
    () => heldCount(host),
    { timeout: 30000, message: '等作业跑到第一页的翻译请求上（抽取完成）' },
  ).toBeGreaterThan(0);
}

// 「右半边」是分栏改造之前的说法（那时两格在同一个滚动容器的同一行里）。现在浮层的父层就是
// **右栏**那个容器的兄弟（PdfFileTab 里右栏与 TranslationProgress 的共同 relative 父层），
// 措辞跟着 DOM 走。
test('59-pdf-translate: 点翻译键立刻进双栏，右格是空白像素、右栏里有进度浮层', async () => {
  const launched = await launchKydog({ seed: seedPlain, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PLAIN_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

    // 二期起「没有译文」从禁用变成可点：动作是跑翻译流水线，不是进对照。
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await installTranslateGate(launched);
    await pane.getByTestId('pdf-translate').click();

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

    const s = await waitSample(page, paneSel, INK, '翻译进行中');
    // 只断言「浮层在」是不够的：右格照常合成时那条也会绿。判据取像素本身。
    expect(s.themePaper, '主题纸色不该正好是纯白——否则「空白」与「照常合成一张白页」区分不开')
      .not.toEqual([255, 255, 255]);
    expect(s.leftDark, '左格这一块里得真有原文墨迹，右格「空白」才谈得上是把东西藏住了')
      .toBeGreaterThan(0);
    expect(s.paper, `右格这一块应当逐像素都是主题纸色 ${JSON.stringify(s)}`).toBe(s.total);
    expect(s.dark, '右格不该留下任何原文墨迹').toBe(0);
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 取消退回单栏，磁盘上什么都没写', async () => {
  const launched = await launchKydog({ seed: seedPlain, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, PLAIN_REL);
    const sidecar = path.join(projectPath, `.${PLAIN_REL}.zh.json`);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await installTranslateGate(launched);
    await pane.getByTestId('pdf-translate').click();
    await waitJobParked(launched);

    await pane.getByTestId('pdf-translate-cancel').click();
    await expect(pane.locator('[data-pdf-right="1"]'), '取消要退回单栏').toHaveCount(0);
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0);

    // 放行被扣住的那条请求：它落地时代际已经失配，组装与写盘都不该再发生。不放行的话这条用例
    // 只证明了「取消那一刻还没写盘」，证明不了「在途的请求跑完之后也不写」——而那正是 jobSeq
    // 要挡的东西。
    //
    // 「此后什么都不发生」这件事以前等的是 1.5 秒墙上时间：等不够就假绿（Task 15 要摘掉的
    // 就是这条）。改成两道确定的栅栏——① 主进程侧确认被扣住的那条请求真的跑完（回复已发出），
    // ② 再走一次 fenceRendererIpc，保证那条回复的续体在渲染层也已经跑完（见该函数的注释）。
    await releaseGate(launched);
    await expect.poll(
      async () => (await gateCounts(launched)).done['pdf.translation.page'] ?? 0,
      { timeout: 15000, message: '等被扣住的那条翻译请求真的跑完' },
    ).toBeGreaterThan(0);
    await fenceRendererIpc(page, pdfPath);

    const counts = await gateCounts(launched);
    // 两条断言分别钉住取消的两半：不再往下派页（worker 循环的取消检查点），不写盘（jobSeq）。
    // 前一条是有意义的：`jobSeq.current += 1` 那行去掉之后，被放行的第一页落地时会照常把其余
    // 三页派出去——而它们**先于**这条 fence 发出（同一条管道 FIFO），所以这里读到的必然是 4。
    expect(counts.started['pdf.translation.page'], '取消之后不该再派新的页')
      .toBe(1);
    expect(counts.started['pdf.translation.save'] ?? 0, '取消之后不该发出任何写盘请求').toBe(0);
    const exists = await fs.stat(sidecar).then(() => true, () => false);
    expect(exists, `取消之后不该有译文边车：${sidecar}`).toBe(false);
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 重新翻译——右格回到空白，旧译文块一并消失，跑完又都回来', async () => {
  // 计划里的第 9 条是「对照中点『重新翻译』键」。那个键本身属于 Task 14（PdfToolbar），Task 13
  // 落地时按钮还不存在，只有主键这一个入口——而 spec §1 明说「mismatch / invalid 那两档进不了
  // 对照，它们的主键语义就是重新翻译，两个入口同一个动作」。所以这里走 mismatch 这个入口，被测
  // 的东西一字不差：store 里留着上一版的 doc（连同它的块），此时发起一趟新作业，右格必须回到
  // 空白、旧块必须一并消失。这条留着不删：机制与走真按钮的那条一致，多测一条入口无害；真正走
  // `pdf-retranslate` 按钮、从 `dual === true` 发起的那条在下面（Task 14 补）。
  const launched = await launchKydog({ seed: seedReady, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, READY_REL);
    const zhPath = path.join(projectPath, READY_ZH_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    const blocks = page.locator(`${paneSel} [data-translation-block]`);

    // ① 先证明「有东西可消失」：右格照常合成（INK 那一块里原文墨迹还在），译文块也真渲染出来了。
    await enterDual(page, pane);
    const before = await waitSample(page, paneSel, INK, '重译之前');
    expect(before.leftDark, '左格这一块里得有原文墨迹').toBeGreaterThan(0);
    expect(before.dark, '重译之前右格是照常合成的：这一块里应当有原文墨迹').toBeGreaterThan(0);
    await expect(blocks.first(), '重译之前译文块是渲染出来的').toBeVisible();

    // ② 把边车摘要改成对不上：下一次重探 checkVersion 判 mismatch，setLoaded 自动收 dual。
    //    store 里那份 doc（连同块）仍在，主键的语义于是变成「重新翻译」。
    const zh = JSON.parse(await fs.readFile(zhPath, 'utf8')) as { source: { sha256: string } };
    zh.source.sha256 = 'f'.repeat(64);
    await fs.writeFile(zhPath, JSON.stringify(zh, null, 2));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(pane.locator('[data-pdf-right="1"]')).toHaveCount(0);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    // ③ 重新翻译：右格回到空白，旧块一并消失。mismatch 态点主键会先覆盖磁盘上已有的一份边车，
    //    走统一的 confirm() 确认框（Yee 拍板），这里先过一遍「确认」分支。
    await installTranslateGate(launched);
    await pane.getByTestId('pdf-translate').click();
    await confirmRetranslate(page);
    await waitJobParked(launched);
    const during = await waitSample(page, paneSel, INK, '重译进行中');
    expect(during.paper, `重译期间右格应当逐像素都是主题纸色 ${JSON.stringify(during)}`).toBe(during.total);
    // 译文层若不整层关掉，这里会是「空白底图 + 上一版译文浮在上面」——store 里那份 doc 还在，
    // 块照样有得渲染，所以这条不是恒真的。
    await expect(blocks, '重译期间旧译文块必须一并消失').toHaveCount(0);

    // ④ 放行 → 新边车落盘 → 走现有的 loadTranslation 重新加载 → 右格恢复合成、**新**块出现。
    //
    //    判据必须落在「是不是新那一版」上，不能只问「有没有块」：清掉 job 那一刻译文层就会重新
    //    渲染，而 store 里此刻还是上一版的 doc——「有块」在没重新加载的情况下也成立（实测：把
    //    「先清 job、再 loadTranslation」调换顺序，只问有没有块的写法照样全绿）。所以这里认块的
    //    **id**：新的一版由 buildBlocks 按页与最小行号编号（p1-b01），旧的那条是 fixture 里写死
    //    的 seed1，两者不可能混淆。这条因此真的钉住了那个顺序：反过来的话那趟加载会被 job 闸自己
    //    挡掉，边车虽然落了盘，界面上却永远停在上一版。
    await releaseGate(launched);
    const fresh = page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="p1-b01"]`);
    await expect(fresh, '跑完之后应当渲染的是**新**这一版的译文块').toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="seed1"]`),
      '上一版的块不该还留在那儿',
    ).toHaveCount(0);
    const after = await waitSample(page, paneSel, INK, '重译之后');
    expect(after.paper, `跑完之后右格不该还是一片主题纸色 ${JSON.stringify(after)}`).toBeLessThan(after.total);
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 已在对照中点「重新翻译」键——右格回到空白，跑完出现新块', async () => {
  // 上面那条「重新翻译」用例走的是 mismatch 入口代替（Task 13 落地时按钮还不存在）：那时 dual
  // 已经被 setLoaded 自动收掉，进入 startTranslation 时 wasDual 恒为 false，测不到 `dual ===
  // true` 时发起作业这条路径——而那正是 wasDual 这条修复（Task 14）要保的地方。这里改走真正的
  // pdf-retranslate 按钮，从 active 态（dual 已经是 true）发起。
  const launched = await launchKydog({ seed: seedReady, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, READY_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    const blocks = page.locator(`${paneSel} [data-translation-block]`);

    await enterDual(page, pane);
    await expect(blocks.first(), '进对照后旧译文块可见').toBeVisible();
    await expect(pane.getByTestId('pdf-translate')).toHaveAttribute('aria-label', '退出对照 · L');
    const retranslateBtn = pane.getByTestId('pdf-retranslate');
    await expect(retranslateBtn, '「重新翻译」键只在 active 态渲染').toBeVisible();

    await installTranslateGate(launched);
    await retranslateBtn.click();
    await confirmRetranslate(page);
    await waitJobParked(launched);

    const during = await waitSample(page, paneSel, INK, '按「重新翻译」键之后进行中');
    expect(during.paper, `重译期间右格应当逐像素都是主题纸色 ${JSON.stringify(during)}`).toBe(during.total);
    // 译文层若不整层关掉，这里会是「空白底图 + 上一版译文浮在上面」——同上面 mismatch 那条用例
    // 的判据，见其注释。
    await expect(blocks, '重译期间旧译文块必须一并消失').toHaveCount(0);
    // 仍在对照中，没有被踢出单栏——这条断言只有在从 dual === true 发起、且这一趟没出错时才成立，
    // 单独放这里是因为它此刻还测不出 wasDual 的修复（成功路径压根不碰 setDual），真正测到修复的
    // 是下面「被取消」那条用例。
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();

    await releaseGate(launched);
    const fresh = page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="p1-b01"]`);
    await expect(fresh, '跑完之后应当渲染的是新这一版的译文块').toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="seed1"]`),
      '上一版的块不该还留在那儿',
    ).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 对照中发起的重新翻译被取消——不会把用户踢出对照（wasDual 修复）', async () => {
  // 这才是真正钉住 wasDual 修复的用例：从 active 态（dual === true）发起重译，取消。修复前
  // cancelTranslation 无条件 setDual(false)，会把用户踢出这个本来完好的对照视图——store 里
  // 那份旧 doc 还在、右格本可以照常合成，退回单栏是纯粹的体验退化，不是任何数据一致性要求。
  const launched = await launchKydog({ seed: seedReady, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, READY_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

    await enterDual(page, pane);
    await installTranslateGate(launched);
    await pane.getByTestId('pdf-retranslate').click();
    await confirmRetranslate(page);
    await waitJobParked(launched);

    await pane.getByTestId('pdf-translate-cancel').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0);
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
    await expect(
      page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="seed1"]`),
      '取消之后旧译文块应当重新出现——右格是真的可用，不是空壳',
    ).toBeVisible();

    // 放行被扣住的那条请求：它落地时代际已经失配，不该再把 job / dual 写回去。
    await releaseGate(launched);
    await page.waitForTimeout(1000);
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 「重新翻译」确认框点取消——边车不变，没有发起任何翻译请求', async () => {
  // 三个入口（invalid/mismatch 主键、active 态的 pdf-retranslate）共用 PdfFileTab 里同一处
  // confirm() 调用（见 onToggleDual / onRetranslate 的注释），机制一致，这里只测一个入口的取消
  // 分支就够——挑 active 态的 pdf-retranslate 键，因为它最常用、断言起来也最直接（旧块原样还在）。
  //
  // 断言要落在协议层事实上，不是「弹出过一次对话框」这类过程性动作：
  //   ① 磁盘上的边车字节逐字节不变（不是只看 mtime）；
  //   ② `pdf.translation.page` / `pdf.translation.save` 一次都没被调用过——装闸门直接读 started
  //      计数，不靠等一段墙上时间去猜「后面没有再发生什么」；
  //   ③ 界面原样留在对照中，旧译文块还在。
  const launched = await launchKydog({ seed: seedReady, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, READY_REL);
    const zhPath = path.join(projectPath, READY_ZH_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    const before = await fs.readFile(zhPath, 'utf8');

    await enterDual(page, pane);
    await expect(page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="seed1"]`)).toBeVisible();

    await installTranslateGate(launched);
    await pane.getByTestId('pdf-retranslate').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

    // 确认框已经关掉、点取消这一路 confirm() 的 promise 直接 resolve(false)，压根没有一条 IPC
    // 请求发出过——不需要 fenceRendererIpc 那套栅栏（那是用来等一条**已经发出**的请求收尾）。
    const counts = await gateCounts(launched);
    expect(counts.started['pdf.translation.page'] ?? 0, '取消之后不该发出任何翻译请求').toBe(0);
    expect(counts.started['pdf.translation.save'] ?? 0, '取消之后不该发出任何写盘请求').toBe(0);
    expect(await fs.readFile(zhPath, 'utf8'), '取消之后边车必须逐字节保持不变').toBe(before);

    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0);
    await expect(pane.getByTestId('pdf-translate')).toHaveAttribute('aria-label', '退出对照 · L');
    await expect(pane.getByTestId('pdf-retranslate'), '仍是 active 态，「重新翻译」键还在').toBeVisible();
    await expect(page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="seed1"]`), '旧译文块原样还在')
      .toBeVisible();
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 翻译进行中，翻译键禁用、按 L 什么都不发生', async () => {
  const launched = await launchKydog({ seed: seedPlain, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PLAIN_REL);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await installTranslateGate(launched);
    await pane.getByTestId('pdf-translate').click();
    await waitJobParked(launched);

    await expect(pane.getByTestId('pdf-translate'), '翻译进行中翻译键禁用').toBeDisabled();
    expect(await pane.locator('[data-pdf-right="1"]').count()).toBeGreaterThan(0);

    // 键盘不经过 IconButton 的 disabled：L 自己要判一次同一份判据，判漏了就会在作业跑着的时候
    // 把 dual 收掉（右格连同进度浮层一起消失，而作业还在花钱）。
    await pane.locator('[data-testid^="pdf-scroll-"]').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('l');
    await page.waitForTimeout(500);

    await expect(pane.getByTestId('pdf-translate-progress'), '按 L 不该把浮层收掉').toBeVisible();
    // 用 > 0 而不是「与按之前相等」：双缓冲在作业期间可能正好多挂一层（进对照那次 fit-width
    // 排了一次清晰层提交），右格的**份数**会随之变。要挡的是「被踢出对照」，那是 0。
    expect(await pane.locator('[data-pdf-right="1"]').count(), '按 L 不该把用户踢出对照')
      .toBeGreaterThan(0);
    await expect(pane.getByTestId('pdf-translate')).toBeDisabled();
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 翻译期间的边车重探不会把用户踢出对照', async () => {
  const launched = await launchKydog({ seed: seedPlain, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PLAIN_REL);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();
    await installTranslateGate(launched);

    // ① 作业**启动前就已经在途**的那一趟 load。同一次 evaluate 里先发 focus、再点键：两件事
    //    落在同一个任务里，RPC 绝无可能在中间 resolve，「启动作业时正好有一趟在途」因此是确定
    //    的，不靠抢时间窗口。挡住它的是 startTranslation 里那句 translationSeq 自增——
    //    loadTranslation 开头那道 job 闸只管**之后**发起的重探，挡不住已经在途的这趟；它落地时
    //    盘上还没有边车，setLoaded(null) 会把 dual 收掉。
    await page.evaluate((sel) => {
      window.dispatchEvent(new Event('focus'));
      (document.querySelector(sel) as HTMLElement).click();
    }, testIdSelector('pdf-translate'));

    await waitJobParked(launched);
    await page.waitForTimeout(1000);   // 那趟在途的 load 只需一个 IPC 往返，1s 绰绰有余
    await expect(pane.getByTestId('pdf-translate-progress')).toBeVisible();
    expect(await pane.locator('[data-pdf-right="1"]').count(), '启动作业前在途的那趟加载不该收掉 dual')
      .toBeGreaterThan(0);

    // ② 翻译期间再触发一次 focus（真人切个窗口就会发生）：这次由 loadTranslation 开头的 job 闸
    //    挡住，压根不发 RPC。
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1000);
    await expect(pane.getByTestId('pdf-translate-progress')).toBeVisible();
    expect(await pane.locator('[data-pdf-right="1"]').count(), '翻译期间的 focus 重探不该收掉 dual')
      .toBeGreaterThan(0);
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 没配模型时点翻译——Notice 显示「翻译失败」，退回单栏', async () => {
  // Task 14 审查发现的头号缺口：translateError 接上 Notice 是这个任务的硬要求，之前完全没有
  // e2e 钉住——把 PdfFileTab 里 `<PdfAnnotationNotice translateError={translateError} />` 那行
  // props 去掉，gate 全绿、57/59（去掉这条之前）也全绿，谁也不会发现。不需要 translateFixture /
  // 闸门：resolveModel 在 startTranslation 的第一个 await 上就抛 llm.not_configured，走不到任何
  // 一次 pdf.translation.page 调用，是这条错误路径里最快、最不脆的触发方式。
  const launched = await launchKydog({ seed: seedNoModel });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PLAIN_REL);
    const pane = await openPdf(page, pdfPath);

    // 二期起「没有译文」从禁用变成可点：这条路径能走到，靠的正是这一点。
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();
    await pane.getByTestId('pdf-translate').click();

    // 进对照是点下去那一刻的事（startTranslation 在第一个 await 之前就 setDual），resolveModel
    // 的 await 一拒绝，catch 分支的 `if (!wasDualRef.current) setDual(tab.id, false)` 就会把它
    // 收掉——wasDualRef 在这条路径上是 false（进来之前不在对照中），所以这里断言的是退回单栏，
    // 不是留在对照。
    await expect(pane.getByTestId('pdf-notice'), 'Notice 应当显示 resolveModel 抛出的那句原话')
      .toContainText('翻译失败：没有可用的模型，请先在设置里配置');
    await expect(pane.locator('[data-pdf-right="1"]'), '没配模型时翻译失败要退回单栏').toHaveCount(0);
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 覆盖确认框点取消——一条仍然成立的错误提示不该被顺手抹掉', async () => {
  // 复审点名的一条：`onToggleDual` 里那句 `setTranslateError(null)` 原先排在 `confirm()`
  // **之前**，于是「按翻译键 → 看到确认框 → 取消」会顺手清掉一条此刻仍然成立的提示（典型如
  // 「没配模型」），而这一刻什么都没发生——用户按下取消，界面上唯一的线索却没了。
  //
  // 触发条件要两样东西同时成立：翻译键处在 invalid / mismatch（动作会覆盖磁盘上已有的边车，
  // 因而先过 confirm），并且 Notice 上正挂着一条 translateError。seedInvalidNoModel 把两样
  // 都造出来：坏边车给 invalid 态，没配模型让第一次确认过的翻译在 resolveModel 上失败。
  const launched = await launchKydog({ seed: seedInvalidNoModel });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PLAIN_REL);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    // 先真发起一次并让它失败，把那条提示挂上去（invalid 态覆盖已有边车 → 先过确认框）。
    await pane.getByTestId('pdf-translate').click();
    await confirmRetranslate(page);
    await expect(pane.getByTestId('pdf-notice'), '这一趟应当失败在 resolveModel 上')
      .toContainText('翻译失败：没有可用的模型，请先在设置里配置');

    // 再按一次，这次在确认框上点取消：什么都没发生，提示就该原样还在。
    await pane.getByTestId('pdf-translate').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

    await expect(pane.getByTestId('pdf-notice'), '取消覆盖之后那条提示仍然成立，不该被清掉')
      .toContainText('翻译失败：没有可用的模型，请先在设置里配置');
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 跑完之后仍能看到「N 页翻译失败」——失败页号随边车落盘', async () => {
  // Task 14 审查发现：Notice 原来判的是 `t?.job && t.job.failed > 0`，而作业完成后 job 整个变
  // null——「这趟有几页失败」在跑完那一刻，也就是用户最需要看到它的时刻，必然读不到。最终修法是
  // 让 translateDoc 把失败页号写进 doc.failedPages 一起落盘，Notice 从 store 里那份 doc 现读。
  // 这里用 ONE_FAIL_FIXTURE 让第 2 页两次响应都不含 "|"（parseGroups 两次都抛 GroupError，
  // runPage 重试一次后把页号 2 记下），其余三页正常——作业整体仍然成功跑完、写盘、走
  // loadTranslation 重新加载，不需要闸门。
  const launched = await launchKydog({ seed: seedPlain, translateFixture: ONE_FAIL_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PLAIN_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await pane.getByTestId('pdf-translate').click();
    // 等作业真的跑完：进度浮层消失、job 清空、右格开始正常合成（成功页的译文块渲染出来）。
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator(`${paneSel} [data-translation-block]`).first()).toBeVisible({ timeout: 20000 });

    await expect(pane.getByTestId('pdf-notice'), '作业跑完之后这条消息仍应可见')
      .toContainText('1 页翻译失败，右栏保留原文');
    // 顺带钉住信号的落点：Notice 上那句话的来源是**边车里的页号**，不是内存里某个作业留下的
    // 数字。页号而不是计数——计数是逐页信号的有损汇总，长度随时能推出来，反过来不行。
    expect((await readSidecar(path.join(kydogHome, 'proj', `.${PLAIN_REL}.zh.json`))).failedPages,
      '失败页号应当写进边车').toEqual([2]);
    // 失败页不该把用户踢出双栏——它只是那一页保留原文，不是整趟作业失败。
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 重新翻译被取消——「N 页翻译失败」仍显示上一趟的计数，不被清成 0', async () => {
  // 这条钉的不变量是「提示必须描述 store 里当前那份 doc」。取消 / 出错两个出口在 wasDual 为真时
  // 保留旧 dual 与那份旧 doc 不变（wasDual 修复本身要保证的行为），画面上仍是原来那份带失败页的
  // 旧译文——提示也就该原样留着。信号收口进边车之后这是白送的（doc 没换，doc.failedPages 自然
  // 没变），但它历史上真的被破坏过一次（那一版在 startTranslation 开头无条件把计数清成 0），
  // 所以这条用例留着守。
  //
  // 用 ONE_FAIL_FIXTURE 造出第一趟真实的失败页（同上面「跨 job 清空可读」那条），跑完确认 Notice
  // 显示「1 页翻译失败」；再点「重新翻译」进第二趟作业，扣住它、取消，断言 Notice 仍显示同一句——
  // 因为右格合成的仍是第一趟落盘的那份旧译文，doc 没变，计数不该变。
  const launched = await launchKydog({ seed: seedPlain, translateFixture: ONE_FAIL_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PLAIN_REL);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    // 第一趟：不装闸门，直接跑到底，落地 1 页失败。
    await pane.getByTestId('pdf-translate').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator(`${paneSel} [data-translation-block]`).first()).toBeVisible({ timeout: 20000 });
    await expect(pane.getByTestId('pdf-notice'), '第一趟跑完之后应显示 1 页失败')
      .toContainText('1 页翻译失败，右栏保留原文');
    // 此刻已经在对照中（第一趟成功就会进 active），「重新翻译」键应当可见。
    const retranslateBtn = pane.getByTestId('pdf-retranslate');
    await expect(retranslateBtn).toBeVisible();

    // 第二趟：装闸门、发起、停在半路、取消——doc 没变，仍是第一趟落盘的那份。
    await installTranslateGate(launched);
    await retranslateBtn.click();
    await confirmRetranslate(page);
    await waitJobParked(launched);
    await pane.getByTestId('pdf-translate-cancel').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0);

    // 关键断言：取消之后 Notice 应当仍显示第一趟的失败计数，不该因为第二趟刚起步就被清成 0。
    await expect(pane.getByTestId('pdf-notice'), '取消重译之后仍应显示上一趟真正跑完的失败计数')
      .toContainText('1 页翻译失败，右栏保留原文');
    // 顺带确认还在对照中——这不是本条的重点（wasDual 那条用例已经钉住），只是让上面那句断言的
    // 前提（「右格合成的仍是旧译文」）不是空中楼阁。
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();
  } finally {
    await teardown(launched);
  }
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
  const launched = await launchKydog({ seed: seedPlain, translateFixture: ONE_FAIL_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, PLAIN_REL);
    const sidecar = path.join(projectPath, `.${PLAIN_REL}.zh.json`);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    // 一趟跑到底：第 2 页两次响应都不含 "|"，其余三页正常。
    await pane.getByTestId('pdf-translate').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator(`${paneSel} [data-translation-block]`).first()).toBeVisible({ timeout: 20000 });
    await expect(pane.getByTestId('pdf-notice'), '跑完之后应显示 1 页失败')
      .toContainText('1 页翻译失败，右栏保留原文');
    expect((await readSidecar(sidecar)).failedPages, '失败页号应当写进边车').toEqual([2]);

    // 闸门只用来数 pdf.translation.* 的调用次数（hold 传空数组 = 一条都不扣，全部原样透传）。
    await installTranslateGate(launched, []);
    const before = (await gateCounts(launched)).started['pdf.translation.load'] ?? 0;

    // 切一次窗口。真人 alt-tab 回来就是这个事件，spec §3.4 靠它重探边车（边车是点号开头的
    // 文件，fileWatcher 跳过它，没有 file.changed 可用）。
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await fenceRendererIpc(page, pdfPath);

    const after = (await gateCounts(launched)).started['pdf.translation.load'] ?? 0;
    expect(after - before, 'focus 应当真的触发一次重探（另一次是 fence 自己）').toBe(2);

    // 关键断言：重探回来之后提示仍在。信号在盘上，不是内存里某个数字的余额。
    await expect(pane.getByTestId('pdf-notice'), '切一次窗口不该把「N 页翻译失败」抹掉')
      .toContainText('1 页翻译失败，右栏保留原文');
    // 顺带确认重探没有把用户踢出对照（setLoaded 的 dual 维持，与本条正交但同一条路径）。
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();
  } finally {
    await teardown(launched);
  }
});

// ── Task 15 补的六条 ───────────────────────────────────────────────────────────
//
// 前面那几条都把作业扣在半路上（闸门），验的是「跑的过程中界面对不对」。下面这几条相反：让
// fixture 一路跑完，验**结果**——边车落盘的内容、以及右格上真正画出来的像素。渲染类断言一律
// 取像素或磁盘，不取「元素在不在」：`[data-pdf-right="1"]` 那块 canvas 不管画的是内容还是一
// 整格纸色都在，而译文块 div 只要 store 里有 doc 就渲染得出来，两者都证明不了画对了。

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
    return {
      leftW: left.getBoundingClientRect().width,
      wrapW: left.parentElement!.getBoundingClientRect().width,
      rightPanes: document.querySelectorAll(`${sel} [data-pdf-pane="right"]`).length,
      dividers: document.querySelectorAll(`${sel} [data-testid="pdf-pane-divider"]`).length,
    };
  }, paneSel);
}

test('59-pdf-translate: 跑完之后边车落盘可解析，右格那一块的原文墨迹被译文块盖掉', async () => {
  const launched = await launchKydog({ seed: seedPlain, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, PLAIN_REL);
    const sidecar = path.join(projectPath, `.${PLAIN_REL}.zh.json`);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await pane.getByTestId('pdf-translate').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });

    // ① 边车真的落了盘，而且是一份能解析、块 id 与 target 都对得上的 JSON。
    await waitSidecar(sidecar);
    const doc = await readSidecar(sidecar);
    expect(doc.pdf, '边车记的是 PDF 的文件名').toBe(PLAIN_REL);
    const b1 = doc.blocks.find((b) => b.id === 'p1-b01');
    expect(b1?.target, 'fixture 给第 1 页的那句译文应当原样落进边车').toBe('第一页的译文');

    // ② 译文块渲染出来了，文字就是边车里那句。
    await expect(page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="p1-b01"]`)).toHaveText('第一页的译文');

    // ③ 像素：右格这一块里的原文墨迹没了（RightPage 按页背景色把块矩形填平了），左格同一块里
    //    还在。取样矩形直接用边车里那个块**自己的几何**内缩 1 pt，不写死坐标——写死的话 fixture
    //    PDF 的排版一改就会悄悄采到块外面去，而块外面本来就是白纸，`dark === 0` 恒成立，这条
    //    断言会退化成永远绿。内缩 1 pt 是为了避开 fillRect 的取整边界（实际覆盖区还要再外扩一个
    //    BLOCK_PAD，所以内缩之后必然仍在覆盖区里）。
    const inner = { x: b1!.x + 1, y: b1!.y + 1, w: b1!.width - 2, h: b1!.height - 2 };
    const s = await waitSample(page, paneSel, inner, '跑完之后');
    expect(s.leftDark, '左格这一块里得真有原文墨迹，右格「盖掉了」才谈得上').toBeGreaterThan(0);
    expect(s.dark, `右格这一块不该还留着原文墨迹 ${JSON.stringify(s)}`).toBe(0);
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 抽取完的页若不在渲染窗口内，当场还给 pdf.js（不变量 #8）', async () => {
  // 抽取一趟会碰**每一页**，而窗口里只挂得下几页。不还回去的话，翻一份 200 页的论文 =
  // 200 页 getTextContent() 的解析结果一直驻留到关 tab。lifecycle.sweep() 兜不住这条：翻译走的
  // 是 pdf.getPage(n) 现取，那些页从来没 acquire 过、也不一定在 pageProxies 里。
  //
  // 探针 __kydogTranslateCleanedPages 只数**这条路上真的调了 cleanup() 的页**（取
  // lifecycle.cleanedCount() 的差值），所以进对照本身引发的 sweep 清理不会混进来。
  const launched = await launchKydog({ seed: seedPlain, translateFixture: TRANSLATE_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PLAIN_REL);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await pane.getByTestId('pdf-translate').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });

    const cleaned = await page.evaluate(() =>
      (window as unknown as { __kydogTranslateCleanedPages?: number }).__kydogTranslateCleanedPages ?? 0);
    // 上界：窗口里至少挂着当前这一页，所以不可能 PAGES 页全清掉。这条同时是「fixture 还有
    // 区分力」的守卫——真到了窗口装得下全部 PAGES 页的那天，下面那条 > 0 会红，而不是悄悄
    // 变成一条永远成立的断言。
    expect(cleaned, `窗口外的页应当被还回去（本次 ${cleaned} 页）`).toBeGreaterThan(0);
    expect(cleaned, '窗口里那几页不该被清').toBeLessThan(PAGES);
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 第一条响应违反校验、第二条合法——重试成功，不计入失败', async () => {
  // spec §2.7：一页跑一次 → 失败重试一次 → 仍失败才记 failed。这里第 1 页的第一条响应是空
  // 译文（`1 | text` 后面直接 %%，parseGroups 判 GroupError），第二条合法——最终这一页**有
  // 译文**，且整趟作业零失败页。
  const launched = await launchKydog({ seed: seedPlain, translateFixture: RETRY_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, PLAIN_REL);
    const sidecar = path.join(projectPath, `.${PLAIN_REL}.zh.json`);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await pane.getByTestId('pdf-translate').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });
    await waitSidecar(sidecar);

    // 落盘的是**第二条**响应的译文：认这一句就等于认「重试真的发生过、而且用的是重试的结果」。
    // 只断言「这一页有块」是不够的——那在「第一条就被当成合法译文」的实现下也成立。
    const doc = await readSidecar(sidecar);
    expect(doc.blocks.find((b) => b.id === 'p1-b01')?.target, '第 1 页落盘的应当是重试那一条的译文')
      .toBe('第一页的译文（重试之后）');
    expect(doc.blocks.filter((b) => b.page === 1), '第 1 页应当正好一个块').toHaveLength(1);

    await expect(page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="p1-b01"]`))
      .toHaveText('第一页的译文（重试之后）');

    // 不计入失败：四页全成功、版本匹配、没有丢块 → Notice 一条消息都没有（它只有一行，任何一
    // 条成立都会渲染出这个节点）。所以「整个节点不存在」比「文案里没有『失败』二字」更严。
    await expect(pane.getByTestId('pdf-notice'), '重试成功的页不该被记成失败页').toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 空译文两次都不合法——该页判失败，右格那一块仍是原文像素', async () => {
  // 复审 P1-2 的反例：`1 | text` 后面直接 %% 解析成 target: ''，而 RightPage 判的是
  // `target === undefined`——'' 不是 undefined，块矩形照盖、译文层没字，结果是**一块被涂白的
  // 原文**。比不翻译糟得多，用户还看不出发生了什么。parseGroups 因此把空译文判成 GroupError，
  // 这一页两次都失败 → 不产块 → 右格那一块原样保留原文。
  //
  // 判据只能取像素：失败页在 DOM 上没有任何痕迹（没有块就没有元素），而右格那块 canvas 无论
  // 画的是原文、是涂白的空块、还是一整格纸色都一样在。
  const launched = await launchKydog({ seed: seedPlain, translateFixture: EMPTY_TARGET_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, PLAIN_REL);
    const sidecar = path.join(projectPath, `.${PLAIN_REL}.zh.json`);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await pane.getByTestId('pdf-translate').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });
    await waitSidecar(sidecar);

    const doc = await readSidecar(sidecar);

    // 像素这条排在最前：它才是这条用例要钉的东西。取样矩形借第 2 页那个块的几何——每页版面完全
    // 一样（buildPagedPdf 每页同一位置写一行页码），所以它就是第 1 页那一行**本来会被盖住**的
    // 那个矩形。失败页自己没有块可借，而写死坐标会让这条断言在排版一改时悄悄采空。
    const b2 = doc.blocks.find((b) => b.id === 'p2-b01');
    expect(b2, '第 2 页应当正常成功，用它的几何当取样矩形').toBeTruthy();
    const inner = { x: b2!.x + 1, y: b2!.y + 1, w: b2!.width - 2, h: b2!.height - 2 };
    const s = await waitSample(page, paneSel, inner, '失败页跑完之后');
    expect(s.leftDark, '左格这一块里得真有原文墨迹').toBeGreaterThan(0);
    // 右格是左格的 1:1 拷贝、这一页没有块可填，所以逐像素相等——不是「差不多」。被涂白的空块
    // 会让右边这个数掉到 0。
    expect(s.dark, `失败页右格应当与左格逐像素同样多的墨迹（原文原样保留）${JSON.stringify(s)}`)
      .toBe(s.leftDark);

    // 上面那条的成因：这一页两次都判不合法，所以压根没有块。
    expect(doc.blocks.filter((b) => b.page === 1), '第 1 页两次都不合法，不该产出任何块').toHaveLength(0);
    await expect(pane.getByTestId('pdf-notice'), '这一页判失败，右栏保留原文')
      .toContainText('1 页翻译失败，右栏保留原文');
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 输出被截断——对半拆重试，最终块数等于行数', async () => {
  // spec §2.4：整页原样重试只会再截断一次，处置必须是**拆**。fixture 给第 1 页三条响应：
  // 第一条 stopReason='length'（内容不参与解析），随后两条分别是拆开之后各半页（各一行）的
  // 合法响应。这一页有两行，所以最终应当是两个块——每行一个。
  const launched = await launchKydog({ seed: seedTwoLines, translateFixture: TRUNCATED_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, PLAIN_REL);
    const sidecar = path.join(projectPath, `.${PLAIN_REL}.zh.json`);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await pane.getByTestId('pdf-translate').click();
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0, { timeout: 20000 });
    await waitSidecar(sidecar);

    const doc = await readSidecar(sidecar);
    const p1 = doc.blocks.filter((b) => b.page === 1);
    // 被截断的那一页：两行拆成两组，块数 = 行数。没拆的话第二次尝试拿到的是只覆盖第 1 行的
    // 响应，parseGroups 的「不漏」检查会判整页无效 → 这一页一个块都没有。
    expect(p1.map((b) => b.target), '截断的页应当拆成每行一个块，顺序按最小行号')
      .toEqual(['第一页上半的译文', '第一页下半的译文']);
    expect(p1.map((b) => b.id)).toEqual(['p1-b01', 'p1-b02']);
    // 其余三页没被截断，一条响应覆盖两行 → 每页一个块。整份 5 个块，钉住「拆分只影响那一页」。
    expect(doc.blocks, '四页一共 2 + 1 + 1 + 1 个块').toHaveLength(5);
    await expect(pane.getByTestId('pdf-notice'), '截断被正确处置，没有失败页').toHaveCount(0);

    // 拆出来的第二个块真的画在了下半页——只看边车的话，块画没画出来还是未知数。
    await expect(page.locator(`${paneSel} [data-pdf-layer="stable"] [data-translation-block="p1-b02"]`))
      .toHaveText('第一页下半的译文');
  } finally {
    await teardown(launched);
  }
});

test('59-pdf-translate: 没有文本层的 PDF——Notice 报「没有文本层」，仍是单栏几何', async () => {
  // 抽取阶段每页零行 → translateDoc 的 `work.length === 0` 抛错中止（spec §4：「这页没字」与
  // 「这页抽取失败」是两件事，前者整份为空就是扫描件）。键仍可点：能不能翻译是点下去之后才知道
  // 的事，禁用它等于要求界面先猜一遍。
  const launched = await launchKydog({ seed: seedNoText });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, PLAIN_REL);
    const sidecar = path.join(projectPath, `.${PLAIN_REL}.zh.json`);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);

    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();
    const before = await paneLayout(page, paneSel);
    expect(before, '点之前就该量得到左栏').not.toBeNull();
    expect(before!.rightPanes, '点之前是单栏').toBe(0);
    expect(before!.leftW, '单栏时左栏就是 wrapper 那么宽').toBeCloseTo(before!.wrapW, 0);

    await pane.getByTestId('pdf-translate').click();

    await expect(pane.getByTestId('pdf-notice'), 'Notice 应当报出抽取阶段那句原话')
      .toContainText('翻译失败：这份 PDF 没有文本层');
    await expect(pane.getByTestId('pdf-translate-progress')).toHaveCount(0);

    // 「仍是单栏」取版面几何，不取「那块 canvas 在不在」：留在双栏的话左栏只有 wrapper 的一半宽，
    // 还多出一条分隔线和一个右栏容器。三条都断，任何一处没退干净都会红。
    await expect.poll(
      async () => (await paneLayout(page, paneSel))?.leftW,
      { timeout: 10000, message: '等失败之后退回单栏' },
    ).toBeCloseTo(before!.wrapW, 0);
    const after = (await paneLayout(page, paneSel))!;
    expect(after.leftW, `左栏应当仍铺满 wrapper ${JSON.stringify(after)}`).toBeCloseTo(after.wrapW, 0);
    expect(after.rightPanes, '不该留下右栏').toBe(0);
    expect(after.dividers, '不该留下分隔线').toBe(0);
    // 顺带确认这条失败路径什么都没写盘。
    expect(await fs.stat(sidecar).then(() => true, () => false), '抽取阶段就中止，不该有边车')
      .toBe(false);
  } finally {
    await teardown(launched);
  }
});

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
  // （ONE_FAIL_FIXTURE，第 2 页两次响应都不含 "|"）——三个数字这才与那组硬写值**逐个**不同，
  // 换成全成功的 fixture 只有 done/total 有区分力，failed 那位又回到零覆盖。
  const launched = await launchKydog({ seed: seedPlain, translateFixture: ONE_FAIL_FIXTURE });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const pdfPath = path.join(projectPath, PLAIN_REL);
    const sidecar = path.join(projectPath, `.${PLAIN_REL}.zh.json`);
    const paneSel = testIdSelector(`file-pane-${pdfPath}`);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-translate')).toBeEnabled();

    await installTranslateGate(launched, ['pdf.translation.save']);
    await pane.getByTestId('pdf-translate').click();

    await expect.poll(
      () => heldCount(launched),
      { timeout: 30000, message: '等作业跑到写盘请求上（进入 finalize）' },
    ).toBeGreaterThan(0);

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
  } finally {
    await teardown(launched);
  }
});
