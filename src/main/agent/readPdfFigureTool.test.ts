import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import type { RenderPageArgs } from '../pdf/pdfRaster';
import { KydogError } from '../../shared/errors';
import {
  createReadPdfFigureTool, READ_PDF_FIGURE_TOOL_NAME, NO_VISION_NOTE, NO_IMAGE_NOTE,
} from './readPdfFigureTool';

const PDF = '/tmp/papers/2408.05178/figs/architecture.pdf';
const PNG = '/tmp/papers/2408.05178/figs/architecture-p1.png';

const VISION = { model: { input: ['text', 'image'] } };
const NO_VISION = { model: { input: ['text'] } };

type Content = { type: string; [k: string]: unknown };

/** pi read 读到一张真图时返回的形状（实测，见 spec §3.1）。 */
const WITH_IMAGE: Content[] = [
  { type: 'text', text: 'Read image file [image/png]' },
  { type: 'image', data: 'AAAA', mimeType: 'image/png' },
];
/** photon 挂掉时 pi read 返回的形状：只有文本，没有 image 块。 */
const WITHOUT_IMAGE: Content[] = [
  { type: 'text', text: 'Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]' },
];

// 两个假货都必须写出参数类型：vi.fn(async () => …) 推出来是零参数元组，
// 后面 mock.calls[0][n] 会被 tsc 判成 TS2493。
// 也不要用 as never 把注入处的类型检查关掉 —— 那正是这里要顺带验的东西。
function make(opts: { content?: Content[]; readThrows?: unknown } = {}) {
  const render = vi.fn(async (_args: RenderPageArgs, _signal?: AbortSignal) => ({ pngPath: PNG }));
  const readTool = {
    execute: vi.fn(async (
      _toolCallId: string,
      _params: { path: string },
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: unknown,
    ): Promise<{ content: Content[] }> => {
      if (opts.readThrows) throw opts.readThrows;
      return { content: opts.content ?? WITH_IMAGE };
    }),
  };
  const tool = createReadPdfFigureTool({ render, readTool });
  return { render, readTool, tool };
}

describe('read_pdf_figure', () => {
  it('工具名是 read_pdf_figure', () => {
    expect(make().tool.name).toBe(READ_PDF_FIGURE_TOOL_NAME);
  });

  it('看得见图：路径文本在前，委托 read 的 content 接在后面，details 给路径', async () => {
    const { render, tool } = make();
    const res = await tool.execute('tc1', { path: PDF }, undefined, undefined, VISION);
    expect(render).toHaveBeenCalledTimes(1);
    // 校验先行之后，render 收到的是 validateRenderArgs 归一化过的参数：scale 默认补成 2，
    // 路径按当前平台归一化（win32 上分隔符变反斜杠）。
    expect(render.mock.calls[0][0]).toEqual({ path: path.normalize(PDF), page: 1, scale: 2 });
    expect(res.content[0]).toEqual({ type: 'text', text: `已渲染成 PNG：${PNG}\n` });
    expect(res.content.slice(1)).toEqual(WITH_IMAGE);
    expect(res.details).toEqual({ pngPath: PNG });
  });

  it('闸门：委托结果没有 image 块时不交出路径', async () => {
    const { tool } = make({ content: WITHOUT_IMAGE });
    const res = await tool.execute('tc1', { path: PDF }, undefined, undefined, VISION);
    expect(res.content[0]).toEqual({ type: 'text', text: `${NO_IMAGE_NOTE}\n` });
    expect(res.content.slice(1)).toEqual(WITHOUT_IMAGE);
    expect(JSON.stringify(res.content)).not.toContain(PNG);
    expect(res.details).toBeUndefined();
  });

  it('委托参数原样透传：toolCallId / signal / ctx 都是本次调用那一份', async () => {
    const { readTool, tool } = make();
    const ac = new AbortController();
    await tool.execute('tc-42', { path: PDF }, ac.signal, undefined, VISION);
    expect(readTool.execute).toHaveBeenCalledTimes(1);
    const call = readTool.execute.mock.calls[0];
    expect(call[0]).toBe('tc-42');
    expect(call[1]).toEqual({ path: PNG });
    expect(call[2]).toBe(ac.signal);
    expect(call[4]).toBe(VISION);
  });

  it('signal 透传给 render —— 用户中止这一轮时渲染要跟着停', async () => {
    const { render, tool } = make();
    const ac = new AbortController();
    await tool.execute('tc1', { path: PDF }, ac.signal, undefined, VISION);
    expect(render.mock.calls[0][1]).toBe(ac.signal);
  });

  it('模型看不了图：不渲染、不委托，只返回哨兵，也不给 details', async () => {
    const { render, readTool, tool } = make();
    const res = await tool.execute('tc1', { path: PDF }, undefined, undefined, NO_VISION);
    expect(render).not.toHaveBeenCalled();
    expect(readTool.execute).not.toHaveBeenCalled();
    expect(res.content).toEqual([{ type: 'text', text: NO_VISION_NOTE }]);
    expect(res.details).toBeUndefined();
  });

  it('哨兵不许把参数校验吞掉：看不了图 + 非法路径，仍然抛 KydogError', async () => {
    const { render, tool } = make();
    await expect(
      tool.execute('tc1', { path: '/tmp/papers/x.png' }, undefined, undefined, NO_VISION),
    ).rejects.toThrow(KydogError);
    expect(render).not.toHaveBeenCalled();
  });

  it('ctx 缺席时按「看得见图」走 —— 与 pi read 的默认一致', async () => {
    const { render, tool } = make();
    const res = await tool.execute('tc1', { path: PDF }, undefined, undefined, undefined);
    expect(render).toHaveBeenCalledTimes(1);
    expect(res.details).toEqual({ pngPath: PNG });
  });

  it('委托 read 抛普通 Error → 包成 fs.read_failed 并保留 cause', async () => {
    const boom = new Error('ENOENT');
    const { tool } = make({ readThrows: boom });
    await expect(tool.execute('tc1', { path: PDF }, undefined, undefined, VISION))
      .rejects.toMatchObject({ name: 'KydogError', code: 'fs.read_failed', cause: boom });
  });

  it('已中止时委托抛错 → 包成 agent.aborted，而不是读失败', async () => {
    const ac = new AbortController();
    ac.abort();
    const { tool } = make({ readThrows: new Error('Operation aborted') });
    await expect(tool.execute('tc1', { path: PDF }, ac.signal, undefined, VISION))
      .rejects.toMatchObject({ name: 'KydogError', code: 'agent.aborted' });
  });
});
