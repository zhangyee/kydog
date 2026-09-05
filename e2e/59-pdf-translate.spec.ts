import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector } from './helpers';
import { buildPagedPdf } from './fixtures/textPdf';
import { RPC_CHANNEL } from '../src/shared/protocol';

/**
 * 翻译流水线的端到端用例（spec `2026-09-05-pdf-translation-pipeline-design.md`）。
 *
 * 逐页响应走 `KYDOG_TRANSLATE_FIXTURE`（launchKydog 的 translateFixture 选项）：主进程仍走
 * `pdfTranslatePage.ts` 那条同样的 semaphore 与并发路径，只是不碰上游模型。fixture 的形状是
 * `{ "<页码>": [{ text, stopReason }] }`，`text` 是 §6 那份 `%%` 协议的原样输出——解析与三层
 * 校验在渲染层，e2e 与生产因此跑的是同一份纯函数。
 *
 * 本文件目前覆盖 Task 13 接线的五条（计划里的第 2 / 4 / 9 / 10 / 11 条）；其余八条随 Task 15 补。
 * Task 14 把第 9 条（对照中「重新翻译」键）从 mismatch 入口代替升级成走真正的 `pdf-retranslate`
 * 按钮（原来那条 mismatch 入口的用例留着不删——机制仍然一致，多测一条入口无害），并补了一条不
 * 在原始 13 条清单内的回归用例：从 active 态（`dual === true`）发起的重译一旦被取消，不该把
 * 用户踢出这个本来完好的对照视图（PdfFileTab 的 `wasDualRef` 修复，Task 14 审查发现的真 bug）。
 *
 * Task 14 审查（Needs fixes）之后又补了两条零回归覆盖：
 *   - 没配模型时点翻译，`translateError` 要能在 Notice 上显示出来（本任务的头号要求，之前完全
 *     没有 e2e 钉住——上一版实现者验证过一次就删了 scratch 用例，`translateError` 这行 props
 *     去掉照样全绿）。
 *   - 一趟作业**跑完之后**，若有页失败，「N 页翻译失败」这条消息仍要可见（`lastFailedPages`，
 *     TBucket 上跨 job 清空仍可读的字段——`job.failed` 在 finalize 阶段被硬写成 0、job 完成后
 *     整个变 null，用它判的话这条消息在用户最需要看到它的那一刻必然读不到）。
 */

const TRANSLATE_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4.json');
// 页 2 的响应故意不含 "|"：parseGroups 两次都抛 GroupError（runPage 重试一次），页 2 记
// failed++，其余三页正常成功——用来验证作业跑完之后 lastFailedPages 仍能读到「1 页失败」。
const ONE_FAIL_FIXTURE = path.resolve('e2e/fixtures/translate/pages-4-one-fails.json');

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
type Gate = { held: Array<() => void>; open: boolean };
type GateGlobal = { __kydogTranslateGate?: Gate };

async function installTranslateGate({ app }: GateHost) {
  const installed = await app.evaluate(({ ipcMain }, channel) => {
    const handlers = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, (...a: unknown[]) => unknown>;
    })._invokeHandlers;
    if (!(handlers instanceof Map)) return 'no-map';
    const orig = handlers.get(channel);
    if (!orig) return 'no-handler';
    const gate: Gate = { held: [], open: false };
    (globalThis as GateGlobal).__kydogTranslateGate = gate;
    handlers.set(channel, async (...args: unknown[]) => {
      const payload = args[1] as { method?: string } | undefined;
      if (payload?.method === 'pdf.translation.page' && !gate.open) {
        await new Promise<void>((resolve) => { gate.held.push(resolve); });
      }
      return orig(...args);
    });
    return 'ok';
  }, RPC_CHANNEL);
  if (installed !== 'ok') throw new Error(`装不上翻译闸门：ipcMain 的 handler 表对不上（${installed}）`);
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
    const row = document.querySelector(`${sel} [data-pdf-layer="stable"] [data-pdf-page="1"]`);
    const left = row?.querySelector('canvas:not([data-pdf-right])') as HTMLCanvasElement | null;
    const right = row?.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement | null;
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

test('59-pdf-translate: 点翻译键立刻进双栏，右格是空白像素、右半边有进度浮层', async () => {
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
    await releaseGate(launched);
    await page.waitForTimeout(1500);
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

    // ③ 重新翻译：右格回到空白，旧块一并消失。
    await installTranslateGate(launched);
    await pane.getByTestId('pdf-translate').click();
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
    const fresh = page.locator(`${paneSel} [data-translation-block="p1-b01"]`);
    await expect(fresh, '跑完之后应当渲染的是**新**这一版的译文块').toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(`${paneSel} [data-translation-block="seed1"]`),
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
    const fresh = page.locator(`${paneSel} [data-translation-block="p1-b01"]`);
    await expect(fresh, '跑完之后应当渲染的是新这一版的译文块').toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(`${paneSel} [data-translation-block="seed1"]`),
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
    await expect(
      page.locator(`${paneSel} [data-translation-block="seed1"]`),
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

test('59-pdf-translate: 跑完之后仍能看到「N 页翻译失败」——lastFailedPages 跨 job 清空可读', async () => {
  // Task 14 审查发现：Notice 原来判的是 `t?.job && t.job.failed > 0`，而 finalize 阶段把
  // job.failed 硬写成 0、作业完成后 job 又整个变 null——「这趟有几页失败」在跑完那一刻，也就是
  // 用户最需要看到它的时刻，必然读不到。修法是把最后一趟的失败计数落进 TBucket.lastFailedPages，
  // 跨 job 清空仍可读。这里用 ONE_FAIL_FIXTURE 让第 2 页两次响应都不含 "|"（parseGroups 两次都
  // 抛 GroupError，runPage 重试一次后记 failed++），其余三页正常——作业整体仍然成功跑完、写盘、
  // 走 loadTranslation 重新加载，不需要闸门。
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
    // 失败页不该把用户踢出双栏——它只是那一页保留原文，不是整趟作业失败。
    await expect(pane.locator('[data-pdf-right="1"]').first()).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
