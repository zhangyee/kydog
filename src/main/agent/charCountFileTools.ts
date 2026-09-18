import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 把 pi 的 `write` / `edit` 换成「写完顺手报字数」的版本（同名注册进 customTools，覆盖内置的）。
 *
 * 为什么要有：skill 给产物定了字数（前沿简报 1500–2500 字、核查报告 800–1200 字……），
 * 模型没有别的途径知道自己写了多少，于是写完拿 `grep -o | wc -l` 数、整份重写、再数
 * （2026-09-17 第二组验收，一轮里来回五次）。字数是写进磁盘那一刻就确定的事实，工具交出来。
 *
 * 数的是**真的写进磁盘的内容**：pi 的两个工具都接受可替换的文件操作，`writeFile` 收到的就是
 * 最终内容。所以不必自己再解析一遍路径（pi 的解析规则没有导出，照抄会漂），也不必事后
 * 回头读文件。同一批里并行的几次写入靠 `AsyncLocalStorage` 各记各的。
 */

export const COUNT_LINE_PREFIX = '字数（汉字每字算 1，英文每词算 1）：';

/** 只给这几种文本文档报字数。JSON 边车、代码之类数了没有意义。 */
const COUNTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

const MAX_SECTIONS_SHOWN = 24;
const MAX_TITLE_CHARS = 20;

export type WordCount = { total: number; sections: Array<{ title: string; count: number }> };

const HAN = /\p{Script=Han}/gu;
const LATIN_WORD = /[A-Za-z0-9]+(?:[-'’.][A-Za-z0-9]+)*/g;

function countLine(line: string): number {
  const han = line.match(HAN)?.length ?? 0;
  const words = line.replace(HAN, ' ').match(LATIN_WORD)?.length ?? 0;
  return han + words;
}

/**
 * 按一级、二级标题分节计数。标题本身也算字；代码块里以 `#` 开头的行不是标题。
 * 第一个标题之前有字时，单列一节「（标题前）」。
 */
export function countWords(text: string): WordCount {
  const sections: WordCount['sections'] = [];
  let current = { title: '（标题前）', count: 0 };
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (current.count > 0 || sections.length > 0) sections.push(current);
      current = { title: heading[2], count: 0 };
    }
    current.count += countLine(line.replace(/^#{1,6}\s+/, ''));
  }
  if (current.count > 0 || sections.length > 0 || current.title !== '（标题前）') sections.push(current);
  return { total: sections.reduce((a, s) => a + s.count, 0), sections };
}

export function formatCountLine(c: WordCount): string {
  const shown = c.sections.slice(0, MAX_SECTIONS_SHOWN).map((s) => {
    const title = [...s.title].length > MAX_TITLE_CHARS ? `${[...s.title].slice(0, MAX_TITLE_CHARS).join('')}…` : s.title;
    return `${title} ${String(s.count)}`;
  });
  const rest = c.sections.length - shown.length;
  const tail = rest > 0 ? ` · …（另 ${String(rest)} 节）` : '';
  const parts = c.sections.length > 1 ? `。分节：${shown.join(' · ')}${tail}` : '';
  return `${COUNT_LINE_PREFIX}全文 ${String(c.total)}${parts}`;
}

type ToolContent = { type: string; text?: string; [k: string]: unknown };
type ToolResult = { content: ToolContent[]; details?: unknown };

/** 只用到 pi 工具定义的这一小块。用结构类型而不是 import pi 的类型：pi 是 external。 */
export type FileToolDefinition = {
  name: string;
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<ToolResult>;
  [k: string]: unknown;
};

export type PiFileToolFactories = {
  createWriteToolDefinition(cwd: string, options: { operations: {
    writeFile(absolutePath: string, content: string): Promise<void>;
    mkdir(dir: string): Promise<void>;
  } }): FileToolDefinition;
  createEditToolDefinition(cwd: string, options: { operations: {
    readFile(absolutePath: string): Promise<Buffer>;
    writeFile(absolutePath: string, content: string): Promise<void>;
    access(absolutePath: string): Promise<void>;
  } }): FileToolDefinition;
};

const lastWrite = new AsyncLocalStorage<{ path?: string; content?: string }>();

/** 与 pi 的默认实现逐字相同（write.js / edit.js 的 default*Operations），只多记一笔。 */
async function recordingWriteFile(absolutePath: string, content: string): Promise<void> {
  await fs.writeFile(absolutePath, content, 'utf-8');
  const store = lastWrite.getStore();
  if (store) { store.path = absolutePath; store.content = content; }
}

function withCount(def: FileToolDefinition): FileToolDefinition {
  return {
    ...def,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const store: { path?: string; content?: string } = {};
      const result = await lastWrite.run(store, () => def.execute(toolCallId, params, signal, onUpdate, ctx));
      if (store.path === undefined || store.content === undefined) return result;
      if (!COUNTED_EXTENSIONS.has(path.extname(store.path).toLowerCase())) return result;
      return { ...result, content: [...result.content, { type: 'text', text: `\n${formatCountLine(countWords(store.content))}` }] };
    },
  };
}

export function createCharCountFileTools(pi: PiFileToolFactories, cwd: string): [FileToolDefinition, FileToolDefinition] {
  const write = pi.createWriteToolDefinition(cwd, {
    operations: {
      writeFile: recordingWriteFile,
      mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => {}),
    },
  });
  const edit = pi.createEditToolDefinition(cwd, {
    operations: {
      readFile: (p) => fs.readFile(p),
      writeFile: recordingWriteFile,
      access: (p) => fs.access(p, constants.R_OK | constants.W_OK),
    },
  });
  return [withCount(write), withCount(edit)];
}
