import { describe, it, expect } from 'vitest';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pdfAnnotations } from './pdfAnnotations';
import type { PdfAnnotationsFile } from '../../shared/pdfSidecar';

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), 'kydog-pdfann-')); }

const DOC: PdfAnnotationsFile = {
  version: 1, pdf: 'paper.pdf',
  annotations: [{ id: 'h1', type: 'highlight', page: 1, color: 'amber', width: 2,
    segments: [{ kind: 'line', y: 53, x1: 40, x2: 200, text: 'Cited passage' }], createdAt: '2026-09-03T00:00:00Z' }],
};

describe('pdfAnnotations', () => {
  it('边车不存在 → doc 为 null', async () => {
    const dir = tmp();
    expect(await pdfAnnotations.load({ pdfPath: path.join(dir, 'paper.pdf') })).toEqual({ doc: null });
  });

  it('save 后 load 往返一致，文件名点号开头', async () => {
    const dir = tmp();
    const pdfPath = path.join(dir, 'paper.pdf');
    await pdfAnnotations.save({ pdfPath, doc: DOC });
    expect(await fs.readdir(dir)).toEqual(['.paper.pdf.json']);
    expect(await pdfAnnotations.load({ pdfPath })).toEqual({ doc: DOC });
  });

  it('save 不残留临时文件', async () => {
    const dir = tmp();
    await pdfAnnotations.save({ pdfPath: path.join(dir, 'paper.pdf'), doc: DOC });
    const names = await fs.readdir(dir);
    expect(names.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('坏 JSON 抛 pdf.annotations_invalid', async () => {
    const dir = tmp();
    await fs.writeFile(path.join(dir, '.paper.pdf.json'), '{broken');
    await expect(pdfAnnotations.load({ pdfPath: path.join(dir, 'paper.pdf') }))
      .rejects.toMatchObject({ code: 'pdf.annotations_invalid' });
  });

  it('version 不是 1 抛 pdf.annotations_invalid，message 带版本号', async () => {
    const dir = tmp();
    await fs.writeFile(path.join(dir, '.paper.pdf.json'), JSON.stringify({ ...DOC, version: 2 }));
    await expect(pdfAnnotations.load({ pdfPath: path.join(dir, 'paper.pdf') }))
      .rejects.toMatchObject({ code: 'pdf.annotations_invalid', message: expect.stringContaining('2') });
  });

  it('annotations 不是数组抛 pdf.annotations_invalid', async () => {
    const dir = tmp();
    await fs.writeFile(path.join(dir, '.paper.pdf.json'), JSON.stringify({ version: 1, pdf: 'x', annotations: {} }));
    await expect(pdfAnnotations.load({ pdfPath: path.join(dir, 'paper.pdf') }))
      .rejects.toMatchObject({ code: 'pdf.annotations_invalid' });
  });

  it('边车是目录 → fs.read_failed 而不是 null', async () => {
    const dir = tmp();
    await fs.mkdir(path.join(dir, '.paper.pdf.json'));
    await expect(pdfAnnotations.load({ pdfPath: path.join(dir, 'paper.pdf') }))
      .rejects.toMatchObject({ code: 'fs.read_failed' });
  });
});
