import { describe, it, expect } from 'vitest';
import { DEFAULT_MD_EXPORT, defaultPdfPath, sanitizeMdExport } from './mdExport';

describe('sanitizeMdExport', () => {
  it('合法值原样；逐项回默认；整体不是对象也回默认', () => {
    // 正向：三个字段都取非默认值，证明不是「一律吐默认」
    expect(sanitizeMdExport({ paper: 'letter', margin: 'narrow', pageNumbers: false }))
      .toEqual({ paper: 'letter', margin: 'narrow', pageNumbers: false });
    // 逐项：只坏一个字段，别的保留
    expect(sanitizeMdExport({ paper: 'a3', margin: 'narrow', pageNumbers: false }))
      .toEqual({ paper: 'a4', margin: 'narrow', pageNumbers: false });
    expect(sanitizeMdExport({ paper: 'letter', margin: 'wide', pageNumbers: false }))
      .toEqual({ paper: 'letter', margin: 'standard', pageNumbers: false });
    expect(sanitizeMdExport({ paper: 'letter', margin: 'narrow', pageNumbers: 'yes' }))
      .toEqual({ paper: 'letter', margin: 'narrow', pageNumbers: true });
    for (const bad of [undefined, null, 'a4', 42, []]) {
      expect(sanitizeMdExport(bad), String(bad)).toEqual(DEFAULT_MD_EXPORT);
    }
  });

  it('默认值是 A4 / 标准 / 页码开（spec §1.6）', () => {
    expect(DEFAULT_MD_EXPORT).toEqual({ paper: 'a4', margin: 'standard', pageNumbers: true });
  });

  it('返回的是新对象，改它不会改到 DEFAULT_MD_EXPORT', () => {
    const got = sanitizeMdExport(undefined);
    got.paper = 'letter';
    expect(DEFAULT_MD_EXPORT.paper).toBe('a4');
  });
});

describe('defaultPdfPath', () => {
  it('.md / .MD / .markdown 换成 .pdf；没有这两种扩展名就直接加', () => {
    expect(defaultPdfPath('/p/ch3.md')).toBe('/p/ch3.pdf');
    expect(defaultPdfPath('/p/ch3.MD')).toBe('/p/ch3.pdf');
    expect(defaultPdfPath('/p/notes.Markdown')).toBe('/p/notes.pdf');
    expect(defaultPdfPath('/p/README')).toBe('/p/README.pdf');
    expect(defaultPdfPath('/p/a.txt')).toBe('/p/a.txt.pdf');
    // 目录名带点不受影响：只看最后的扩展名
    expect(defaultPdfPath('/p/v1.md/notes')).toBe('/p/v1.md/notes.pdf');
    expect(defaultPdfPath('C:\\Users\\y\\ch3.md')).toBe('C:\\Users\\y\\ch3.pdf');
  });
});
