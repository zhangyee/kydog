import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

// pdfRaster.ts 在模块加载期就 import electron（离屏窗口那半边要用），node 测试环境里
// 没有真 electron，给一个够用的替身。被测的 validateRenderArgs 一点都不碰它。
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: class {},
}));

const { validateRenderArgs } = await import('./pdfRaster');

describe('validateRenderArgs', () => {
  it('页码必须是 >=1 的整数', () => {
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: 0 })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: -1 })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: 1.5 })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: NaN })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: 1 })).not.toThrow();
  });

  it('页码有上限，挡住 page: 1e9 这种把整本书当一页要的调用', () => {
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: 1_000_000_000 })).toThrow();
  });

  it('只接受 .pdf', () => {
    expect(() => validateRenderArgs({ path: '/a/b.png', page: 1 })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/b', page: 1 })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/B.PDF', page: 1 })).not.toThrow();
  });

  it('scale 限制在 1–4', () => {
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: 1, scale: 0.5 })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: 1, scale: 8 })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: 1, scale: NaN })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: 1, scale: 1 })).not.toThrow();
    expect(() => validateRenderArgs({ path: '/a/b.pdf', page: 1, scale: 4 })).not.toThrow();
  });

  it('scale 省略时给默认值 2，page 原样带出', () => {
    expect(validateRenderArgs({ path: '/a/b.pdf', page: 3 })).toEqual({
      path: '/a/b.pdf', page: 3, scale: 2,
    });
  });

  it('路径必须是绝对路径', () => {
    expect(() => validateRenderArgs({ path: 'figs/arch.pdf', page: 1 })).toThrow();
    expect(() => validateRenderArgs({ path: './arch.pdf', page: 1 })).toThrow();
    expect(() => validateRenderArgs({ path: '', page: 1 })).toThrow();
  });

  it('挡住 .. 段与 NUL —— 论文附件的文件名是外部输入，别让它拼出别处的路径', () => {
    expect(() => validateRenderArgs({ path: '/a/../../etc/x.pdf', page: 1 })).toThrow();
    expect(() => validateRenderArgs({ path: '/a/b\0.pdf', page: 1 })).toThrow();
  });

  it('路径里多余的分隔符会被归一化掉，但仍是同一个文件', () => {
    expect(validateRenderArgs({ path: '/a//b/./c.pdf', page: 1 }).path).toBe(path.normalize('/a/b/c.pdf'));
  });

  it('参数整体不是对象也要挡住', () => {
    expect(() => validateRenderArgs(null as never)).toThrow();
    expect(() => validateRenderArgs({ path: 42 as never as string, page: 1 })).toThrow();
  });
});

describe('pngOutputPath', () => {
  it('落在 PDF 同目录，文件名是 <原名>-p<页码>.png', async () => {
    const { pngOutputPath } = await import('./pdfRaster');
    expect(pngOutputPath(path.normalize('/papers/figs/architecture.pdf'), 3))
      .toBe(path.normalize('/papers/figs/architecture-p3.png'));
  });
});
