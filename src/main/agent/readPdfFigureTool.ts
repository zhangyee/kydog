// src/main/agent/readPdfFigureTool.ts
import { Type } from 'typebox';
import {
  MAX_PAGE, MAX_SCALE, MIN_SCALE, renderPageToPng, validateRenderArgs,
} from '../pdf/pdfRaster';
import { KydogError } from '../../shared/errors';

export const READ_PDF_FIGURE_TOOL_NAME = 'read_pdf_figure';

/**
 * 当前模型不支持图片输入时返回的判据。
 *
 * 不抄 pi 那句（`…The image will be omitted from this request.`）：它的后半句在这里是假的
 * —— 我们压根没渲染，也就没有「被省掉的图」。写成同样的方括号体是因为 skill 文档要按
 * 字面量匹配它，中英两份得引同一个串。**改这个串就要同步改 learning-deck 的 figures.md。**
 */
export const NO_VISION_NOTE = '[Current model does not support images. Nothing was rendered.]';

/**
 * 渲染成功、但图没能进上下文时的判据（photon 挂掉之类，见 spec §3.3，是全有全无的环境故障）。
 *
 * 注意措辞：PNG **是**产出了、也留在磁盘上，没能交付的是「路径」——
 * 因为没给模型看过的图不许被引用。别写成「没有产出 PNG」，那是假话。
 * 同样是 skill 文档按字面量匹配的串。
 */
export const NO_IMAGE_NOTE = '[Image could not be attached. No path is returned for this figure.]';

type ToolContent = { type: string; [k: string]: unknown };

/** 只用到 pi read 定义的这一小块。用结构类型而不是 import pi 的类型：pi 是 external。 */
export type ReadToolLike = {
  execute(
    toolCallId: string,
    params: { path: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<{ content: ToolContent[] }>;
};

export type ReadPdfFigureDeps = {
  /** pi 的 read 定义，由 sessionFactory 注入（那里才有动态 import 进来的 pi）。 */
  readTool: ReadToolLike;
  /** 只为测试注入。 */
  render?: typeof renderPageToPng;
};

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
  '读一张 PDF 格式的论文插图：渲染成 PNG，并把图返回给你看。',
  '**看到了才给你 PNG 的路径** —— 没能给你看的图，你也拿不到它的路径，因为没看过的图不能引用。',
  '',
  '为什么需要它：fastpaper figures 从 arXiv 源码包取到的插图常常是 .pdf',
  '（`figs/architecture.pdf` 这种），而 read 工具只认 jpg / png / gif / webp / bmp —— ',
  'PDF 给它等于没给。这个工具把「转成 PNG」和「看这张图」合成一步。',
  '',
  '什么时候不用：文件本身已经是 png / jpg / gif / webp / bmp 就直接用 read 打开，别多转一道；',
  '整篇论文的 PDF 也不要拿来逐页转图，这个工具是给单张插图用的。',
].join('\n');

/**
 * 照 askUserQuestionTool 的形态注册。
 *
 * 图片字节这一段全部委托给 pi 自己的 read 定义：resize（4.5MB 预算）、photon 转码、尺寸提示
 * 都在 pi 的 `processImage` 里，而那个函数没有从包根导出、exports map 也只开了 `"."`，
 * 深引不到。借 read 的 execute 反过来用它，是唯一不抄一份会漂移的实现的路子。
 */
export function createReadPdfFigureTool(deps: ReadPdfFigureDeps) {
  const render = deps.render ?? renderPageToPng;
  return {
    name: READ_PDF_FIGURE_TOOL_NAME,
    label: '读 PDF 插图',
    description: DESCRIPTION,
    promptSnippet: 'read_pdf_figure — 读一张 .pdf 格式的论文插图：渲染成 PNG 并把图给你看',
    parameters: ParamsSchema,

    async execute(
      toolCallId: string,
      params: { path: string; page?: number; scale?: number },
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: { model?: { input?: readonly string[] } },
      // 返回类型必须显式写出来。不写的话两个 return 会被推成联合类型，
      // 测试里读 res.details 就报「联合类型上没有这个属性」。
    ): Promise<{ content: ToolContent[]; details?: { pngPath: string } }> {
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

      let readResult: { content: ToolContent[] };
      try {
        // toolCallId / signal / ctx 原样透传：ctx 决定 pi 怎么处理这张图，signal 让中止穿透。
        readResult = await deps.readTool.execute(toolCallId, { path: pngPath }, signal, undefined, ctx);
      } catch (err) {
        // pi 的 read 抛的是普通 Error（中止时是 `Operation aborted`），不会自己变成 KydogError。
        if (signal?.aborted) throw new KydogError('agent.aborted', 'PDF 插图读取已中止', err);
        throw new KydogError('fs.read_failed', `渲染出的 PNG 无法读取：${pngPath}`, err);
      }

      // 交付闸门：图没进上下文就不交出路径。判据是委托结果里有没有 image 块 ——
      // 这个判据只表示「pi 能不能出图」，与模型有没有 vision 无关（无 vision 的模型
      // 在上面那个分支就已经返回了，根本走不到这里）。
      const attached = readResult.content.some((c) => c.type === 'image');
      if (!attached) {
        return { content: [{ type: 'text' as const, text: NO_IMAGE_NOTE }, ...readResult.content] };
      }

      return {
        content: [{ type: 'text' as const, text: `已渲染成 PNG：${pngPath}` }, ...readResult.content],
        details: { pngPath },
      };
    },
  };
}
