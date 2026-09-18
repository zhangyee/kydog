import { wrapPageContent } from './snapshot';

/**
 * 一个标签的 XHR / fetch 请求记录。**纯逻辑，不认识 Electron** —— 采集点在 `browserService`
 * 订阅的 `webRequestHub.onCompleted` / `onErrorOccurred` 上，那一层只负责按 `webContentsId`
 * 归到标签、把事件喂进来。
 *
 * 存在的理由（spec 2026-09-17-browser-request-signal-design §0）：点了提交、页面没反应时，
 * 模型分不清「点击没被接住，请求根本没发」「请求发了，接口拒了」「发了、200，只是渲染慢」。
 * 请求发没发、回了什么状态，是协议层本来就有的事实，只是没带给它。
 *
 * 形态照 `consoleLog.ts`：游标是计数不是时间窗；凭据窗口只计数不留内容；报告不消费。
 * 与它不同的一处：这里记着「上次报告到哪」（`markReported`）—— 报告里那句「之后到的会出现在
 * 下一次结果里」要成立，下一次就得从上次报告的终点取，而不是从下一次动作开始那一刻取。
 */

export type RequestOutcome = { kind: 'status'; code: number } | { kind: 'error'; error: string };

/** 一条请求。`where` 已经去掉了参数值与 userinfo，见 `describeRequestUrl`。 */
export type RequestLine = { seq: number; method: string; where: string; outcome: RequestOutcome };

/**
 * `buffered` 是「到这一刻为止进过缓冲的条数」，不是丢了几条：挤出是先进先出，所以游标之后
 * 进缓冲、又被挤掉的条数 = max(0, 已挤掉总数 − 游标时的 buffered)。直接拿「已挤掉总数」相减的话，
 * 缓冲满了之后挤掉的全是游标**之前**的旧条目，也会被算成这次报告丢的。
 */
export type RequestCursor = { seq: number; suppressed: number; buffered: number };

export type RequestReport = {
  /** 非 2xx/3xx，或网络错误。 */
  failed: RequestLine[];
  ok: RequestLine[];
  /** 因为一次最多报这么多而略过的（更早的那些）。 */
  okOmitted: number;
  failedOmitted: number;
  /** 因缓冲容量而丢掉的。 */
  dropped: number;
  /** 因这一页填过凭据而一个字都没采集的。 */
  suppressed: number;
  /** 这次报告覆盖到的、实际留在缓冲里的条数。 */
  total: number;
};

/** 一个标签最多留多少条。 */
export const REQUEST_BUFFER_MAX = 50;
/** 一次报告最多列多少条成功的（留最近的）。2026-09-18 实测一次百度学术检索带出 7 条 XHR。 */
export const REQUEST_REPORT_OK_MAX = 10;
/** 失败的另有自己的上限 —— 不因为成功的多就被挤掉。 */
export const REQUEST_REPORT_FAILED_MAX = 20;
/** 单条最多多少字符。路径是页面决定的，可以很长。 */
const WHERE_MAX = 160;

export const ZERO_REQUEST_CURSOR: RequestCursor = { seq: 0, suppressed: 0, buffered: 0 };

/**
 * 主机 + 路径 + 参数名，参数值一律换成 `…`。
 *
 * 查询串里常有检索词以外的 token、会话号；参数名已经足够说明打的是哪个接口。
 * userinfo 里可能带凭据，一并去掉。解析不了的地址不原样吐出。
 */
export function describeRequestUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '（地址解析不了）';
  }
  const names = [...u.searchParams.keys()];
  const query = names.length ? `?${names.map((n) => `${n}=…`).join('&')}` : '';
  const where = `${u.host}${u.pathname === '/' && !query ? '' : u.pathname}${query}`;
  return where.length > WHERE_MAX ? `${where.slice(0, WHERE_MAX)}…` : where;
}

function isFailure(o: RequestOutcome): boolean {
  return o.kind === 'error' || o.code >= 400;
}

export class TabRequestLog {
  private buf: RequestLine[] = [];
  private seq = 0;
  private suppressedCount = 0;
  private bufferedCount = 0;
  private droppedCount = 0;
  /** 上一次报告的终点。`null` = 这个标签还没被报告过。 */
  private reported: RequestCursor | null = null;
  /** `null` = 没在压着；否则是填凭据那一刻那份文档的 origin。判据见 `TabConsoleLog`。 */
  private suppressedOrigin: string | null = null;

  record(method: string, url: string, outcome: RequestOutcome): void {
    this.seq += 1;
    // **凭据窗口里只计数，一个字都不留**：登录请求的地址本身可能带票据。
    if (this.suppressedOrigin !== null) { this.suppressedCount += 1; return; }
    this.buf.push({ seq: this.seq, method, where: describeRequestUrl(url), outcome });
    this.bufferedCount += 1;
    while (this.buf.length > REQUEST_BUFFER_MAX) {
      this.buf.shift();
      this.droppedCount += 1;
    }
  }

  /** 与 `TabConsoleLog.suppress` 同一个触发点、同一套语义。 */
  suppress(origin: string): void { this.suppressedOrigin = origin; }

