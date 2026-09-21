import { describe, it, expect } from 'vitest';
import { classifyFile, toMessagePath, isInsideProject, parentDirOf, fitWithin, base64Length } from './attachments';

describe('classifyFile —— 「有没有路径 × 是不是可发图片」四格', () => {
  it('四格各就各位', () => {
    expect(classifyFile('image/png', '/p/a.png')).toEqual({ kind: 'image', path: '/p/a.png' });
    expect(classifyFile('image/png', '')).toEqual({ kind: 'image', path: null });
    expect(classifyFile('application/pdf', '/p/a.pdf')).toEqual({ kind: 'file', path: '/p/a.pdf' });
    expect(classifyFile('application/pdf', '')).toEqual({ kind: 'reject' });
  });
  it('模型不收的图片格式与文件夹按文件处理', () => {
    expect(classifyFile('image/heic', '/p/a.heic')).toEqual({ kind: 'file', path: '/p/a.heic' });
    expect(classifyFile('image/svg+xml', '/p/a.svg')).toEqual({ kind: 'file', path: '/p/a.svg' });
    expect(classifyFile('', '/p/folder')).toEqual({ kind: 'file', path: '/p/folder' });
    for (const t of ['image/jpeg', 'image/gif', 'image/webp']) expect(classifyFile(t, '').kind).toBe('image');
  });
});

describe('toMessagePath —— 相对目标对话的项目', () => {
  it('项目内给相对路径（/ 分隔），项目外原样给绝对路径', () => {
    expect(toMessagePath('/proj/refs/a.pdf', '/proj')).toBe('refs/a.pdf');
    expect(toMessagePath('/proj/refs/a.pdf', '/proj/')).toBe('refs/a.pdf');
    expect(toMessagePath('/Users/yee/Downloads/a.pdf', '/proj')).toBe('/Users/yee/Downloads/a.pdf');
    expect(toMessagePath('/project2/a.pdf', '/proj')).toBe('/project2/a.pdf');
    expect(toMessagePath('C:\\proj\\refs\\a.pdf', 'C:\\proj')).toBe('refs/a.pdf');
    expect(toMessagePath('/proj', '/proj')).toBe('/proj');
    expect(toMessagePath('/proj/a.pdf', '')).toBe('/proj/a.pdf');
  });
  it('isInsideProject 与 toMessagePath 同一个判据', () => {
    expect(isInsideProject('/proj/a.md', '/proj')).toBe(true);
    expect(isInsideProject('/elsewhere/a.md', '/proj')).toBe(false);
  });
  it('parentDirOf', () => {
    expect(parentDirOf('/Users/yee/Downloads/a.pdf')).toBe('/Users/yee/Downloads');
    expect(parentDirOf('C:\\Users\\yee\\a.pdf')).toBe('C:\\Users\\yee');
    expect(parentDirOf('/a.pdf')).toBe('/');
  });
});

describe('图片尺寸', () => {
  it('fitWithin：不超就不动，超了按长边等比缩到 2000', () => {
    expect(fitWithin(1920, 1080)).toEqual({ width: 1920, height: 1080, scaled: false });
    expect(fitWithin(4000, 3000)).toEqual({ width: 2000, height: 1500, scaled: true });
    expect(fitWithin(1000, 5000)).toEqual({ width: 400, height: 2000, scaled: true });
    expect(fitWithin(100000, 1).height).toBe(1);
  });
  it('base64Length', () => {
    expect(base64Length(0)).toBe(0);
    expect(base64Length(1)).toBe(4);
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
  });
});
