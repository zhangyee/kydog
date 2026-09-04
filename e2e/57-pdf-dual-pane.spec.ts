import { test, expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector } from './helpers';
import { buildPagedPdf } from './fixtures/textPdf';

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
      id: `b${p}-text`, page: p, x: 60, y: 200, width: 460, height: 120,
      fontSize: 11, kind: 'text', source: 'a body paragraph', target: '一段正文',
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
  const pdf = buildPagedPdf(PAGES, PAGE_W, PAGE_H);
  await fs.writeFile(path.join(projectPath, PDF_REL), pdf);
  await fs.writeFile(path.join(projectPath, ZH_REL), buildSidecar(pdf));
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

type RowGeom = { page: string; sized: boolean; dTop: number | null; dHeight: number | null };

/** 清晰层里每个已挂载页行的左右两格几何差。读的是 getBoundingClientRect，含外层 zoom。 */
async function rowGeometry(page: Page, paneSel: string): Promise<RowGeom[]> {
  return page.evaluate((sel) => {
    const rows = Array.from(
      document.querySelectorAll(`${sel} [data-pdf-layer="stable"] [data-pdf-page][data-pdf-mounted="1"]`),
    );
    return rows.map((row) => {
      const left = row.querySelector('canvas:not([data-pdf-right])') as HTMLCanvasElement | null;
      const right = row.querySelector('canvas[data-pdf-right]') as HTMLCanvasElement | null;
      const lr = left?.getBoundingClientRect();
      const rr = right?.getBoundingClientRect();
      return {
        page: (row as HTMLElement).dataset.pdfPage ?? '?',
        // react-pdf 要等自己的 effect 跑过才给左格 canvas 写 CSS 尺寸；在那之前它是
        // 300 × 150 的固有尺寸，量出来的差值没有意义。sized 把「还没定尺寸」与「没对齐」分开。
        sized: !!left && left.style.width !== '' && !!right,
        dTop: lr && rr ? Math.abs(lr.top - rr.top) : null,
        dHeight: lr && rr ? Math.abs(lr.height - rr.height) : null,
      };
    });
  }, paneSel);
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
          const g = await rowGeometry(page, paneSel);
          return g.length > 0 && g.every((r) => r.sized);
        },
        { timeout: 15000, message: `${label}：等两格都定好尺寸` },
      ).toBe(true);
      const g = await rowGeometry(page, paneSel);
      for (const r of g) {
        expect(r.dTop ?? Infinity, `${label} 第 ${r.page} 页顶边`).toBeLessThan(0.5);
        expect(r.dHeight ?? Infinity, `${label} 第 ${r.page} 页高度`).toBeLessThan(0.5);
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

    // 捏合到 150%，等新层顶替，两格照样对齐（两栏的 CSS 尺寸出自同一个 layer.scale）
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new WheelEvent('wheel', {
        ctrlKey: true, deltaY: -66.67,
        clientX: r.left + r.width / 2, clientY: r.top + 120, bubbles: true, cancelable: true,
      }));
    }, testIdSelector(`pdf-scroll-${pdfPath}`));
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
