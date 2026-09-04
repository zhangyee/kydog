import { test, expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector } from './helpers';
import { buildPagedPdf } from './fixtures/textPdf';
import { WINDOW_BUDGET_PX } from '../src/renderer/panels/main-pane/pdf/pageWindow';
import { PAGE_GAP, PAGE_PAD } from '../src/renderer/panels/main-pane/pdf/pageLayout';

// 这套用例专用的 fixture 尺寸：2400 × 500 pt。55 那份 300 × 400 的两行正文撑不起来——
// - 页面积 1.2e6 pt² 让像素预算 2.4e7 反解出的栅格上界 sqrt(2.4e7 / 1.2e6) / dpr = 4.47 / dpr
//   落在 MAX_SCALE = 5 以内：捏到 500% 时 rasterScale 一定被咬住。同时它在 dpr ≤ 4 时都 > 1，
//   所以 100% 那一档不被咬，可以当干净基线。两条都与 dpr 无关，Retina 与否都成立
//   （300 × 400 的上界是 28 / dpr，远在 5 之外，永远咬不住，测不出封顶）。
// - 页高 500 + 页间距 16 明显小于窗口视口高（1280 × 800 的窗口里滚动区约 700 px），于是
//   「视口上下各一个视口高度」的空间上界总能罩住可见页之外的邻页——预取真的发生，可见集是
//   挂载集的真子集，最后那条顶替用例才练得到 promoteReady 按可见页判定这件事。
// - 200 页让窗口在任何 dpr 下都只挂得下几页，「裁掉了大部分」才有判据。
const PAGE_W = 2400;
const PAGE_H = 500;
const LONG_PAGES = 200;
const LONG_REL = 'many.pdf';
const BIG_REL = 'big.pdf';
const LONG_SIDECAR_REL = '.many.pdf.json';

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, LONG_REL), buildPagedPdf(LONG_PAGES, PAGE_W, PAGE_H));
  await fs.writeFile(path.join(projectPath, BIG_REL), buildPagedPdf(1, PAGE_W, PAGE_H));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

async function readLongSidecar(home: string): Promise<{ annotations: Array<Record<string, unknown>> } | null> {
  try { return JSON.parse(await fs.readFile(path.join(home, 'proj', LONG_SIDECAR_REL), 'utf8')); }
  catch { return null; }
}

async function openPdf(page: Page, pdfPath: string): Promise<Locator> {
  await page.locator('[data-pane="workspace"]').getByText('测试 Thread').click();
  const row = page.getByTestId(`fs-${pdfPath}`);
  await row.waitFor();
  await row.dblclick();
  const pane = page.getByTestId(`file-pane-${pdfPath}`);
  // 200 页要先整趟预取完页尺寸才开画（页行的高度靠它），给足时间
  await expect(pane.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await expect(pane.getByTestId('pdf-annotation-layer-1')).toBeVisible();
  return pane;
}

/** 在滚动视口上连打几发 ctrl+wheel，把 targetScale 顶到 MAX_SCALE（每发 ×2.5，三发就够）。 */
async function pinchToMax(page: Page, pdfPath: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    for (let i = 0; i < 3; i++) {
      el.dispatchEvent(new WheelEvent('wheel', {
        ctrlKey: true, deltaY: -200,
        clientX: r.left + 40, clientY: r.top + 40, bubbles: true, cancelable: true,
      }));
    }
  }, testIdSelector(`pdf-scroll-${pdfPath}`));
}

/**
 * 逐帧发 ctrl+wheel，模拟真实捏合（每帧 ×1.06）。每帧记一次「可见页身上还有没有 canvas」——
 * 这是下面那条回归用例的判据，所以取样必须发生在帧与帧之间，不能等手势结束再看。
 */
async function pinchFrameByFrame(page: Page, pdfPath: string, visiblePage: number, frames: number) {
  return page.evaluate(async ({ sel, visiblePage, frames }) => {
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    const blank: number[] = [];
    const mounted: string[] = [];
    for (let i = 0; i < frames; i++) {
      el.dispatchEvent(new WheelEvent('wheel', {
        ctrlKey: true, deltaY: -8, clientX: r.left + 40, clientY: r.top + 40, bubbles: true, cancelable: true,
      }));
      await new Promise((res) => requestAnimationFrame(() => res(null)));
      const layer = document.querySelector('[data-pdf-layer="stable"]') as HTMLElement;
      if (!layer.querySelector(`[data-pdf-page="${visiblePage}"] canvas`)) blank.push(i);
      mounted.push(Array.from(layer.querySelectorAll('[data-pdf-mounted="1"]'))
        .map((e) => (e as HTMLElement).dataset.pdfPage).join(','));
    }
    return { blank, mounted };
  }, { sel: testIdSelector(`pdf-scroll-${pdfPath}`), visiblePage, frames });
}

