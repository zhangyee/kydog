// src/main/agent/readDocxTool.ts
import path from 'node:path';
import { Type } from 'typebox';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { KydogError } from '../../shared/errors';

export const READ_DOCX_TOOL_NAME = 'read_docx';

/** 纯图片 / 扫描件这类提取结果为空的判据。是给模型看的事实陈述，不是错误。 */
export const EMPTY_NOTE = '[文档不含可提取文本——可能是纯图片或扫描件]';

export const DEFAULT_MAX_LENGTH = 50_000;
const MAX_MAX_LENGTH = 200_000;

type ToolContent = { type: string; [k: string]: unknown };

export type ReadDocxDeps = {
  /** 只为测试注入。默认走 mammoth（.docx → 保结构的 HTML）。 */
  extractDocx?: (filePath: string) => Promise<string>;
  /** 只为测试注入。默认走 word-extractor（.doc → 纯文本）。 */
  extractDoc?: (filePath: string) => Promise<string>;
};

async function defaultExtractDocx(filePath: string): Promise<string> {
  // convertToMarkdown 会把表格拍平成一行一格（markdown writer 不支持表格），实测如此；
  // convertToHtml 才保住 <table>。messages 里的样式警告（如未定义的样式 ID）不进结果 ——
  // 那是保真度提示，塞给模型只是噪声。
  //
  // convertImage 必须换掉默认值：mammoth 默认把图片转成 base64 data URI 内嵌，
  // 一张 600dpi 的插图就是几百 KB 字符，吃掉几十个截断窗口，正文全压在图后面读不到
  // （实战里模型因此被迫转投 pandoc / 手撕 XML）。这里换成不读图片字节的占位符。
  const { value } = await mammoth.convertToHtml(
    { path: filePath },
    { convertImage: mammoth.images.imgElement(async () => ({ src: '', alt: '图片已省略' })) },
  );
  return value;
}

async function defaultExtractDoc(filePath: string): Promise<string> {
  const doc = await new WordExtractor().extract(filePath);
  // 脚注/尾注在学术 .doc 里是正文的一部分，非空才附；页眉页脚是版面家具，不要。
  const parts = [doc.getBody()];
  const footnotes = doc.getFootnotes();
  if (footnotes.trim() !== '') parts.push(`[脚注]\n${footnotes}`);
  const endnotes = doc.getEndnotes();
  if (endnotes.trim() !== '') parts.push(`[尾注]\n${endnotes}`);
  return parts.join('\n');
}

/** 路径规则与 pdfRaster.validateRenderArgs 同一套：绝对路径、无 NUL、无 .. 段。 */
function validatePath(raw: unknown): { filePath: string; kind: 'docx' | 'doc' } {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new KydogError('fs.read_failed', 'read_docx 需要一个文件路径');
  }
  if (raw.includes('\u0000')) {
    throw new KydogError('fs.read_failed', '路径里不能含 NUL 字符');
  }
  if (!path.isAbsolute(raw)) {
    throw new KydogError('fs.read_failed', `路径必须是绝对路径：${raw}`);
  }
  if (raw.split(/[\\/]/).includes('..')) {
    throw new KydogError('fs.read_failed', `路径里不能含 .. 段：${raw}`);
  }
  const lower = raw.toLowerCase();
  if (lower.endsWith('.docx')) return { filePath: raw, kind: 'docx' };
  if (lower.endsWith('.doc')) return { filePath: raw, kind: 'doc' };
  throw new KydogError('fs.read_failed', `只能读 .doc / .docx 文件：${raw}`);
}

function validateWindow(offset: unknown, maxLength: unknown): { offset: number; maxLength: number } {
  const off = offset ?? 0;
  const max = maxLength ?? DEFAULT_MAX_LENGTH;
  if (typeof off !== 'number' || !Number.isInteger(off) || off < 0) {
    throw new KydogError('fs.read_failed', `offset 必须是 >=0 的整数，收到 ${String(offset)}`);
  }
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_MAX_LENGTH) {
    throw new KydogError('fs.read_failed', `max_length 必须是 1–${MAX_MAX_LENGTH} 的整数，收到 ${String(maxLength)}`);
  }
  return { offset: off, maxLength: max };
}

function windowText(text: string, offset: number, maxLength: number): string {
  const total = text.length;
  if (offset >= total) {
    return `[offset=${offset} 超出全文长度（共 ${total} 字符），没有更多内容]`;
  }
  const end = Math.min(offset + maxLength, total);
  const slice = text.slice(offset, end);
  if (end >= total) return slice;
  return `${slice}\n\n[已截断：全文共 ${total} 字符，本次返回第 ${offset}–${end} 字符；继续读传 offset=${end}]`;
}

const ParamsSchema = Type.Object({
  path: Type.String({ description: 'Word 文档的绝对路径，须以 .doc 或 .docx 结尾' }),
  offset: Type.Optional(Type.Integer({
    description: '从第几个字符开始读，默认 0。上一次结果被截断时，按提示里给的值续读',
  })),
  max_length: Type.Optional(Type.Integer({
    description: `本次最多返回多少字符，默认 ${DEFAULT_MAX_LENGTH}，上限 ${MAX_MAX_LENGTH}`,
  })),
});

const DESCRIPTION = [
  '直接读 Word 文档（.docx / .doc）的内容，不需要先转换格式。',
  '.docx 转成保留结构的 HTML——标题、表格、列表、脚注都在，内嵌图片以占位符标出、不返回图片本体；.doc 提取纯文本，表格单元以制表符分隔。',
  `超长文档默认只返回前 ${DEFAULT_MAX_LENGTH} 字符，结果末尾会告诉你用哪个 offset 继续读。`,
  '',
  '什么时候不用：PDF 用 fastpaper read；纯文本 / Markdown 直接用 read。',
].join('\n');

/** 照 readPdfFigureTool 的形态注册。mammoth / word-extractor 是普通打包依赖，静态 import 即可。 */
export function createReadDocxTool(deps: ReadDocxDeps = {}) {
  const extractDocx = deps.extractDocx ?? defaultExtractDocx;
  const extractDoc = deps.extractDoc ?? defaultExtractDoc;
  return {
    name: READ_DOCX_TOOL_NAME,
    label: '读 Word 文档',
    description: DESCRIPTION,
    promptSnippet: 'read_docx — 直接读 .docx/.doc 文档内容（.docx 保结构转成 HTML）',
    parameters: ParamsSchema,

    async execute(
      _toolCallId: string,
      params: { path: string; offset?: number; max_length?: number },
      signal?: AbortSignal,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ): Promise<{ content: ToolContent[] }> {
      const { filePath, kind } = validatePath(params?.path);
      const { offset, maxLength } = validateWindow(params?.offset, params?.max_length);
      if (signal?.aborted) throw new KydogError('agent.aborted', 'Word 文档读取已中止');

      let text: string;
      try {
        text = kind === 'docx' ? await extractDocx(filePath) : await extractDoc(filePath);
      } catch (err) {
        // 解析库抛的是普通 Error；用户中止这一轮时把它归因为中止，别报成文件坏了。
        if (signal?.aborted) throw new KydogError('agent.aborted', 'Word 文档读取已中止', err);
        throw new KydogError('fs.read_failed', `无法读取 Word 文档（不存在、损坏、加密或非 Word 格式）：${filePath}`, err);
      }

      const body = text.trim() === '' ? EMPTY_NOTE : windowText(text, offset, maxLength);
      return { content: [{ type: 'text' as const, text: body }] };
    },
  };
}
