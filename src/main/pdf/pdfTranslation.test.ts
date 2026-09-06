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

describe('pdfTranslation.save', () => {
  it('写出的边车能被 load 原样读回', async () => {
    const dir = tmp();
    const pdf = path.join(dir, 'p.pdf');
    const doc: TranslatedDoc = {
      version: 1, pdf: 'p.pdf', lang: { in: 'auto', out: 'zh' },
      source: { sha256: 'ab', bytes: 12 },
      blocks: [{ id: 'p1-b01', page: 1, x: 1, y: 2, width: 3, height: 4, fontSize: 10, kind: 'text', source: 'a', target: 'A' }],
    };
    await pdfTranslation.save({ pdfPath: pdf, doc });
    expect((await pdfTranslation.load({ pdfPath: pdf })).doc).toEqual(doc);
  });

  it('非法 doc 被拒，且不落盘——写盘方自己校验，不信任调用方', async () => {
    const dir = tmp();
    const pdf = path.join(dir, 'p.pdf');
    const bad = { version: 1, pdf: 'p.pdf', lang: { in: 'auto', out: 'zh' }, blocks: [{ id: '' }] } as unknown as TranslatedDoc;
    await expect(pdfTranslation.save({ pdfPath: pdf, doc: bad }))
      .rejects.toThrow(expect.objectContaining({ code: 'pdf.translation_invalid' }));
    expect((await pdfTranslation.load({ pdfPath: pdf })).doc).toBeNull();
  });
});

describe('pdfTranslation.delete', () => {
  it('删掉边车，之后 load 回 null', async () => {
    const dir = tmp();
    const pdfPath = path.join(dir, 'paper.pdf');
    await fs.writeFile(path.join(dir, '.paper.pdf.zh.json'), JSON.stringify(DOC));
    await pdfTranslation.delete({ pdfPath });
    expect(await pdfTranslation.load({ pdfPath })).toEqual({ doc: null });
  });
  it('边车不存在 → 也 resolve（幂等）', async () => {
    const dir = tmp();
    await expect(pdfTranslation.delete({ pdfPath: path.join(dir, 'paper.pdf') })).resolves.toBeUndefined();
  });
  it('路径由 sidecarPath 推导：不动同目录里别的文件', async () => {
    const dir = tmp();
    await fs.writeFile(path.join(dir, '.paper.pdf.json'), '{}');   // 标注边车
    await pdfTranslation.delete({ pdfPath: path.join(dir, 'paper.pdf') });
    expect(await fs.stat(path.join(dir, '.paper.pdf.json')).then(() => true, () => false)).toBe(true);
  });
});
