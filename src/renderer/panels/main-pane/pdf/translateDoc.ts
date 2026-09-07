import type { Block, PageLine, Term, TranslatedDoc, TranslateGroup } from '../../../../shared/zhSidecar';
import { buildBlocks, joinSource } from './buildBlocks';
import { extractPageLines, type TextSource } from './extractPageLines';
import { checkGroupGeometry } from './groupGeometry';
import { GroupError, isTranslatable, parseLayout, type LayoutGroup, type ParsedGroup } from './layoutProtocol';
import type { TextLine } from './textLines';
import { parseTranslations } from './translateProtocol';

/**
 * 一趟作业里同时「已发出、未落地」的页数上界——**也就是取消时的浪费上界**（invoke 没有取消
 * 语义，已发出的那几页会跑完再被丢弃）。全应用的上界是主进程的 MODEL_CONCURRENCY，两者管的
 * 不是同一件事，见 pdfTranslatePage.ts 的注释。
 */
export const PAGE_CONCURRENCY = 4;

export type TranslatePhase = 'extract' | 'translate' | 'finalize';
export type JobProgress = { phase: TranslatePhase; done: number; total: number; failed: number };

/** 第一步（版面）：一页的行进去，`<ids> | <kind>` 的原始文本出来（spec 2026-09-07 §4.2）。 */
export type LayoutFn = (a: {
  page: number; lines: PageLine[]; docTitle?: string;
}) => Promise<{ text: string; truncated: boolean }>;
/** 第二步（翻译）：可译组进去，每组一个 `%%` 槽位的原始文本出来（§4.3）。 */
export type TranslateFn = (a: {
  page: number; groups: TranslateGroup[]; docTitle?: string;
}) => Promise<{ text: string; truncated: boolean }>;

export type TranslateDocOptions = {
  numPages: number;
  getPage: (n: number) => Promise<TextSource>;
  layoutPage: LayoutFn;
  translateGroups: TranslateFn;
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
  /** 只翻这几页（升序、不重复）。缺省 = 全部。给了它必须给 base（spec 2026-09-06 §4.3）。 */
  pages?: number[];
  /** 合并底本：pages 之外的块、术语表、docTitle 都从它来。 */
  base?: TranslatedDoc;
};

const isNotConfigured = (e: unknown) => (e as { code?: string } | null)?.code === 'llm.not_configured';

