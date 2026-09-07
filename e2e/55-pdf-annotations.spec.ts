import { test, expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector, type LaunchedApp } from './helpers';
import { buildTextPdf } from './fixtures/textPdf';

const PDF_REL = 'paper.pdf';
const SIDECAR_REL = '.paper.pdf.json';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
// fixture 是 300 × 400 pt（见 e2e/fixtures/textPdf.ts）；第一行字身框视口 [46, 60]，
// 行中线取基线上方 1/4 字高 = 56.5（记号笔该压的位置，不是字身框正中），第二行同理 96.5。
const LINE1_Y = 56.5;

async function seedAll(home: string, sidecar?: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, PDF_REL), buildTextPdf());
  if (sidecar !== undefined) await fs.writeFile(path.join(projectPath, SIDECAR_REL), sidecar);
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

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

async function readSidecar(home: string): Promise<{ annotations: Array<Record<string, unknown>> } | null> {
  try { return JSON.parse(await fs.readFile(path.join(home, 'proj', SIDECAR_REL), 'utf8')); }
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
  const launched = await launchKydog({ seed: (h) => seedAll(h) });
  const errors: string[] = [];
  launched.page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const pane = await openPdf(page, pdfPath);
    await pane.getByTestId('pdf-tool-highlight').click();
    await expect(pane.getByTestId('pdf-tool-card-highlight')).toBeVisible();
    await drawStroke(page, pane.getByTestId('pdf-annotation-layer-1'), 45, LINE1_Y, 200, LINE1_Y + 1);

    await expect.poll(async () => (await readSidecar(kydogHome))?.annotations.length ?? 0).toBe(1);
    const doc = (await readSidecar(kydogHome))!;
    const h = doc.annotations[0] as { type: string; color: string; width: number; segments: Array<{ kind: string; y: number; text?: string }> };
    expect(h).toMatchObject({ type: 'highlight', color: 'amber', width: 2 });
    // 一行上的一笔就是一条直线：不许因为采样抖动碎成几段（用户反馈 2）
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].kind).toBe('line');
    expect(Math.abs(h.segments[0].y - LINE1_Y)).toBeLessThan(3);
    expect(h.segments[0].text).toContain('passage');
    await expect(pane.locator('[data-testid^="pdf-highlight-"]')).toHaveCount(1);
    // 落笔即收起参数卡片（用户反馈 3）
    await expect(pane.getByTestId('pdf-tool-card-highlight')).toHaveCount(0);
    // 待实测 3：截图人工看一次——amber 笔画呈半透明暖黄，文字仍可读
    await page.screenshot({ path: 'test-results/pdf-annotations-highlight.png' });
    expect(errors).toEqual([]);
  } finally {
    await teardown(launched);
  }
});

test('55-pdf-annotations: 文字注落盘，关 tab 重开与重启后还原', async () => {
  let launched: LaunchedApp = await launchKydog({ seed: (h) => seedAll(h) });
  const kydogHome = launched.kydogHome;
  const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
  try {
    const { page } = launched;
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
    await expect.poll(async () => (await readSidecar(kydogHome))?.annotations.length ?? 0).toBe(1);
    const n = (await readSidecar(kydogHome))!.annotations[0] as { type: string; text: string; page: number };
    expect(n).toMatchObject({ type: 'note', text: '复核数据来源', page: 1 });

    // 关 tab 再开
    const tab = page.getByTestId(`tab-${pdfPath}`);
    await tab.hover();
    await page.getByTestId(`tab-close-${pdfPath}`).click();
    await expect(tab).toHaveCount(0);
    pane = await openPdf(page, pdfPath);
    await expect(pane.locator('[data-testid^="pdf-note-input-"]')).toHaveValue('复核数据来源');

    // 重启
    await teardown(launched);
    launched = await launchKydog({ kydogHome });
    pane = await openPdf(launched.page, pdfPath);
    await expect(pane.locator('[data-testid^="pdf-note-input-"]')).toHaveValue('复核数据来源');
  } finally {
    await teardown(launched);
  }
});

test('55-pdf-annotations: 文字注选中后左侧把手挪位置、右缘把手改宽度', async () => {
  const launched = await launchKydog({ seed: (h) => seedAll(h) });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const pane = await openPdf(page, pdfPath);
    const layer = pane.getByTestId('pdf-annotation-layer-1');
    const box = (await layer.boundingBox())!;
    const sx = box.width / 300;
    const sy = box.height / 400;

    await pane.getByTestId('pdf-tool-note').click();
    await page.mouse.click(box.x + 100 * sx, box.y + 250 * sy);
    await page.keyboard.type('挪我');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await readSidecar(kydogHome))?.annotations.length ?? 0).toBe(1);
    const before = (await readSidecar(kydogHome))!.annotations[0] as { x: number; y: number; text: string };

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
      const n = (await readSidecar(kydogHome))!.annotations[0] as { x: number };
      return Math.round(n.x - before.x);
    }).toBeGreaterThan(50);
    const after = (await readSidecar(kydogHome))!.annotations[0] as { x: number; y: number; width: number; text: string };
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
      const n = (await readSidecar(kydogHome))!.annotations[0] as { width: number };
      return Math.round(after.width - n.width);
    }).toBeGreaterThan(40);
    const resized = (await readSidecar(kydogHome))!.annotations[0] as { x: number; y: number; width: number; text: string };
    expect(Math.abs(after.width - resized.width - 50)).toBeLessThan(4);
    expect(resized.x).toBeCloseTo(after.x, 1);
    expect(resized.text).toBe('挪我');
  } finally {
    await teardown(launched);
  }
});

