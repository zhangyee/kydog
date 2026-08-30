import { describe, it, expect, vi } from 'vitest';
import type { RenderPageArgs } from '../pdf/pdfRaster';
import { KydogError } from '../../shared/errors';
import { createReadPdfFigureTool, READ_PDF_FIGURE_TOOL_NAME, NO_VISION_NOTE } from './readPdfFigureTool';

const PDF = '/tmp/papers/2408.05178/figs/architecture.pdf';
const PNG = '/tmp/papers/2408.05178/figs/architecture-p1.png';

// 不写 as never：ctx 的形状就是 { model?: { input?: readonly string[] } }，
// 直接给字面量既能过类型，又能在下一个 Task 里用 toBe 断言透传的是同一份引用。
const NO_VISION = { model: { input: ['text'] } };

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
    // 校验先行之后，render 收到的是归一化过的参数：scale 默认补成 2。
    expect(render.mock.calls[0][0]).toEqual({ path: PDF, page: 1, scale: 2 });
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

  it('模型看不了图：不渲染，只返回哨兵，也不给 details', async () => {
    const render = fakeRender();
    const tool = createReadPdfFigureTool(render);
    const res = await tool.execute('tc1', { path: PDF }, undefined, undefined, NO_VISION);
    expect(render).not.toHaveBeenCalled();
    expect(res.content).toEqual([{ type: 'text', text: NO_VISION_NOTE }]);
    expect(res.details).toBeUndefined();
  });

  it('哨兵不许把参数校验吞掉：看不了图 + 非法路径，仍然抛 KydogError', async () => {
    const render = fakeRender();
    const tool = createReadPdfFigureTool(render);
    await expect(
      tool.execute('tc1', { path: '/tmp/papers/x.png' }, undefined, undefined, NO_VISION),
    ).rejects.toThrow(KydogError);
    expect(render).not.toHaveBeenCalled();
  });

  it('ctx 缺席时按「看得见图」走 —— 与 pi read 的默认一致', async () => {
    const render = fakeRender();
    const tool = createReadPdfFigureTool(render);
    const res = await tool.execute('tc1', { path: PDF }, undefined, undefined, undefined);
    expect(render).toHaveBeenCalledTimes(1);
    expect(res.details).toEqual({ pngPath: PNG });
  });
});