export async function translateDoc(o: TranslateDocOptions): Promise<TranslatedDoc | null> {
  if (o.pages && !o.base) throw new Error('pages 需要 base');
  const pageList = o.pages ?? Array.from({ length: o.numPages }, (_, i) => i + 1);
  const concurrency = o.concurrency ?? PAGE_CONCURRENCY;
  /**
   * 重试之后仍失败的页号。**记页号不记计数**：这份逐页信号要原样写进边车
   * （`TranslatedDoc.failedPages`），计数只是它的长度。以前这里只留一个 `failed` 数字，
   * 于是「哪几页失败」在流水线里就地丢掉，下游只能从 `onProgress` 这条侧信道漏出的瞬时数字
   * 里捞——一切关于它「活多久」的补丁都是那次丢信号的下游症状。
   */
  const failedPages: number[] = [];
  const reasons: Record<string, string> = {};

  // ── 1. 抽取。不 catch：抽取失败与「这页没字」是两件事（spec §4），异常中止整趟。
  const perPage = new Map<number, PageLine[]>();
  for (let i = 0; i < pageList.length; i++) {
    const n = pageList[i];
    if (o.isCancelled()) return null;
    const src = await o.getPage(n);
    const { lines, text } = await extractPageLines(src);
    perPage.set(n, lines);
    o.onPageExtracted?.(n, text, src);
    o.onProgress({ phase: 'extract', done: i + 1, total: pageList.length, failed: 0 });
  }
  const work = [...perPage.entries()].filter(([, ls]) => ls.length > 0).map(([page, lines]) => ({ page, lines }));
  if (work.length === 0) {
    if (o.pages) return { ...o.base!, source: o.source };
    throw new Error('这份 PDF 没有文本层（可能是扫描件），无法翻译');
  }

  // ── 2. 翻译。
  const total = work.length;
  let done = 0;
  const groupsOf = new Map<number, ParsedGroup[]>();
  const tick = () => o.onProgress({ phase: 'translate', done, total, failed: failedPages.length });
  // 中止信号：跟 isCancelled() 是两码事——isCancelled() 是「用户 / 调用方要求停」，aborted 是
  // 「某个 worker 已经因 llm.not_configured 在抛错路径上了」。Promise.all 一旦有一个 worker
  // 拒绝就会 reject，但其余 ≤3 个 worker 的上游请求仍在飞（配置是在它们发出之后才丢的，
  // 这是现实时序）——它们成功落地时如果不认这面旗子，会在调用方已经拿到 rejection 之后再
  // 触发一次 onProgress，也会在另一个 worker 已经在抛错路径上时继续派发新页。
  let aborted = false;

  /**
   * 第一步：版面。截断就对半拆行，递归到单行——整页原样重试只会再截断一次，所以处置必须是拆
   * （spec §2.4）。
   *
   * 划分只缺行时**先补漏一次**（spec 2026-09-06 §4.1）：缺哪几行由 parseLayout 精确给出，只把
   * 那几行再发一次让模型分组，并到后面。补漏那一趟（repair=false）再漏、或缺的就是全部（模型
   * 什么都没回）→ 抛 GroupError，走 twice 的整步重试。几何校验在 runPage 对合并后的整页做。
   */
  const runLayout = async (page: number, lines: PageLine[], docTitle?: string, repair = true): Promise<LayoutGroup[]> => {
    const r = await o.layoutPage({ page, lines, docTitle });
    if (r.truncated) {
      if (lines.length <= 1) throw new Error(`第 ${page} 页单行版面输出仍被截断`);
      const mid = Math.ceil(lines.length / 2);
      return [
        ...await runLayout(page, lines.slice(0, mid), docTitle, repair),
        ...await runLayout(page, lines.slice(mid), docTitle, repair),
      ];
    }
    const { groups, missing } = parseLayout(r.text, lines.map((l) => l.n));
    if (missing.length === 0) return groups;
    if (!repair || missing.length === lines.length) throw new GroupError(`行 ${missing.join(',')} 没有出现在任何组里`);
    return [...groups, ...await runLayout(page, lines.filter((l) => missing.includes(l.n)), docTitle, false)];
  };

  /**
   * 第二步：翻译。与第一步同构，只是拆的单位从行换成组：截断对半拆组、缺组补漏一次
   * （spec 2026-09-07 §4.3）。
   */
  const runTranslate = async (page: number, groups: TranslateGroup[], docTitle?: string, repair = true): Promise<Record<string, string>> => {
    const r = await o.translateGroups({ page, groups, docTitle });
    if (r.truncated) {
      if (groups.length <= 1) throw new Error(`第 ${page} 页单组译文仍被截断`);
      const mid = Math.ceil(groups.length / 2);
      return {
        ...await runTranslate(page, groups.slice(0, mid), docTitle, repair),
        ...await runTranslate(page, groups.slice(mid), docTitle, repair),
      };
    }
    const { targets, missing } = parseTranslations(r.text, groups.map((g) => g.id));
    if (missing.length === 0) return targets;
    if (!repair || missing.length === groups.length) throw new GroupError(`组 ${missing.join(',')} 没有译文`);
    return { ...targets, ...await runTranslate(page, groups.filter((g) => missing.includes(g.id)), docTitle, false) };
  };

  type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

  /**
   * 跑一次，失败重试一次；两次都失败把原因（带步骤前缀）交给调用方。
   *
   * `llm.not_configured` 不重试：它是「没配模型 / 钉住的模型没了」，重试一百次也一样，而且要
   * 中止整趟。按错误码分支，不匹配 message 字符串。aborted 必须在 throw 之前落地：它是
   * 「别的 worker 该收手了」的唯一信号源，迟一步落地就会被其余 worker 的检查点错过。
   */
  const twice = async <T>(label: '版面' | '翻译', step: () => Promise<T>): Promise<Attempt<T>> => {
    try {
      return { ok: true, value: await step() };
    } catch (e) {
      if (isNotConfigured(e)) { aborted = true; throw e; }
      try {
        return { ok: true, value: await step() };
      } catch (e2) {
        if (isNotConfigured(e2)) { aborted = true; throw e2; }
        // 原因随页号一起落边车（spec 2026-09-06 §4.2），前缀说明是哪一步失的：以前这里只 push
        // 页号，异常当场丢掉，「为什么失败」在流水线里就地消失，事后从任何记录里都查不出来。
        return { ok: false, reason: `${label}：${(e as Error).message}；重试：${(e2 as Error).message}` };
      }
    }
  };

  /**
   * 一页 = 版面 → 几何 → 翻译（spec 2026-09-07 §4.4）。第二步失败只重试第二步，第一步结果保留
   * ——版面已经校验过了，重跑它既多付一次调用，又可能换回一份更差的划分。
   *
   * 几何校验放在第一步拆分**合并之后**、对着整页的行做——拆开的两半各自校验挡不住「A 半的组
   * 盖住 B 半的行」。
   *
   * 失败页记页号与原因、保留原文（该页不产块 → 右格不覆盖）。
   *
   * `precomputed`：第 1 页为了取文题先单跑过一次版面，把那次结果原样传进来复用，不再跑第二次。
   */
  const runPage = async (page: number, lines: PageLine[], docTitle?: string, precomputed?: Attempt<LayoutGroup[]>): Promise<void> => {
    const fail = (reason: string) => { failedPages.push(page); reasons[String(page)] = reason; };
    const layout = precomputed ?? await twice('版面', async () => {
      const groups = await runLayout(page, lines, docTitle);
      checkGroupGeometry(groups, lines);
      return groups;
    });
    // 这一档与下面那档的 `if (aborted)`：这次尝试是在别的 worker 已经因 llm.not_configured
    // 抛错之后才落地的——Promise.all 迟早会 reject，调用方大概率已经拿到那个 rejection，这次
    // done++/tick() 只是一次多余且误导调用方的 onProgress，直接跳过。
    if (!layout.ok) { fail(layout.reason); if (!aborted) { done++; tick(); } return; }

    // 组 → 第二步的请求：只发可译的（code / formula / table / skip 不翻不盖，§4.3），id 按
    // 阅读顺序 g1..gN，只活在这两次调用之间。source 用 joinSource 拼好——与边车里 buildBlocks
    // 写的 source 同一条规则，模型这一步看到的就是最终会落盘的那个串。
    const byId = new Map(lines.map((l) => [l.n, l.text]));
    const req: TranslateGroup[] = [];
    const slot = new Map<number, string>();            // layout 组下标 → g<n>
    layout.value.forEach((g, i) => {
      if (!isTranslatable(g.kind)) return;
      const id = `g${req.length + 1}`;
      slot.set(i, id);
      req.push({ id, kind: g.kind, source: joinSource(g.lines.map((n) => byId.get(n) ?? '')) });
    });
    let targets: Record<string, string> = {};
    // 整页一个可译组都没有（纯代码页、纯表格页）→ 第二步根本不发。
    if (req.length > 0) {
      const t = await twice('翻译', () => runTranslate(page, req, docTitle));
      if (!t.ok) { fail(t.reason); if (!aborted) { done++; tick(); } return; }
      targets = t.value;
    }
    const groups: ParsedGroup[] = layout.value.map((g, i) => {
      const id = slot.get(i);
      return id === undefined ? { ...g } : { ...g, target: targets[id] };
    });
    groupsOf.set(page, groups);
    if (aborted) return;
    done++;
    tick();
  };

  tick();
  // 第 1 页的版面先单跑，为的是拿到 docTitle 传给其余页（BabelDOC「注入全文第一个标题」的轻量版）。
  // 部分跑（pages）不单跑：文题从底本里现成的第一个 title 块取（第 1 页第一个 title 块就是
  // 文题），所有页平等地进 worker 池。
  let docTitle: string | undefined;
  let rest = work;
  if (o.pages) {
    docTitle = o.base!.blocks.find((b) => b.kind === 'title')?.source;
  } else {
    const [head, ...others] = work;
    rest = others;
    if (o.isCancelled()) return null;
    // 第 1 页拆开跑：文题要在第 1 页**自己的第二步**之前就确定（它也该带着文题去翻），所以先
    // 只跑版面拿 title 组，再把这份版面结果当 precomputed 交给 runPage——整页照常走，但版面
    // 不多付一次调用。
    const first = await twice('版面', async () => {
      const groups = await runLayout(head.page, head.lines);
      checkGroupGeometry(groups, head.lines);
      return groups;
    });
    if (first.ok) {
      const byId = new Map(head.lines.map((l) => [l.n, l.text]));
      const titleGroup = first.value.find((g) => g.kind === 'title');
      // 与 source 同一条规则（joinSource）：文题进的是第二步的提示词，跟落盘的 source 该是同一个串。
      if (titleGroup) docTitle = joinSource(titleGroup.lines.map((n) => byId.get(n) ?? '')).trim() || undefined;
    }
    await runPage(head.page, head.lines, docTitle, first);
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
  const fresh: Block[] = [];
  for (const { page, lines } of work) {
    const g = groupsOf.get(page);
    if (g) fresh.push(...buildBlocks(page, lines, g));
  }
  // 部分跑：pages 之外的块、失败页、原因都从底本来，只替换 pages 内的（spec 2026-09-06 §4.3）。
  // 按 (page, id) 排一次：块 id 是 p{page}-b{NN} 零填充，同页内字符串序就是 seq 序；全量跑本来就是
  // 这个序，排序幂等。
  const redo = new Set(o.pages ?? []);
  const blocks = [...(o.base?.blocks ?? []).filter((b) => o.pages && !redo.has(b.page)), ...fresh]
    .sort((a, b) => a.page - b.page || a.id.localeCompare(b.id));
  // 升序：页是并发跑的，push 的次序是完成次序。排一次序让边车内容只由「哪几页失败」决定，
  // 不由这一趟的调度巧合决定（否则同样的输入会写出不同的文件）。
  const failed = [
    ...(o.pages ? (o.base!.failedPages ?? []).filter((p) => !redo.has(p)) : []),
    ...failedPages,
  ].sort((a, b) => a - b);
  const mergedReasons: Record<string, string> = {
    ...(o.pages ? Object.fromEntries(Object.entries(o.base!.failureReasons ?? {}).filter(([k]) => !redo.has(Number(k)))) : {}),
    ...reasons,
  };
  const doc: TranslatedDoc = {
    version: 1,
    pdf: o.pdfName,
    // 不做源语言检测——沉浸式翻译的提示词本身也只指定目标语言。'auto' 是诚实地说「我们没测过」。
    lang: { in: 'auto', out: o.langOut },
    source: o.source,     // 一律写当前 PDF 的摘要：unknown 版本的旧边车经一次部分跑就被盖上摘要
    blocks,
  };
  if (o.glossary?.length) doc.glossary = o.glossary;
  if (failed.length) doc.failedPages = failed;
  // 失败页可能没有对应的原因（比如底本的陈旧 failedPages 从来没记过 failureReasons）——
  // 那种情况下 mergedReasons 是空对象，不能靠 failed.length 判断要不要写这个键，否则边车
  // 里会落一个没有任何内容的 "failureReasons": {}。
  if (Object.keys(mergedReasons).length) doc.failureReasons = mergedReasons;
  return doc;
}
