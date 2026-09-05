import type { Block, PageLine, Term, TranslatedDoc } from '../../../../shared/zhSidecar';
import { buildBlocks } from './buildBlocks';
import { extractPageLines, type TextSource } from './extractPageLines';
import { checkGroupGeometry } from './groupGeometry';
import { parseGroups, type ParsedGroup } from './parseGroups';
import type { TextLine } from './textLines';

/**
 * 一趟作业里同时「已发出、未落地」的页数上界——**也就是取消时的浪费上界**（invoke 没有取消
 * 语义，已发出的那几页会跑完再被丢弃）。全应用的上界是主进程的 MODEL_CONCURRENCY，两者管的
 * 不是同一件事，见 pdfTranslatePage.ts 的注释。
 */
export const PAGE_CONCURRENCY = 4;

export type TranslatePhase = 'extract' | 'translate' | 'finalize';
export type JobProgress = { phase: TranslatePhase; done: number; total: number; failed: number };

export type PageTranslator = (a: {
  page: number; lines: PageLine[]; docTitle?: string;
}) => Promise<{ text: string; truncated: boolean }>;

export type TranslateDocOptions = {
  numPages: number;
  getPage: (n: number) => Promise<TextSource>;
  translatePage: PageTranslator;
  onProgress: (p: JobProgress) => void;
  isCancelled: () => boolean;
  /** 抽完一页就交出去：调用方拿它填 linesCache 并对窗口外的页调 page.cleanup()。 */
  onPageExtracted?: (page: number, text: TextLine[]) => void;
  pdfName: string;
  langOut: string;
  source: { sha256: string; bytes: number };
  glossary?: Term[];
  concurrency?: number;
};

const isNotConfigured = (e: unknown) => (e as { code?: string } | null)?.code === 'llm.not_configured';

export async function translateDoc(o: TranslateDocOptions): Promise<TranslatedDoc | null> {
  const concurrency = o.concurrency ?? PAGE_CONCURRENCY;
  let failed = 0;

  // ── 1. 抽取。不 catch：抽取失败与「这页没字」是两件事（spec §4），异常中止整趟。
  const perPage = new Map<number, PageLine[]>();
  for (let n = 1; n <= o.numPages; n++) {
    if (o.isCancelled()) return null;
    const { lines, text } = await extractPageLines(await o.getPage(n));
    perPage.set(n, lines);
    o.onPageExtracted?.(n, text);
    o.onProgress({ phase: 'extract', done: n, total: o.numPages, failed: 0 });
  }
  const work = [...perPage.entries()].filter(([, ls]) => ls.length > 0).map(([page, lines]) => ({ page, lines }));
  if (work.length === 0) {
    throw new Error('这份 PDF 没有文本层（可能是扫描件），无法翻译');
  }

  // ── 2. 翻译。
  const total = work.length;
  let done = 0;
  const groupsOf = new Map<number, ParsedGroup[]>();
  const tick = () => o.onProgress({ phase: 'translate', done, total, failed });

  /** 截断就对半拆重试，递归到单行。整页原样重试只会再截断一次，所以处置必须是拆（spec §2.4）。 */
  const runBatch = async (page: number, lines: PageLine[], docTitle?: string): Promise<ParsedGroup[]> => {
    const r = await o.translatePage({ page, lines, docTitle });
    if (r.truncated) {
      if (lines.length <= 1) throw new Error(`第 ${page} 页单行输出仍被截断`);
      const mid = Math.ceil(lines.length / 2);
      return [
        ...await runBatch(page, lines.slice(0, mid), docTitle),
        ...await runBatch(page, lines.slice(mid), docTitle),
      ];
    }
    return parseGroups(r.text, lines.map((l) => l.n));
  };

  /**
   * 一页：跑一次 → 失败重试一次 → 仍失败记 failed 并保留原文（该页不产块 → 右格不覆盖）。
   * 几何校验放在拆分**合并之后**、对着整页的行做——拆开的两半各自校验挡不住「A 半的组盖住
   * B 半的行」。
   *
   * `llm.not_configured` 不重试：它是「没配模型 / 钉住的模型没了」，重试一百次也一样，而且要
   * 中止整趟。按错误码分支，不匹配 message 字符串。
   */
  const runPage = async (page: number, lines: PageLine[], docTitle?: string): Promise<void> => {
    const attempt = async () => {
      const groups = await runBatch(page, lines, docTitle);
      checkGroupGeometry(groups, lines);
      return groups;
    };
    try {
      groupsOf.set(page, await attempt());
    } catch (e) {
      if (isNotConfigured(e)) throw e;
      try {
        groupsOf.set(page, await attempt());
      } catch (e2) {
        if (isNotConfigured(e2)) throw e2;
        failed++;
      }
    }
    done++;
    tick();
  };

  tick();
  // 第 1 页先单跑，为的是拿到 docTitle 传给其余页（BabelDOC「注入全文第一个标题」的轻量版）。
  let docTitle: string | undefined;
  const [head, ...rest] = work;
  if (o.isCancelled()) return null;
  await runPage(head.page, head.lines);
  const titleGroup = groupsOf.get(head.page)?.find((g) => g.kind === 'title');
  if (titleGroup) {
    const byId = new Map(head.lines.map((l) => [l.n, l.text]));
    docTitle = titleGroup.lines.map((n) => byId.get(n) ?? '').join(' ').trim() || undefined;
  }

  let next = 0;
  let cancelled = false;
  const worker = async () => {
    for (;;) {
      if (o.isCancelled()) { cancelled = true; return; }
      const i = next++;
      if (i >= rest.length) return;
      await runPage(rest[i].page, rest[i].lines, docTitle);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(rest.length, 1)) }, worker));
  if (cancelled || o.isCancelled()) return null;

  // ── 3. 组装。失败的页没有 groups → 没有块 → 右格不覆盖 → 用户看到原文。
  const blocks: Block[] = [];
  for (const { page, lines } of work) {
    const g = groupsOf.get(page);
    if (g) blocks.push(...buildBlocks(page, lines, g));
  }
  const doc: TranslatedDoc = {
    version: 1,
    pdf: o.pdfName,
    // 不做源语言检测——沉浸式翻译的提示词本身也只指定目标语言。'auto' 是诚实地说「我们没测过」。
    lang: { in: 'auto', out: o.langOut },
    source: o.source,
    blocks,
  };
  if (o.glossary?.length) doc.glossary = o.glossary;
  return doc;
}
