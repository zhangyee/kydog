import { describe, it, expect } from 'vitest';
import { isMarkdownPath, isPdfPath, fileTitle } from './fileTabHelpers';

describe('isMarkdownPath', () => {
  it('.md / .markdown 命中（大小写不敏感）', () => {
    expect(isMarkdownPath('/a/b/notes.md')).toBe(true);
    expect(isMarkdownPath('/a/b/README.MARKDOWN')).toBe(true);
  });
  it('其他扩展名不命中', () => {
    expect(isMarkdownPath('/a/b/x.ts')).toBe(false);
    expect(isMarkdownPath('/a/b/x.txt')).toBe(false);
    expect(isMarkdownPath('/a/b/mdfile')).toBe(false);
  });
});

describe('isPdfPath', () => {
  it('.pdf 命中（大小写不敏感）', () => {
    expect(isPdfPath('/a/b.pdf')).toBe(true);
    expect(isPdfPath('/a/b.PDF')).toBe(true);
    expect(isPdfPath('/a/paper.final.pdf')).toBe(true);
  });
  it('其他扩展名不命中', () => {
    expect(isPdfPath('/a/b.md')).toBe(false);
    expect(isPdfPath('/a/notpdf')).toBe(false);
  });
});

describe('fileTitle', () => {
  it('取 POSIX 路径 basename', () => {
    expect(fileTitle('/a/b/notes.md')).toBe('notes.md');
  });
  it('取 Windows 路径 basename', () => {
    expect(fileTitle('C:\\docs\\notes.md')).toBe('notes.md');
  });
});