test('56-pdf-virtualization: 长文档只挂载窗口内的页，未挂载的行照样占住位置', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', LONG_REL);
    const pane = await openPdf(page, pdfPath);
    const stable = pane.locator('[data-pdf-layer="stable"]');
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));

    // 1. 页行一个不少地在 DOM 里：虚拟化裁的是位图，不是行
    await expect(stable.locator('[data-pdf-page]')).toHaveCount(LONG_PAGES);

    // 2. 只有窗口内的行挂了内容，且远少于总页数
    const mounted = await stable.locator('[data-pdf-mounted="1"]').count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(LONG_PAGES / 2);
    // canvas 只长在挂载的行上，数目一一对应
    expect(await stable.locator('[data-pdf-page] canvas').count()).toBe(mounted);
    // 视口在顶部：第 1 页挂着，末页没挂
    await expect(stable.locator('[data-pdf-page="1"][data-pdf-mounted="1"]')).toHaveCount(1);
    await expect(stable.locator(`[data-pdf-page="${LONG_PAGES}"][data-pdf-mounted="1"]`)).toHaveCount(0);

    // 3. 窗口内所有位图加起来不超预算（这才是「裁到多少」的判据，页数只是它的结果）
    const totalPx = await stable.locator('canvas').evaluateAll(
      (cs) => cs.reduce((sum, c) => sum + (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height, 0),
    );
    expect(totalPx).toBeGreaterThan(0);
    expect(totalPx).toBeLessThanOrEqual(WINDOW_BUDGET_PX);

    // 4. 未挂载的行占住正确高度：scrollHeight 一开始就是终值，滚动条不会边滚边变长
    const expected = PAGE_PAD * 2 + LONG_PAGES * PAGE_H + (LONG_PAGES - 1) * PAGE_GAP;
    expect(await scroll.evaluate((el) => el.scrollHeight)).toBeCloseTo(expected, 0);

    // 5. 窗口跟着视口走：滚到第 100 页，第 1 页被卸载、第 100 页挂上、读数也跟上
    await scroll.evaluate((el, top) => { el.scrollTop = top; }, PAGE_PAD + 99 * (PAGE_H + PAGE_GAP) + 10);
    await expect(stable.locator('[data-pdf-page="100"][data-pdf-mounted="1"]')).toHaveCount(1);
    await expect(stable.locator('[data-pdf-page="1"][data-pdf-mounted="1"]')).toHaveCount(0);
    await expect(pane.getByTestId('pdf-readout')).toContainText(`100 / ${LONG_PAGES}`);
  } finally {
    await teardown(launched);
  }
});

test('56-pdf-virtualization: 高缩放下 canvas 位图被预算封顶，版面照样放大', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', BIG_REL);
    const pane = await openPdf(page, pdfPath);
    const row = pane.locator('[data-pdf-layer="stable"] [data-pdf-page="1"]');
    const canvas = row.locator('canvas');
    const width = () => canvas.evaluate((c) => (c as HTMLCanvasElement).width);

    // 100%：栅格上界 4.47 / dpr > 1，没被咬，位图就是 页宽 × dpr —— 干净基线
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const at1 = await width();
    expect(Math.abs(at1 - PAGE_W * dpr)).toBeLessThan(2);

    await pinchToMax(page, pdfPath);
    await expect(pane.getByTestId('pdf-readout')).toContainText('500%');
    // 新层画好后顶替（按可见页判定，不该等到 PROMOTE_TIMEOUT）
    await expect.poll(width, { timeout: 15000 }).toBeGreaterThan(at1);
    const at5 = await width();

    // 视觉放大了 5 倍，位图宽度不该也是 5 倍——它被 WINDOW_BUDGET_PX 封住了
    expect(at5).toBeLessThan(at1 * 5);
    // 封顶的位置就是预算本身：必保集合（这里只有第 1 页）恰好铺满预算
    const px = await canvas.evaluate((c) => (c as HTMLCanvasElement).width * (c as HTMLCanvasElement).height);
    expect(px).toBeLessThanOrEqual(WINDOW_BUDGET_PX);
    expect(px).toBeGreaterThan(WINDOW_BUDGET_PX * 0.95);
    // 差额由外层 CSS zoom 补：版面还是实打实的 5 倍，只是糊一点
    const box = (await row.boundingBox())!;
    expect(Math.abs(box.width - PAGE_W * 5)).toBeLessThan(10);
  } finally {
    await teardown(launched);
  }
});

