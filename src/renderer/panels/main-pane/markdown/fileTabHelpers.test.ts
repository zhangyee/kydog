import { describe, it, expect } from 'vitest';
import { isMarkdownPath, fileTitle } from './fileTabHelpers';

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

describe('fileTitle', () => {
  it('取 POSIX 路径 basename', () => {
    expect(fileTitle('/a/b/notes.md')).toBe('notes.md');
  });
  it('取 Windows 路径 basename', () => {
    expect(fileTitle('C:\\docs\\notes.md')).toBe('notes.md');
  });
});
