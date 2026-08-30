// src/main/agent/readPdfFigureTool.ts
import { Type } from 'typebox';
import {
  MAX_PAGE, MAX_SCALE, MIN_SCALE, renderPageToPng, validateRenderArgs,
} from '../pdf/pdfRaster';

export const READ_PDF_FIGURE_TOOL_NAME = 'read_pdf_figure';

/**
 * 当前模型不支持图片输入时返回的判据。
 *
 * 不抄 pi 那句（`…The image will be omitted from this request.`）：它的后半句在这里是假的
 * —— 我们压根没渲染，也就没有「被省掉的图」。写成同样的方括号体是因为 skill 文档要按
 * 字面量匹配它，中英两份得引同一个串。**改这个串就要同步改 learning-deck 的 figures.md。**
 */
export const NO_VISION_NOTE = '[Current model does not support images. Nothing was rendered.]';

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
  '把论文插图的 PDF 渲染成 PNG，存在同目录下的 <原名>-p<页码>.png，返回该路径。',
  '',
  '为什么需要它：fastpaper figures 从 arXiv 源码包取到的插图常常是 .pdf',
  '（`figs/architecture.pdf` 这种），而 read 工具只认 jpg / png / gif / webp / bmp —— ',
  '不转成 PNG，模型就看不见这张图，也就无法判断它是不是要找的那张，',
  '更谈不上把它内嵌进 HTML 报告。转成 PNG 之后再用 read 打开看。',
  '',
  '什么时候不用：文件本身已经是 PNG/JPG/SVG 就直接用，别多转一道；',
  '整篇论文的 PDF 也不要拿来逐页转图，这个工具是给单张插图用的。',
].join('\n');

/**
 * 照 askUserQuestionTool 的形态注册。render 参数只为测试注入。
 */
export function createReadPdfFigureTool(render: typeof renderPageToPng = renderPageToPng) {
  return {
    name: READ_PDF_FIGURE_TOOL_NAME,
    label: '插图转 PNG',
    description: DESCRIPTION,
    promptSnippet: 'pdf_figure_to_png — 把 .pdf 格式的论文插图渲染成 PNG，好让 read 看得见',
    parameters: ParamsSchema,

    async execute(
      _toolCallId: string,
      params: { path: string; page?: number; scale?: number },
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: { model?: { input?: readonly string[] } },
      // 返回类型必须显式写出来。不写的话两个 return 会被推成联合类型，
      // 测试里读 res.details 就报「联合类型上没有这个属性」。
    ): Promise<{ content: { type: 'text'; text: string }[]; details?: { pngPath: string } }> {
      // 校验必须在最前面，不能留给 renderPageToPng 顺带做：下面的无 vision 分支根本走不到
      // 渲染，非法参数会拿到一句能力哨兵而不是契约规定的 KydogError。
      // 用的是 renderPageToPng 内部同一个函数（复用，不是复制），两个入口的判定不会漂移。
      const args = validateRenderArgs({
        path: params?.path,
        page: params?.page ?? 1,
        scale: params?.scale,
      });

      // 能不能看图在渲染之前就是既定事实（协议层：model.input），没必要先渲染再由 read
      // 回一句「你看不见」。ctx 缺席时按看得见处理 —— 与 pi read 的 getNonVisionImageNote
      // 同一个默认。
      const input = ctx?.model?.input;
      if (input && !input.includes('image')) {
        return { content: [{ type: 'text' as const, text: NO_VISION_NOTE }] };
      }

      // signal 一路传下去：用户中止这一轮时渲染要跟着停，否则它还会占着渲染队列。
      const { pngPath } = await render(args, signal);
      return {
        content: [{ type: 'text' as const, text: `已渲染成 PNG：${pngPath}` }],
        details: { pngPath },
      };
    },
  };
}