test('55-pdf-annotations: 只打开不编辑 → 关掉 tab 也不生成边车文件', async () => {
  const launched = await launchKydog({ seed: (h) => seedAll(h) });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    await openPdf(page, pdfPath);

    const tab = page.getByTestId(`tab-${pdfPath}`);
    await tab.hover();
    await page.getByTestId(`tab-close-${pdfPath}`).click();
    await expect(tab).toHaveCount(0);

    // 关 tab 会 flush 一次；给它足够时间落盘，然后确认论文旁边什么都没多出来（用户反馈 6）
    await page.waitForTimeout(1000);
    expect(await readSidecar(kydogHome)).toBeNull();
    expect(await fs.readdir(path.join(kydogHome, 'proj'))).toEqual([PDF_REL]);
  } finally {
    await teardown(launched);
  }
});

test('55-pdf-annotations: ⌘Z 撤销、⇧⌘Z 重做、选中后 Delete 删除，边车同步', async () => {
  const launched = await launchKydog({ seed: (h) => seedAll(h) });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const pane = await openPdf(page, pdfPath);
    await pane.getByTestId('pdf-tool-highlight').click();
    await drawStroke(page, pane.getByTestId('pdf-annotation-layer-1'), 45, LINE1_Y, 200, LINE1_Y);
    await expect.poll(async () => (await readSidecar(kydogHome))?.annotations.length ?? 0).toBe(1);

    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(async () => (await readSidecar(kydogHome))?.annotations.length ?? -1).toBe(0);
    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect.poll(async () => (await readSidecar(kydogHome))?.annotations.length ?? 0).toBe(1);

    await page.keyboard.press('v');
    await pane.locator('[data-testid^="pdf-highlight-"] path').first().click({ force: true });
    await expect(pane.getByTestId('pdf-selection-bar')).toBeVisible();
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await readSidecar(kydogHome))?.annotations.length ?? -1).toBe(0);
    await expect(pane.getByTestId('pdf-selection-bar')).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('55-pdf-annotations: 坏 JSON 边车 → 工具置灰、提示可见、文件一字不动', async () => {
  const launched = await launchKydog({ seed: (h) => seedAll(h, '{broken') });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const pane = await openPdf(page, pdfPath);
    await expect(pane.getByTestId('pdf-tool-highlight')).toBeDisabled();
    await expect(pane.getByTestId('pdf-tool-note')).toBeDisabled();
    await expect(pane.getByTestId('pdf-notice')).toContainText('标注文件无法读取');
    // 先点进页面空白处让 wrapper 拿到焦点（focus 只在 onPointerDownCapture 里触发），
    // 不这样按键永远到不了 handleAnnotationKey，"文件一字不动"就测不出东西。
    await pane.getByTestId('pdf-annotation-layer-1').click({ position: { x: 150, y: 350 } });
    await page.keyboard.press('h');
    await page.waitForTimeout(1000);
    // 按键没能切到高亮笔工具：卡片只在「当前工具是非 select 的激活工具」时才渲染，
    // 有卡片就说明 'h' 生效切了工具——这比再查一遍已知禁用的按钮更能证明按键被吞掉了
    await expect(pane.getByTestId('pdf-tool-card-highlight')).toHaveCount(0);
    expect(await fs.readFile(path.join(kydogHome, 'proj', SIDECAR_REL), 'utf8')).toBe('{broken');
  } finally {
    await teardown(launched);
  }
});

test('55-pdf-annotations: 150% 缩放下坐标一致，顶替后标注仍在，读数更新', async () => {
  const launched = await launchKydog({ seed: (h) => seedAll(h) });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);
    const pane = await openPdf(page, pdfPath);
    const layer = pane.getByTestId('pdf-annotation-layer-1');
    const before = (await layer.boundingBox())!;
    await pane.getByTestId('pdf-tool-highlight').click();
    await drawStroke(page, layer, 45, LINE1_Y, 200, LINE1_Y);
    await expect.poll(async () => (await readSidecar(kydogHome))?.annotations.length ?? 0).toBe(1);

    await pinch(page, pdfPath, -66.67);
    await expect(pane.getByTestId('pdf-readout')).toContainText('150%');
    await page.waitForTimeout(800);   // COMMIT_DELAY 200 ms + 后台层渲染 + 顶替
    // 待实测 2：zoom 容器内 boundingClientRect 是缩放后的尺寸
    const after = (await layer.boundingBox())!;
    expect(Math.abs(after.width / before.width - 1.5)).toBeLessThan(0.03);
    // 待实测 5：顶替后覆盖层仍在、第一笔仍在
    await expect(pane.locator('[data-testid^="pdf-highlight-"]')).toHaveCount(1);

    await drawStroke(page, layer, 45, LINE1_Y, 200, LINE1_Y);
    await expect.poll(async () => (await readSidecar(kydogHome))?.annotations.length ?? 0).toBe(2);
    const [a, b] = (await readSidecar(kydogHome))!.annotations as Array<{ segments: Array<{ kind: string; y: number; x1: number; x2: number }> }>;
    expect(Math.abs(a.segments[0].y - b.segments[0].y)).toBeLessThan(2);
    expect(Math.abs(a.segments[0].x1 - b.segments[0].x1)).toBeLessThan(2);
    expect(Math.abs(a.segments[0].x2 - b.segments[0].x2)).toBeLessThan(2);
    await expect(pane.getByTestId('pdf-readout')).toContainText('1 / 1');
  } finally {
    await teardown(launched);
  }
});
