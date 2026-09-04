import { test, expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector } from './helpers';
import { buildPagedPdf } from './fixtures/textPdf';
import { WINDOW_BUDGET_PX } from '../src/renderer/panels/main-pane/pdf/pageWindow';

// 这套用例专用的 fixture 尺寸：1600 × 2000 pt。55 那份 300 × 400 的两行正文撑不起来——
// - 页面积 3.2e6 pt² 让像素预算 4.8e7 反解出的栅格上界 sqrt(4.8e7 / 3.2e6) / dpr = 3.87 / dpr
//   落在 MAX_SCALE = 5 以内：捏到 500% 时 rasterScale 一定被咬住。同时它在 dpr ≤ 3 时都 > 1，
//   所以 100% 那一档不被咬，可以当干净基线。两条都与 dpr 无关，Retina 与否都成立
//   （300 × 400 的上界是 20 / dpr，远在 5 之外，永远咬不住，测不出封顶）。
// - 200 页让窗口在任何 dpr 下都只挂得下十几页，「裁掉了大部分」才有判据。
const PAGE_W = 1600;
const PAGE_H = 2000;
const LONG_PAGES = 200;
const PAGE_GAP = 16;   // 与 PdfFileTab 的同名常量对齐
const PAGE_PAD = 24;
const LONG_REL = 'many.pdf';
const BIG_REL = 'big.pdf';

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, LONG_REL), buildPagedPdf(LONG_PAGES, PAGE_W, PAGE_H));
  await fs.writeFile(path.join(projectPath, BIG_REL), buildPagedPdf(1, PAGE_W, PAGE_H));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
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

    // 100%：栅格上界 3.87 / dpr > 1，没被咬，位图就是 页宽 × dpr —— 干净基线
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

test('56-pdf-virtualization: 编辑中的文字注滚出视口再关文件，草稿不丢', async () => {
  const launched = await launchKydog({ seed: seedAll });
  const { kydogHome } = launched;
  const pdfPath = path.join(kydogHome, 'proj', LONG_REL);
  try {
    const { page } = launched;
    let pane = await openPdf(page, pdfPath);
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

    // 环节二：关 tab 重开——textarea 卸载，草稿只能靠 Task 1 的 flushDrafts 冲进 store 才落得了盘
    const tab = page.getByTestId(`tab-${pdfPath}`);
    await tab.hover();
    await page.getByTestId(`tab-close-${pdfPath}`).click();
    await expect(tab).toHaveCount(0);
    pane = await openPdf(page, pdfPath);
    await expect(pane.locator('[data-pdf-page="1"] [data-testid^="pdf-note-input-"]')).toHaveValue('还没失焦的草稿');
  } finally {
    await teardown(launched);
  }
});

test('56-pdf-virtualization: 逐页浏览之后确实清理过页面', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', LONG_REL);
    await openPdf(page, pdfPath); // 只用它的等待锚点确认已加载，返回的 pane 本用例用不上
    const scroll = page.locator(testIdSelector(`pdf-scroll-${pdfPath}`));

    // 逐页翻：每一步之间留够时间让 rAF 节流的 updateReadout → 窗口重算 → sweep 走完一轮，
    // 这里的等待只是给协议事件（scroll → 窗口变化 → 清理）留出发生的空间，不是拿它当判据——
    // 判据是下面读到的清理计数，不是等了多久。
    for (let i = 1; i <= 40; i++) {
      await scroll.evaluate((el, k) => { el.scrollTop = k * 3000; }, i);
      await page.waitForTimeout(60);
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

    // 顶替收尾——两条协议层事实一起看：① 位图分辨率变了（新层真的画完，不是空的，不是原地跳过）；
    // ② DOM 最终收回到只剩一层，且这层标记是 stable（旧层已被摘掉）。这条判据只证明「顶替确实
    // 发生」，证明不了走的是 promoteReady 的条件顶替还是 PROMOTE_TIMEOUT 的兜底——PdfFileTab.tsx
    // 里 promoteReady 上方的注释说得很清楚：从外部（含 e2e）看，两条路径唯一的可观测差别就是墙上
    // 时间，拿时间当判据既是启发式 proxy 也证明不了走的是哪条路，这个区分只用单测钉（promoteReady
    // 自己的单测）。这条 e2e 要补的缺口不在那，是「多页文档下这条端到端链路真的能跑通、真的会
    // 收敛」，此前只有单测覆盖到 promoteReady 这个纯函数本身，没有真的经过一次渲染 → 顶替的完整
    // 往返。（曾经加过一条「commit 之后先出现 2 层 incoming」的中间断言：实测里可见集往往只有一两页，
    // 渲染 + 顶替快到 5s 的轮询窗口一次都没逮到 2 层的瞬间，是在拿撞见时序当判据，删掉了。）
    await expect.poll(width, { timeout: 15000 }).toBeGreaterThan(at1);
    await expect(pane.locator('[data-pdf-layer]')).toHaveCount(1);
    await expect(pane.locator('[data-pdf-layer]')).toHaveAttribute('data-pdf-layer', 'stable');
  } finally {
    await teardown(launched);
  }
});
