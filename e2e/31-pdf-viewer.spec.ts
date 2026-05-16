import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown } from './helpers';

const PDF_REL = 'paper.pdf';

// 最小单页 PDF：无 xref，pdf.js 走 recovery 模式解析对象 → numPages=1
const MINIMAL_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
`;

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, PDF_REL), MINIMAL_PDF);
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

test('31-pdf-viewer: 双击打开 PDF tab → 渲染页面', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);

    // 选中 thread，Inspector 才显示该项目文件树
    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${pdfPath}"]`);
    await fsRow.waitFor();

    // 双击打开 PDF tab
    await fsRow.dblclick();
    await expect(page.locator(`[data-testid="tab-${pdfPath}"]`)).toBeVisible();

    // PDF 滚动容器出现，且页面 canvas 渲染出来
    const pane = page.locator(`[data-testid="file-pane-${pdfPath}"]`);
    await expect(pane.locator(`[data-testid="pdf-scroll-${pdfPath}"]`)).toBeVisible();
    await expect(pane.locator('canvas').first()).toBeVisible({ timeout: 10000 });

    // 未出现错误提示
    await expect(pane.getByText('无法打开文件')).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('31-pdf-viewer: 关闭 PDF tab 不弹未保存确认框', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${pdfPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const tab = page.locator(`[data-testid="tab-${pdfPath}"]`);
    await expect(tab).toBeVisible();

    // 关闭 tab —— 悬停后点关闭按钮
    await tab.hover();
    await page.locator(`[data-testid="tab-close-${pdfPath}"]`).click();

    // tab 直接消失，不弹未保存确认框
    await expect(tab).toHaveCount(0);
    await expect(page.locator('[data-testid="unsaved-modal"]')).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});
