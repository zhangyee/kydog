import { describe, it, expect } from 'vitest';
import { sidecarPath, emptyAnnotations } from './pdfSidecar';

describe('sidecarPath', () => {
  it('同目录、点号开头、同名加 .json', () => {
    expect(sidecarPath('/p/papers/paper.pdf', 'annotations')).toBe('/p/papers/.paper.pdf.json');
  });
  it('译文用 .zh.json', () => {
    expect(sidecarPath('/p/papers/paper.pdf', 'zh')).toBe('/p/papers/.paper.pdf.zh.json');
  });
  it('Windows 反斜杠原样保留', () => {
    expect(sidecarPath('C:\\p\\paper.pdf', 'annotations')).toBe('C:\\p\\.paper.pdf.json');
  });
  it('文件名本身带多个点', () => {
    expect(sidecarPath('/p/a.b.pdf', 'annotations')).toBe('/p/.a.b.pdf.json');
  });
  it('没有目录部分', () => {
    expect(sidecarPath('paper.pdf', 'annotations')).toBe('.paper.pdf.json');
  });
  it('emptyAnnotations 带 basename', () => {
    expect(emptyAnnotations('/p/paper.pdf')).toEqual({ version: 1, pdf: 'paper.pdf', annotations: [] });
  });
});
