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
  /**
   * 抽完一页就交出去：调用方拿 `text` 填 linesCache，拿 `source` 对**不在渲染窗口内**的页调
   * `page.cleanup()` 把 pdf.js 的解码缓存还回去（spec §4、不变量 #8）。
   *
   * proxy 必须原样交出去、不能让调用方自己回表里找：翻译这条路的页是现取的
   * （`pdf.getPage(n)`），多数从来没进过调用方那张 proxy 表——找不到就等于不清，翻 200 页
   * 就是 200 页 `getTextContent()` 的解析结果一直驻留到关 tab。
   */
  onPageExtracted?: (page: number, text: TextLine[], source: TextSource) => void;
  pdfName: string;
  langOut: string;
  source: { sha256: string; bytes: number };
  glossary?: Term[];
  concurrency?: number;
};

const isNotConfigured = (e: unknown) => (e as { code?: string } | null)?.code === 'llm.not_configured';

export async function translateDoc(o: TranslateDocOptions): Promise<TranslatedDoc | null> {
  const concurrency = o.concurrency ?? PAGE_CONCURRENCY;
  /**
   * 重试之后仍失败的页号。**记页号不记计数**：这份逐页信号要原样写进边车
   * （`TranslatedDoc.failedPages`），计数只是它的长度。以前这里只留一个 `failed` 数字，
   * 于是「哪几页失败」在流水线里就地丢掉，下游只能从 `onProgress` 这条侧信道漏出的瞬时数字
   * 里捞——一切关于它「活多久」的补丁都是那次丢信号的下游症状。
   */
  const failedPages: number[] = [];

  // ── 1. 抽取。不 catch：抽取失败与「这页没字」是两件事（spec §4），异常中止整趟。
  const perPage = new Map<number, PageLine[]>();
  for (let n = 1; n <= o.numPages; n++) {
    if (o.isCancelled()) return null;
    const src = await o.getPage(n);
    const { lines, text } = await extractPageLines(src);
    perPage.set(n, lines);
    o.onPageExtracted?.(n, text, src);
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
  const tick = () => o.onProgress({ phase: 'translate', done, total, failed: failedPages.length });
  // 中止信号：跟 isCancelled() 是两码事——isCancelled() 是「用户 / 调用方要求停」，aborted 是
  // 「某个 worker 已经因 llm.not_configured 在抛错路径上了」。Promise.all 一旦有一个 worker
  // 拒绝就会 reject，但其余 ≤3 个 worker 的 translatePage 仍在飞（配置是在它们发出之后才丢的，
  // 这是现实时序）——它们成功落地时如果不认这面旗子，会在调用方已经拿到 rejection 之后再
  // 触发一次 onProgress，也会在另一个 worker 已经在抛错路径上时继续派发新页。
  let aborted = false;

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
   * 一页：跑一次 → 失败重试一次 → 仍失败把**页号**记进 failedPages 并保留原文（该页不产块 →
   * 右格不覆盖）。
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
      // aborted 必须在 throw 之前落地：它是「别的 worker 该收手了」的唯一信号源，
      // 迟一步落地就会被其余 worker 的检查点错过（见上面对 aborted 的注释）。
      if (isNotConfigured(e)) { aborted = true; throw e; }
      try {
        groupsOf.set(page, await attempt());
      } catch (e2) {
        if (isNotConfigured(e2)) { aborted = true; throw e2; }
        failedPages.push(page);
      }
    }
    // 这次 attempt 是在别的 worker 已经因 llm.not_configured 抛错之后才落地的——Promise.all
    // 迟早会 reject，调用方大概率已经拿到那个 rejection，这次 done++/tick() 只是一次多余且
    // 误导调用方的 onProgress，直接跳过（不影响 groupsOf：上面已经 set 过，只是不再计入进度）。
    if (aborted) return;
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
      // aborted 和 isCancelled() 都是「派发前的检查点」，处理方式一样：不再派发新页、正常
      // return（不 throw）。这里把 cancelled 也一起置上是安全的——aborted 只会由抛错的那个
      // worker 置位并且紧跟着 throw，那个 worker 自己的 promise 会 reject，Promise.all 因此
      // 必然 reject，`await Promise.all(...)` 会直接抛出、跳过下面 `if (cancelled ...)
      // return null` 那一行，cancelled 在这条路径上根本不会被读到，不会把「该 reject」错变成
      // 「返回 null」。
      if (aborted || o.isCancelled()) { cancelled = true; return; }
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
  // 升序：页是并发跑的，push 的次序是完成次序。排一次序让边车内容只由「哪几页失败」决定，
  // 不由这一趟的调度巧合决定（否则同样的输入会写出不同的文件）。
  if (failedPages.length) doc.failedPages = [...failedPages].sort((a, b) => a - b);
  return doc;
}
