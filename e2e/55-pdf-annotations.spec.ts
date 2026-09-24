import { test, expect, type Page, type Locator, type ConsoleMessage } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector, type LaunchedApp } from './helpers';
import { buildTextPdf } from './fixtures/textPdf';
import { wheelZoomSensitivity } from '../src/renderer/panels/main-pane/pdf/pdfPointerInteraction';

/**
 * PDF 标注：高亮落盘、撤销重做删除、文字注落盘与关 tab 重开、文字注挪位改宽、150% 缩放下坐标
 * 一致、坏边车只读。串行共用一次启动。
 *
 * **每条用例一份自己的 PDF**（同一份 fixture 字节、不同文件名，边车因此各是各的）：条数、
 * `annotations[0]`、`pdf-note-*` 的 `.first()` 这些判据都写成「这份文档里只有我这条的东西」，
 * 共用一份边车就得把它们改成相对前一条的增量，判据跟着变弱。缩放也是逐 tab 的，150% 那条
 * 放在自己的文档上，不会把别人的 1× 几何带歪。坏 JSON 边车那条本来就要一份预先写坏的边车。
 *
 * 「只打开不编辑 → 关掉 tab 也不生成边车文件」不在这里：saveScheduler.test.ts 的「watchDocs 把
 * 加载当成干净：只打开不编辑，之后 flush 不写盘」与「打开没编辑就关（markClean 之后 flush）不写盘」
 * 守着同一件事，e2e 那条还得靠一次固定等待。重启之后还原不在这里：标注是从盘上的边车读回来的，
 * 关 tab 重开已经走完「读盘 → 还原」这条链，重启只是多一次冷启动。
 */
test.describe.configure({ mode: 'serial' });

const HIGHLIGHT_REL = 'highlight.pdf';
const UNDO_REL = 'undo.pdf';
const NOTE_REL = 'note.pdf';
const MOVE_REL = 'move.pdf';
const ZOOM_REL = 'zoom.pdf';
const BROKEN_REL = 'broken.pdf';
const sidecarRel = (pdfRel: string) => `.${pdfRel}.json`;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
// fixture 是 300 × 400 pt（见 e2e/fixtures/textPdf.ts）；第一行字身框视口 [46, 60]，
// 行中线取基线上方 1/4 字高 = 56.5（记号笔该压的位置，不是字身框正中），第二行同理 96.5。
const LINE1_Y = 56.5;

let launched: LaunchedApp;
let proj = '';
const at = (rel: string) => path.join(proj, rel);

test.beforeAll(async () => {
  launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      proj = path.join(home, 'proj');
      await fs.mkdir(proj, { recursive: true });
      for (const rel of [HIGHLIGHT_REL, UNDO_REL, NOTE_REL, MOVE_REL, ZOOM_REL, BROKEN_REL]) {
        await fs.writeFile(path.join(proj, rel), buildTextPdf());
      }
      await fs.writeFile(path.join(proj, sidecarRel(BROKEN_REL)), '{broken');
      await seedProject(home, proj, [{ id: 'thr-1', title: '测试 Thread' }]);
    },
  });
});

test.afterAll(async () => { await teardown(launched); });

async function openPdf(page: Page, pdfPath: string): Promise<Locator> {
  // 用 'text=测试 Thread' 在标题栏已经显示"测试 Thread · proj"（thread 已被选中过）时会
  // 撞上标题栏的拖拽区（title-bar 是 WebkitAppRegion: drag，遮住了实际点击目标）；scope 到
  // workspace 侧栏，只匹配文件树/线程列表里的那一个。
  await page.locator('[data-pane="workspace"]').getByText('测试 Thread').click();
  const row = page.getByTestId(`fs-${pdfPath}`);
  await row.waitFor();
  await row.dblclick();
  const pane = page.getByTestId(`file-pane-${pdfPath}`);
  await expect(pane.locator('canvas').first()).toBeVisible({ timeout: 10000 });
  await expect(pane.getByTestId('pdf-annotation-layer-1')).toBeVisible();
  return pane;
}

