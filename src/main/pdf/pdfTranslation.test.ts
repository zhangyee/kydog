import { describe, it, expect } from 'vitest';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pdfTranslation } from './pdfTranslation';
import type { TranslatedDoc } from '../../shared/zhSidecar';

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), 'kydog-pdftr-')); }

const DOC: TranslatedDoc = {
  version: 1, pdf: 'paper.pdf', lang: { in: 'en', out: 'zh' },
  blocks: [{ id: 'p1-b01', page: 1, x: 72, y: 100, width: 451, height: 62, fontSize: 10, kind: 'text', source: 'hello', target: '你好' }],
};

describe('pdfTranslation', () => {
  it('边车不存在 → doc 为 null，不抛', async () => {
    const dir = tmp();
    expect(await pdfTranslation.load({ pdfPath: path.join(dir, 'paper.pdf') })).toEqual({ doc: null });
  });

  it('不是合法 JSON → 抛 pdf.translation_invalid', async () => {
    const dir = tmp();
    await fs.writeFile(path.join(dir, '.paper.pdf.zh.json'), '{broken');
    await expect(pdfTranslation.load({ pdfPath: path.join(dir, 'paper.pdf') }))
      .rejects.toMatchObject({ code: 'pdf.translation_invalid' });
  });

  it('合法边车 → 读回来', async () => {
    const dir = tmp();
    const pdfPath = path.join(dir, 'paper.pdf');
    await fs.writeFile(path.join(dir, '.paper.pdf.zh.json'), JSON.stringify(DOC));
    expect(await pdfTranslation.load({ pdfPath })).toEqual({ doc: DOC });
  });
});