test('56-pdf-virtualization: 捏合过程中可见页一帧都不掉（窗口输入是内容坐标，不跟着锚点漂走）', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', LONG_REL);
    const pane = await openPdf(page, pdfPath);
    const stable = pane.locator('[data-pdf-layer="stable"]');
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));

    // 翻到第 100 页：滚动的绝对位置足够大，缩放锚点每帧对 scrollTop 的修正量才够大。
    // 这条用例守的就是「窗口不能拿 scrollTop 当输入」——那个量捏合时每帧被改写，而喂进窗口的
    // 值必然落后一帧，落后量正比于滚动的绝对位置，长文档里就是好几页。改之前实测：25 帧的捏合
    // 里 24 帧可见页身上没有 canvas（整个手势屏幕是空白的）。窗口按内容坐标算才与它无关。
    await scroll.evaluate((el, top) => { el.scrollTop = top; }, PAGE_PAD + 99 * (PAGE_H + PAGE_GAP) + 10);
    await expect(stable.locator('[data-pdf-page="100"][data-pdf-mounted="1"]')).toHaveCount(1);

    const { blank, mounted } = await pinchFrameByFrame(page, pdfPath, 100, 12);
    expect(blank).toEqual([]);                       // 一帧都不许空
    expect(mounted[mounted.length - 1]).toContain('100');  // 窗口一路跟着可见页走
    await expect(pane.getByTestId('pdf-readout')).toContainText(`100 / ${LONG_PAGES}`);
  } finally {
    await teardown(launched);
  }
});

test('56-pdf-virtualization: 编辑中的文字注滚出视口，不失焦地走关闭链路草稿也落得了盘', async () => {
  const launched = await launchKydog({ seed: seedAll });
  const { kydogHome } = launched;
  const pdfPath = path.join(kydogHome, 'proj', LONG_REL);
  try {
    const { page } = launched;
    const pane = await openPdf(page, pdfPath);
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));

    await pane.getByTestId('pdf-tool-note').click();
    const layerBox = (await pane.getByTestId('pdf-annotation-layer-1').boundingBox())!;
    await page.mouse.click(layerBox.x + 100, layerBox.y + 100);
    const noteInput = pane.locator('[data-pdf-page="1"] [data-testid^="pdf-note-input-"]');
    await expect(noteInput).toBeFocused();
    await page.keyboard.type('还没失焦的草稿');
    await expect(noteInput).toHaveValue('还没失焦的草稿');

    // 环节一：滚到很远处（第 100 页）再看第 1 页——不点别处、不按 Escape，textarea 焦点不丢，
    // 靠的是 Task 7 的钉住（editingPage 进 must 集合）。先证明窗口真的挪走了（第 100 页挂上），
    // 再证明第 1 页依然挂着（data-pdf-mounted，协议层事实，不是「textarea 还有内容」这种间接推断）——
    // 这两条缺一不可：只测最后一步的话，钉住失效但 flushDrafts 兜住了，测试照样绿。
    await scroll.evaluate((el, top) => { el.scrollTop = top; }, PAGE_PAD + 99 * (PAGE_H + PAGE_GAP) + 10);
    await expect(pane.locator('[data-pdf-page="100"][data-pdf-mounted="1"]')).toHaveCount(1);
    await expect(pane.locator('[data-pdf-page="1"][data-pdf-mounted="1"]')).toHaveCount(1);
    await expect(noteInput).toHaveValue('还没失焦的草稿');
    await expect(noteInput).toBeFocused();

    // 环节二：**不失焦**地走一遍关闭链路，草稿只能靠 flushDrafts 冲进 store 才落得了盘。
    //
    // 关闭链路故意选 beforeunload（关窗口 / 退出应用走的就是它）而不是点 tab-close 按钮：点按钮
    // 会先给 textarea 发一次 blur（Chromium 实测事件序 blur, click），NoteBox 的 commit() 抢在
    // 前面就把文本写进 store、把草稿表清空了，等 flushDrafts 跑到时是一次空转——那样这条用例
    // 测的其实是 blur → commit，把 PdfFileTab 里的 flushDrafts 整行删掉它照样绿。
    // beforeunload 全程不碰焦点：先断言焦点还在（草稿仍只存在于模块级 Map 里），再派发事件，
    // 落盘就只剩 flushDrafts 这一条路。
    await expect(noteInput).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
    // 轮询的是文本本身，不是条数：落笔那一下（addNote）就已经把一条 text: '' 的笔记按防抖写过
    // 一次盘了，光看条数会被那一份满足，读到的却可能还是空文本。
    await expect.poll(async () => (await readLongSidecar(kydogHome))?.annotations[0]?.text ?? null)
      .toBe('还没失焦的草稿');
    const notes = (await readLongSidecar(kydogHome))!.annotations;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: 'note', page: 1 });
  } finally {
    await teardown(launched);
  }
});