  /** 与 `TabConsoleLog.resumeIfOriginChanged` 同一个判据：origin 真的变了才恢复，解析不了就继续压着。 */
  resumeIfOriginChanged(origin: string | null): void {
    if (this.suppressedOrigin === null) return;
    if (origin === null) return;
    if (origin === this.suppressedOrigin) return;
    this.suppressedOrigin = null;
  }

  cursor(): RequestCursor {
    return { seq: this.seq, suppressed: this.suppressedCount, buffered: this.bufferedCount };
  }

  /** 上一次报告的终点；还没报告过就是 `null`（调用方从当前位置起算，不把之前的旧账翻出来）。 */
  reportedCursor(): RequestCursor | null { return this.reported; }

  /** 报告发出去了，记下它的终点。只往前走：晚到的一次旧调用不许把指针拨回去。 */
  markReported(c: RequestCursor): void {
    if (this.reported && c.seq < this.reported.seq) return;
    this.reported = c;
  }

  /**
   * `from` 之后（到 `upTo` 为止，不给就到最新）的那一段。**不消费**：同样的参数取两次结果一样。
   */
  since(from: RequestCursor, upTo: RequestCursor = this.cursor()): RequestReport {
    const fresh = this.buf.filter((l) => l.seq > from.seq && l.seq <= upTo.seq);
    const failedAll = fresh.filter((l) => isFailure(l.outcome));
    const okAll = fresh.filter((l) => !isFailure(l.outcome));
    const failed = failedAll.slice(-REQUEST_REPORT_FAILED_MAX);
    const ok = okAll.slice(-REQUEST_REPORT_OK_MAX);
    return {
      failed,
      ok,
      okOmitted: okAll.length - ok.length,
      failedOmitted: failedAll.length - failed.length,
      dropped: Math.max(0, Math.min(this.droppedCount, upTo.buffered) - from.buffered),
      suppressed: upTo.suppressed - from.suppressed,
      total: fresh.length,
    };
  }
}

function lineOf(l: RequestLine): string {
  const result = l.outcome.kind === 'status' ? String(l.outcome.code) : `失败 ${l.outcome.error}`;
  return `  ${l.method} ${l.where} → ${result}`;
}

function isEmpty(r: RequestReport): boolean {
  return r.total === 0 && r.dropped === 0 && r.suppressed === 0;
}

/**
 * 报告说人话。没有可说的就回 `null`。
 *
 * `late` 是上一次报告的终点到这一步开始之间到的那一段，**单独成块、单独一个标题**，不混进
 * 「这一步发出的请求」—— 点完就返回的那一步，它的检索请求常常落在这里。
 *
 * **「没有发出请求」只在这一步有点击或按键时说**，措辞限定到返回那一刻。「之后到的会出现在
 * 下一次 browser_act / browser_open 的结果里」成立，靠的是调用方下一次从这次报告的终点取
 * （`markReported`），晚到的就落进下一次的 `late`。这是一句否定型陈述，它成立的前提是采集链路
 * 通着，见 `requestLog.test.ts` 那条带正向前置的用例。
 *
 * 路径是页面决定的字，一律走 `wrapPageContent`（与控制台报告同一条规矩）。
 */
export function renderRequests(
  r: RequestReport,
  opts: { hadInput: boolean; late?: RequestReport },
): string | null {
  const blocks: string[] = [];
  if (opts.late && !isEmpty(opts.late)) {
    blocks.push(`── 上一次工具返回之后、这一步开始之前到的请求（XHR / fetch）──\n${bodyOf(opts.late)}`);
  }
  const head = '── 这一步发出的请求（XHR / fetch）──';
  if (!isEmpty(r)) blocks.push(`${head}\n${bodyOf(r)}`);
  else if (opts.hadInput) {
    blocks.push(`${head}\n截至这一步返回，这个标签没有发出任何 XHR / fetch 请求。`
      + '之后到的会出现在这个标签下一次 browser_act / browser_open 的结果里。');
  }
  return blocks.length ? blocks.join('\n') : null;
}

function bodyOf(r: RequestReport): string {
  const body: string[] = [];
  if (r.failed.length) body.push('失败：', ...r.failed.map(lineOf));
  if (r.ok.length) body.push('成功：', ...r.ok.map(lineOf));
  const notes: string[] = [];
  if (r.failedOmitted > 0) notes.push(`另有 ${String(r.failedOmitted)} 条失败的已略`);
  if (r.okOmitted > 0) notes.push(`另有 ${String(r.okOmitted)} 条成功的已略`);
  if (r.dropped > 0) notes.push(`更早的 ${String(r.dropped)} 条因为缓冲已满没能保留`);
  if (r.suppressed > 0) {
    notes.push(`另有 ${String(r.suppressed)} 条**一个字都没有采集**：这一页上填过凭据，期间的请求地址一律不采集`);
  }
  const tail = notes.length ? `\n（${notes.join('；')}。）` : '';
  if (body.length === 0) return `${notes.join('；')}。`;
  return `${wrapPageContent(body.join('\n'))}${tail}`;
}
