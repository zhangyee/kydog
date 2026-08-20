// src/main/agent/pdfFigureTool.ts
import { Type } from 'typebox';
import { MAX_PAGE, MAX_SCALE, MIN_SCALE, renderPageToPng } from '../pdf/pdfRaster';

export const PDF_FIGURE_TOOL_NAME = 'pdf_page_png';

const ParamsSchema = Type.Object({
  path: Type.String({ description: 'PDF 文件的绝对路径，必须以 .pdf 结尾' }),
  page: Type.Optional(Type.Integer({
    description: `页码，从 1 开始，默认 1（插图 PDF 通常只有一页）。上限 ${MAX_PAGE}`,
  })),
  scale: Type.Optional(Type.Number({
    description: `渲染倍率，${MIN_SCALE}–${MAX_SCALE}，默认 2。2 对内嵌进网页足够清楚；`
      + '只在图里的小字看不清时才提到 3 或 4',
  })),
});

const DESCRIPTION = [
  '把 PDF 的一页渲染成 PNG 图片，存在同目录下的 <原名>-p<页码>.png，返回该路径。',
  '',
  '什么时候用：手上有一个 .pdf 格式的插图（arXiv 源码包里的作者原图常常是',
  '`figs/architecture.pdf` 这种），而你要把它内嵌进 HTML 报告，或者要用 read 工具亲眼',
  '看看图里画的是什么 —— 两件事 PDF 都做不到，先转成 PNG。',
  '',
  '什么时候不用：文件本身已经是 PNG/JPG/SVG 就直接用，别多转一道；',
  '整篇论文的 PDF 也不要拿来逐页转图，这个工具是给单张插图用的。',
].join('\n');

/**
 * 照 askUserQuestionTool 的形态注册。render 参数只为测试注入。
 */
export function createPdfFigureTool(render: typeof renderPageToPng = renderPageToPng) {
  return {
    name: PDF_FIGURE_TOOL_NAME,
    label: 'PDF 转 PNG',
    description: DESCRIPTION,
    promptSnippet: 'pdf_page_png — 把 .pdf 格式的插图渲染成 PNG',
    parameters: ParamsSchema,

    async execute(
      _toolCallId: string,
      params: { path: string; page?: number; scale?: number },
      _signal?: AbortSignal,
    ) {
      // 参数校验留在 renderPageToPng 里（validateRenderArgs），RPC 与工具两个入口
      // 共用同一套判定，不在这里再写一份会漂移的。
      const { pngPath } = await render({
        path: params?.path,
        page: params?.page ?? 1,
        scale: params?.scale,
      });
      return {
        content: [{ type: 'text' as const, text: `已渲染成 PNG：${pngPath}` }],
        details: { pngPath },
      };
    },
  };
}