/** 在页坐标（scale 1 视口单位）上拖一笔；层的 boundingBox 随缩放变，按比例换算。 */
async function drawStroke(page: Page, layer: Locator, x1: number, y1: number, x2: number, y2: number) {
  const box = (await layer.boundingBox())!;
  const sx = box.width / 300;
  const sy = box.height / 400;
  await page.mouse.move(box.x + x1 * sx, box.y + y1 * sy);
  await page.mouse.down();
  await page.mouse.move(box.x + x2 * sx, box.y + y2 * sy, { steps: 8 });
  await page.mouse.up();
}

async function readSidecar(pdfRel: string): Promise<{ annotations: Array<Record<string, unknown>> } | null> {
  try { return JSON.parse(await fs.readFile(at(sidecarRel(pdfRel)), 'utf8')); }
  catch { return null; }
}

async function pinch(page: Page, pdfPath: string, deltaY: number) {
  await page.evaluate(({ sel, deltaY }) => {
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY, clientX: r.left + r.width / 2, clientY: r.top + 120, bubbles: true, cancelable: true }));
  }, { sel: testIdSelector(`pdf-scroll-${pdfPath}`), deltaY });
}

test('55-pdf-annotations: 拖一笔高亮 → 边车里有 line 段且带原文', async () => {
  const { page } = launched;
  const errors: string[] = [];
  const onConsole = (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); };
  page.on('console', onConsole);
  try {
    const pdfPath = at(HIGHLIGHT_REL);
    const pane = await openPdf(page, pdfPath);
    await pane.getByTestId('pdf-tool-highlight').click();
    await expect(pane.getByTestId('pdf-tool-card-highlight')).toBeVisible();
    await drawStroke(page, pane.getByTestId('pdf-annotation-layer-1'), 45, LINE1_Y, 200, LINE1_Y + 1);

    await expect.poll(async () => (await readSidecar(HIGHLIGHT_REL))?.annotations.length ?? 0).toBe(1);
    const doc = (await readSidecar(HIGHLIGHT_REL))!;
    const h = doc.annotations[0] as { type: string; color: string; width: number; segments: Array<{ kind: string; y: number; text?: string }> };
    expect(h).toMatchObject({ type: 'highlight', color: 'amber', width: 2 });
    // 一行上的一笔就是一条直线：不许因为采样抖动碎成几段（用户反馈 2）
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].kind).toBe('line');
    expect(Math.abs(h.segments[0].y - LINE1_Y)).toBeLessThan(3);
    expect(h.segments[0].text).toContain('passage');
    await expect(pane.locator('[data-testid^="pdf-highlight-"]')).toHaveCount(1);
    // 落笔即收起参数卡片（用户反馈 3）。正向对照是上面落笔前那条 toBeVisible。
    await expect(pane.getByTestId('pdf-tool-card-highlight')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    page.off('console', onConsole);
  }
});

test('55-pdf-annotations: ⌘Z 撤销、⇧⌘Z 重做、选中后 Delete 删除，边车同步', async () => {
  const { page } = launched;
  const pane = await openPdf(page, at(UNDO_REL));
  await pane.getByTestId('pdf-tool-highlight').click();
  await drawStroke(page, pane.getByTestId('pdf-annotation-layer-1'), 45, LINE1_Y, 200, LINE1_Y);
  await expect.poll(async () => (await readSidecar(UNDO_REL))?.annotations.length ?? 0).toBe(1);

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(async () => (await readSidecar(UNDO_REL))?.annotations.length ?? -1).toBe(0);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect.poll(async () => (await readSidecar(UNDO_REL))?.annotations.length ?? 0).toBe(1);

  await page.keyboard.press('v');
  await pane.locator('[data-testid^="pdf-highlight-"] path').first().click({ force: true });
  await expect(pane.getByTestId('pdf-selection-bar')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await readSidecar(UNDO_REL))?.annotations.length ?? -1).toBe(0);
  await expect(pane.getByTestId('pdf-selection-bar')).toHaveCount(0);
});

