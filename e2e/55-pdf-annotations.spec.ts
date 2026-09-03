import { test, expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, type LaunchedApp } from './helpers';
import { buildTextPdf } from './fixtures/textPdf';

const PDF_REL = 'paper.pdf';
const SIDECAR_REL = '.paper.pdf.json';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
// fixture 是 300 × 400 pt；第一行正文视口 y ≈ 53，第二行 ≈ 93（见 e2e/fixtures/textPdf.ts）
const LINE1_Y = 53;

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
  }, { sel: `[data-testid="pdf-scroll-${pdfPath}"]`, deltaY });
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
    expect(h.segments[0].kind).toBe('line');
    expect(Math.abs(h.segments[0].y - LINE1_Y)).toBeLessThan(3);
    expect(h.segments[0].text).toContain('passage');
    await expect(pane.locator('[data-testid^="pdf-highlight-"]')).toHaveCount(1);
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
    await page.keyboard.type('复核数据来源');
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
    await page.keyboard.press('h');
    await page.waitForTimeout(1000);
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
