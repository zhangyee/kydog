import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown } from './helpers';

const PDF_REL = 'figure.pdf';

// 最小单页 PDF：无 xref，pdf.js 走 recovery 模式解析对象 → numPages=1，MediaBox 300x400
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

/** 从 PNG 的 IHDR 里读宽高：magic(8) + 长度(4) + 'IHDR'(4) 之后就是两个 big-endian u32。 */
function readPngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('47-pdf-raster: pdf.renderPage 真的画出一张 PNG', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, app, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);

    const result = await page.evaluate(
      async (p) => await window.kydog.invoke('pdf.renderPage', { path: p, page: 1, scale: 2 }),
      pdfPath,
    );

    const expected = path.join(kydogHome, 'proj', 'figure-p1.png');
    expect(result.pngPath).toBe(expected);

    // 「返回了一个路径」什么都证明不了 —— 真去读那个文件的字节。
    const buf = await fs.readFile(expected);
    expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(buf.length).toBeGreaterThan(1024);
    // MediaBox 300x400 按 scale 2 渲染 → 600x800。尺寸对得上才说明画的是这一页。
    expect(readPngSize(buf)).toEqual({ width: 600, height: 800 });

    // 再转一次，换个倍率 —— 顺带证明 scale 真的作用在输出尺寸上。
    await page.evaluate(
      async (p) => await window.kydog.invoke('pdf.renderPage', { path: p, page: 1, scale: 3 }),
      pdfPath,
    );
    const buf3 = await fs.readFile(expected);
    expect(readPngSize(buf3)).toEqual({ width: 900, height: 1200 });

    // 渲染窗口用完即毁：连转两张之后，活着的只剩主窗口。
    const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(windowCount).toBe(1);
  } finally {
    await teardown(launched);
  }
});

test('47-pdf-raster: 非法参数在渲染之前就被挡下', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const pdfPath = path.join(kydogHome, 'proj', PDF_REL);

    const errors = await page.evaluate(async (p) => {
      const attempts: Array<Record<string, unknown>> = [
        { path: p, page: 0 },
        { path: p, page: 1, scale: 8 },
        { path: p.replace(/\.pdf$/, '.png'), page: 1 },
        { path: 'figure.pdf', page: 1 },
      ];
      const out: string[] = [];
      for (const args of attempts) {
        try {
          await window.kydog.invoke('pdf.renderPage', args as never);
          out.push('NO_ERROR');
        } catch (err) {
          out.push((err as Error).message);
        }
      }
      return out;
    }, pdfPath);

    expect(errors).toHaveLength(4);
    for (const e of errors) expect(e).not.toBe('NO_ERROR');

    // 被挡下就不该有任何产物落盘
    const files = await fs.readdir(path.join(kydogHome, 'proj'));
    expect(files.filter((f) => f.endsWith('.png'))).toEqual([]);
  } finally {
    await teardown(launched);
  }
});