test('55-pdf-annotations: 文字注落盘，关 tab 重开后还原', async () => {
  const { page } = launched;
  const pdfPath = at(NOTE_REL);
  let pane = await openPdf(page, pdfPath);
  await pane.getByTestId('pdf-tool-note').click();
  const box = (await pane.getByTestId('pdf-annotation-layer-1').boundingBox())!;
  await page.mouse.click(box.x + 150, box.y + 250);
  const input = pane.locator('[data-testid^="pdf-note-input-"]');
  await expect(input).toBeFocused();
  // 插入时只聚焦、不进选中态：改样式浮条要等第二次点它才出现（用户反馈 5）
  await expect(pane.getByTestId('pdf-selection-bar')).toHaveCount(0);
  await page.keyboard.type('复核数据来源');
  // 先确认这几个字真的进了输入框，再按 Escape 提交：Escape 提交的是**此刻**输入框里的值，
  // 打字与提交之间抢跑的话提交的就是空串（CI darwin-arm64 实测：边车里 text 落成 ""，
  // 而 annotations.length 照样是 1，所以只 poll 条数发现不了）。
  await expect(input).toHaveValue('复核数据来源');
  await page.keyboard.press('Escape');
  // 轮询的判据必须是**文本本身**，不是条数：落盘分两步——点一下先落一条空文字注（条数当场
  // 变成 1），文字是后面才写进去的。按条数轮询等于「刚创建就往下走」，然后读到 text: ""。
  // CI darwin-arm64 上稳定复现（本机那一步快到看不见）。
  await expect
    .poll(async () => ((await readSidecar(NOTE_REL))?.annotations[0] as { text?: string } | undefined)?.text ?? null)
    .toBe('复核数据来源');
  await expect.poll(async () => (await readSidecar(NOTE_REL))?.annotations.length ?? 0).toBe(1);
  const n = (await readSidecar(NOTE_REL))!.annotations[0] as { type: string; text: string; page: number };
  expect(n).toMatchObject({ type: 'note', text: '复核数据来源', page: 1 });
  // 上面「插入时不进选中态」那条的正向对照：第二次点它，同一个 testid 的浮条就出来。
  await pane.locator('[data-testid^="pdf-note-"]').first().click({ position: { x: 10, y: 5 } });
  await expect(pane.getByTestId('pdf-selection-bar')).toBeVisible();

  // 关 tab 再开：标注桶随 tab 一起丢掉，重开时从盘上的边车读回来
  const tab = page.getByTestId(`tab-${pdfPath}`);
  await tab.hover();
  await page.getByTestId(`tab-close-${pdfPath}`).click();
  await expect(tab).toHaveCount(0);
  pane = await openPdf(page, pdfPath);
  await expect(pane.locator('[data-testid^="pdf-note-input-"]')).toHaveValue('复核数据来源');
});

test('55-pdf-annotations: 文字注选中后左侧把手挪位置、右缘把手改宽度', async () => {
  const { page } = launched;
  const pane = await openPdf(page, at(MOVE_REL));
  const layer = pane.getByTestId('pdf-annotation-layer-1');
  const box = (await layer.boundingBox())!;
  const sx = box.width / 300;
  const sy = box.height / 400;

  await pane.getByTestId('pdf-tool-note').click();
  await page.mouse.click(box.x + 100 * sx, box.y + 250 * sy);
  await page.keyboard.type('挪我');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await readSidecar(MOVE_REL))?.annotations.length ?? 0).toBe(1);
  const before = (await readSidecar(MOVE_REL))!.annotations[0] as { x: number; y: number; text: string };

  // 选中（第二次点它）→ 虚线框与左侧把手出现 → 按住把手拖（把手在左边：上方是浮条的位置）
  await pane.locator('[data-testid^="pdf-note-"]').first().click({ position: { x: 10, y: 5 } });
  const grip = pane.locator('[data-testid^="pdf-note-grip-"]');
  await expect(grip).toBeVisible();
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 60 * sx, g.y + g.height / 2 + 40 * sy, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => {
    const n = (await readSidecar(MOVE_REL))!.annotations[0] as { x: number };
    return Math.round(n.x - before.x);
  }).toBeGreaterThan(50);
  const after = (await readSidecar(MOVE_REL))!.annotations[0] as { x: number; y: number; width: number; text: string };
  expect(Math.abs(after.x - before.x - 60)).toBeLessThan(4);
  expect(Math.abs(after.y - before.y - 40)).toBeLessThan(4);
  expect(after.text).toBe('挪我');   // 拖动不该动到正文

  // 右缘把手改宽度：只动 width，位置与正文不变
  const handle = pane.locator('[data-testid^="pdf-note-resize-"]');
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 50 * sx, h.y + h.height / 2, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => {
    const n = (await readSidecar(MOVE_REL))!.annotations[0] as { width: number };
    return Math.round(after.width - n.width);
  }).toBeGreaterThan(40);
  const resized = (await readSidecar(MOVE_REL))!.annotations[0] as { x: number; y: number; width: number; text: string };
  expect(Math.abs(after.width - resized.width - 50)).toBeLessThan(4);
  expect(resized.x).toBeCloseTo(after.x, 1);
  expect(resized.text).toBe('挪我');
});

