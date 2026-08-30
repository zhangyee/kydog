import { describe, it, expect, vi } from 'vitest';
import type { RenderPageArgs } from '../pdf/pdfRaster';
import { createReadPdfFigureTool, READ_PDF_FIGURE_TOOL_NAME } from './readPdfFigureTool';

const PDF = '/tmp/papers/2408.05178/figs/architecture.pdf';
const PNG = '/tmp/papers/2408.05178/figs/architecture-p1.png';

// 假 render 必须写出参数类型：vi.fn(async () => …) 推出来是零参数元组，
// 后面 render.mock.calls[0][0] 会被 tsc 判成 TS2493（tsconfig 的 include 覆盖 src 下的测试）。
// pdfRaster 里 import 了 electron，所以这里只能 import type —— 类型在编译期擦除，不会真加载它。
const fakeRender = () => vi.fn(async (_args: RenderPageArgs, _signal?: AbortSignal) => ({ pngPath: PNG }));

describe('read_pdf_figure', () => {
  it('工具名是 read_pdf_figure', () => {
    const tool = createReadPdfFigureTool(fakeRender());
    expect(tool.name).toBe(READ_PDF_FIGURE_TOOL_NAME);
  });

  it('渲染成功时返回 PNG 路径，并把 page 的默认值补成 1', async () => {
    const render = fakeRender();
    const tool = createReadPdfFigureTool(render);
    const res = await tool.execute('tc1', { path: PDF }, undefined);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0]).toEqual({ path: PDF, page: 1, scale: undefined });
    expect(res.details).toEqual({ pngPath: PNG });
    expect(res.content[0]).toEqual({ type: 'text', text: `已渲染成 PNG：${PNG}` });
  });

  it('signal 透传给 render —— 用户中止这一轮时渲染要跟着停', async () => {
    const render = fakeRender();
    const tool = createReadPdfFigureTool(render);
    const ac = new AbortController();
    await tool.execute('tc1', { path: PDF }, ac.signal);
    expect(render.mock.calls[0][1]).toBe(ac.signal);
  });
});
