import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../settings/settingsService', () => ({ settingsService: { get: async () => ({ ui: { readingFontSize: 'medium' } }) } }));

const { validateExportArgs } = await import('./mdPdfExport');

const good = { mdPath: '/p/a.md', markdown: '# x', outPath: '/p/a.pdf', options: { paper: 'a4', margin: 'standard', pageNumbers: true } };

describe('validateExportArgs', () => {
  it('合法参数原样通过', () => {
    expect(validateExportArgs(good)).toEqual(good);
  });
  it('路径必须是非空绝对路径、不含 NUL', () => {
    for (const k of ['mdPath', 'outPath'] as const) {
      for (const bad of ['', 'a.pdf', '/p/a\0.pdf', 42]) {
        expect(() => validateExportArgs({ ...good, [k]: bad }), `${k}=${String(bad)}`).toThrow();
      }
    }
  });
  it('markdown 必须是字符串（空串可以：导出一页空白）', () => {
    expect(validateExportArgs({ ...good, markdown: '' }).markdown).toBe('');
    expect(() => validateExportArgs({ ...good, markdown: null })).toThrow();
  });
  it('options 取值不认识就拒绝（不是悄悄换成默认值）', () => {
    expect(() => validateExportArgs({ ...good, options: { ...good.options, paper: 'a3' } })).toThrow();
    expect(() => validateExportArgs({ ...good, options: { ...good.options, pageNumbers: 'yes' } })).toThrow();
    expect(() => validateExportArgs({ ...good, options: undefined })).toThrow();
  });
  it('整体不是对象也拒绝', () => {
    for (const bad of [null, undefined, 'x', []]) expect(() => validateExportArgs(bad), String(bad)).toThrow();
  });
});