test('55-pdf-annotations: 150% 缩放下坐标一致，顶替后标注仍在，读数更新', async () => {
  const { page } = launched;
  const pdfPath = at(ZOOM_REL);
  const pane = await openPdf(page, pdfPath);
  const layer = pane.getByTestId('pdf-annotation-layer-1');
  const before = (await layer.boundingBox())!;
  await pane.getByTestId('pdf-tool-highlight').click();
  await drawStroke(page, layer, 45, LINE1_Y, 200, LINE1_Y);
  await expect.poll(async () => (await readSidecar(ZOOM_REL))?.annotations.length ?? 0).toBe(1);

  // 等顶替真的发生过（COMMIT_DELAY 200 ms 后在后台画 1.5× 的新层，画完顶掉旧层）。判据是 stable
  // 层身上的 data-pdf-promote-reason：属性只在 promote() 里写上，提交前与新层还在画时都没有它
  // ——只数 [data-pdf-layer] 为 1 分不出「还没开始提交」与「已经顶替完」，两头都是一层。
  // 前提是这份文档此前从没顶替过，先把它钉住（正向是下面缩放之后那条）。
  const stable = pane.locator('[data-pdf-layer="stable"]');
  await expect(stable).not.toHaveAttribute('data-pdf-promote-reason');

  await pinch(page, pdfPath, (1 - 1.5) / wheelZoomSensitivity(process.platform));
  await expect(pane.getByTestId('pdf-readout')).toContainText('150%');
  // 走条件顶替还是 PROMOTE_TIMEOUT 兜底这里不分（那是 56 的事），所以两个值都收；等待上限盖过
  // 4 s 的兜底计时器。
  await expect(stable)
    .toHaveAttribute('data-pdf-promote-reason', /^(condition|timeout)$/, { timeout: 10_000 });
  await expect(pane.locator('[data-pdf-layer]')).toHaveCount(1);
  // 待实测 2：zoom 容器内 boundingClientRect 是缩放后的尺寸
  const after = (await layer.boundingBox())!;
  expect(Math.abs(after.width / before.width - 1.5)).toBeLessThan(0.03);
  // 待实测 5：顶替后覆盖层仍在、第一笔仍在
  await expect(pane.locator('[data-testid^="pdf-highlight-"]')).toHaveCount(1);

  await drawStroke(page, layer, 45, LINE1_Y, 200, LINE1_Y);
  await expect.poll(async () => (await readSidecar(ZOOM_REL))?.annotations.length ?? 0).toBe(2);
  const [a, b] = (await readSidecar(ZOOM_REL))!.annotations as Array<{ segments: Array<{ kind: string; y: number; x1: number; x2: number }> }>;
  expect(Math.abs(a.segments[0].y - b.segments[0].y)).toBeLessThan(2);
  expect(Math.abs(a.segments[0].x1 - b.segments[0].x1)).toBeLessThan(2);
  expect(Math.abs(a.segments[0].x2 - b.segments[0].x2)).toBeLessThan(2);
  await expect(pane.getByTestId('pdf-readout')).toContainText('1 / 1');
});

test('55-pdf-annotations: 坏 JSON 边车 → 工具置灰、提示可见、文件一字不动', async () => {
  const { page } = launched;
  const pane = await openPdf(page, at(BROKEN_REL));
  await expect(pane.getByTestId('pdf-tool-highlight')).toBeDisabled();
  await expect(pane.getByTestId('pdf-tool-note')).toBeDisabled();
  await expect(pane.getByTestId('pdf-notice')).toContainText('标注文件无法读取');
  // 读失败的桶不写盘由 saveScheduler.test.ts 的「loadError 的桶不写」守；这里核对的是端到端
  // 打开之后，盘上那份坏文件还是原来的字节，没被「修好」也没被清空。
  expect(await fs.readFile(at(sidecarRel(BROKEN_REL)), 'utf8')).toBe('{broken');
});
