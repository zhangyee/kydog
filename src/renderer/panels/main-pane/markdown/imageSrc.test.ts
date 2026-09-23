import { describe, it, expect } from 'vitest';
import { resolveImageSrc } from './imageSrc';

describe('resolveImageSrc', () => {
  it('带 scheme 的原样：http / https / data / blob / file', () => {
    for (const s of ['https://x.org/a.png', 'http://x.org/a.png', 'data:image/png;base64,AAAA', 'blob:abc', 'file:///p/a.png']) {
      expect(resolveImageSrc(s, '/p/doc.md'), s).toBe(s);
    }
  });

  it('相对路径按 md 所在目录解析；.. 按 URL 语义上溯', () => {
    expect(resolveImageSrc('figs/a.png', '/p/sub/doc.md')).toBe('file:///p/sub/figs/a.png');
    expect(resolveImageSrc('./figs/a.png', '/p/sub/doc.md')).toBe('file:///p/sub/figs/a.png');
    expect(resolveImageSrc('../figs/a.png', '/p/sub/doc.md')).toBe('file:///p/figs/a.png');
  });

  it('空格、中文、# 与 ? 被正确编码（绝对与相对两条路）', () => {
    expect(resolveImageSrc('/p/图 1#a?.png', '/q/doc.md')).toBe('file:///p/%E5%9B%BE%201%23a%3F.png');
    expect(resolveImageSrc('图 1.png', '/p/我的 文档/doc.md')).toBe('file:///p/%E6%88%91%E7%9A%84%20%E6%96%87%E6%A1%A3/%E5%9B%BE%201.png');
  });

  it('POSIX 绝对路径与 Windows 盘符 / UNC', () => {
    expect(resolveImageSrc('/abs/a.png', '/p/doc.md')).toBe('file:///abs/a.png');
    expect(resolveImageSrc('C:\\Users\\y\\a.png', 'C:\\Users\\y\\doc.md')).toBe('file:///C:/Users/y/a.png');
    expect(resolveImageSrc('C:/Users/y/a.png', 'C:\\Users\\y\\doc.md')).toBe('file:///C:/Users/y/a.png');
    expect(resolveImageSrc('\\\\srv\\share\\a.png', 'C:\\d\\doc.md')).toBe('file://srv/share/a.png');
    // Windows 下的 md、相对图片
    expect(resolveImageSrc('figs\\a.png', 'C:\\Users\\y\\doc.md')).toBe('file:///C:/Users/y/figs/a.png');
  });

  it('空 src 原样（没有图可载，别编一个地址出来）', () => {
    expect(resolveImageSrc('', '/p/doc.md')).toBe('');
  });
});