test('56-pdf-virtualization: 逐页浏览之后确实清理过页面', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', LONG_REL);
    const pane = await openPdf(page, pdfPath);
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));
    const readout = pane.getByTestId('pdf-readout');

    // 用「挂载集合变了」当判据试过——不行：文档一开始窗口只挂 {1,2,3}，卡住它的是空间上界
    // （视口上下各一个视口高度，pageWindow.ts 的 bandTop/bandBottom），不是像素预算——本文件
    // 这份尺寸在 dpr 1 下预算能装 20 页（2.4e7 / (2400×500)），远没被挤满。从第 1 页往下滚的
    // 头几步，lo 边界（页号不能 < 1）先撞满、扩张只能靠 hi 侧推进，而 hi 侧很快撞上空间上界，
    // 反复算下来还是 {1,2,3}——挂载集合真的没变，不是
    // sweep 没跑，这不是卡住，是这几步本来就没有「挂载集合层面」的变化可等。
    // 换成 pdf-readout 的文本（当前最可见页）：它是连续的位置判定，不是预算限制的离散集合，
    // 2000px 的步长（> 一页行高 516，且 40 步 × 2000 = 80000 还没滚到 103232 的底）几乎必然
    // 让它每步都变，用它判定「这一步滚动真的被处理过、滚动帧 → 窗口重算的链路真的跑完」——
    // 不是靠猜一个「大概率够用」的固定毫秒数。
    let prevText = await readout.textContent();
    for (let i = 1; i <= 40; i++) {
      await scroll.evaluate((el, k) => { el.scrollTop = k * 2000; }, i);
      await expect.poll(() => readout.textContent()).not.toBe(prevText);
      prevText = await readout.textContent();
    }
    const cleaned = await page.evaluate(() =>
      (window as unknown as { __kydogCleanedPages?: number }).__kydogCleanedPages ?? 0);
    expect(cleaned).toBeGreaterThan(0);
  } finally {
    await teardown(launched);
  }
});

test('56-pdf-virtualization: 多页文档下完整走完一次缩放提交，顶替确实发生', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', LONG_REL);
    const pane = await openPdf(page, pdfPath);
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));

    // 翻到中间页：窗口里除了可见页还挂着预取的邻页（可见集是挂载集的真子集）——这条路径单页文档
    // （前一条用例用的 BIG_REL）测不出来，可见集恰好等于挂载集，练不到 promoteReady 按可见页
    // 判定这件事本身。
    await scroll.evaluate((el, top) => { el.scrollTop = top; }, PAGE_PAD + 49 * (PAGE_H + PAGE_GAP) + 10);
    const row = pane.locator('[data-pdf-layer="stable"] [data-pdf-page="50"]');
    await expect(row).toHaveAttribute('data-pdf-mounted', '1');
    const canvas = row.locator('canvas');
    const width = () => canvas.evaluate((c) => (c as HTMLCanvasElement).width);
    const at1 = await width();

    await pinchToMax(page, pdfPath);

    // 顶替收尾——三条协议层事实一起看：① 位图分辨率变了（新层真的画完，不是空的，不是原地跳过）；
    // ② DOM 最终收回到只剩一层，且这层标记是 stable（旧层已被摘掉）；③ 这层的
    // data-pdf-promote-reason 是 'condition'，不是 'timeout'。
    //
    // ①② 只能证明「最终某种方式会收敛」，证明不了走的是 promoteReady 的条件顶替还是
    // PROMOTE_TIMEOUT 的兜底——哪怕 promoteReady 被彻底破坏（比如永远返回 false，或可见集变化
    // 那个 effect 的依赖数组漏挂，重判从不触发），只要 4 秒兜底计时器还在，①②在 15s 的轮询
    // 窗口内照样会绿，而「不该每次缩放都卡满超时」正是 Task 5 引入 promoteReady 要解决的问题，
    // 也是这条 e2e 存在的理由——不能让它对这类回归失明。
    // ③ 补上这个区分力：PdfFileTab.tsx 里 promote() 的三个调用点（onPageSettled 的条件判定、
    // 可见集变化后的重判定、PROMOTE_TIMEOUT 兜底）现在各自把触发原因打到 data-pdf-promote-reason
    // 上，让「走的是哪条路」从组件外部也能读到——不再是只能靠墙上时间去猜的黑盒，也不用靠单测
    // 才能钉住（promoteReady 自己的单测测的是这个纯函数本身「该不该顶替」，不覆盖「它有没有真的
    // 在一次端到端的渲染里被调用到、赶在兜底之前顶替」这件事）。
    await expect.poll(width, { timeout: 15000 }).toBeGreaterThan(at1);
    const stable = pane.locator('[data-pdf-layer="stable"]');
    await expect(pane.locator('[data-pdf-layer]')).toHaveCount(1);
    await expect(stable).toHaveAttribute('data-pdf-promote-reason', 'condition');
  } finally {
    await teardown(launched);
  }
});
