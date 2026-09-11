import { wrapPageContent } from './snapshot';

/**
 * 一个标签的控制台错误缓冲。**纯逻辑，不认识 Electron** —— 采集点在
 * `browserService` 的 `console-message` 上，那一层只负责把事件喂进来。
 *
 * 存在的理由：模型点了一个按钮、页面毫无反应时，它只能反复重试或者换源，
 * 而真相常常是页面自己抛了个异常。那条异常本来就在，只是没人带给它。
 */

/** 一条错误。`source` 是打出这条错误的脚本地址 —— 同源两个脚本只看内容分不开。 */
export type ConsoleLine = { seq: number; text: string; source: string };

/**
 * 「上一次报告到哪儿了」。
 *
 * **做成对象而不是一个数字**：报告要能分别说出「因容量丢了几条」「因凭据窗口没采
 * 几条」，而这两样都**不在缓冲区里占位**（占位会把真正的错误挤掉）。所以三个单调
 * 计数器各存一份，报告取差值。这是计数，不是时间窗。
 */
export type ConsoleCursor = { seq: number; suppressed: number; dropped: number };

export type ConsoleReport = {
  lines: ConsoleLine[];
  /** 因报告条数上限而略过的（更早的那些）。 */
  omitted: number;
  /** 因缓冲容量而丢掉的（更早的那些）。 */
  dropped: number;
  /** 因这一页填过凭据而一个字都没采集的。 */
  suppressed: number;
};

/** 一个标签最多留多少条。 */
export const CONSOLE_BUFFER_MAX = 50;
/** 一次报告最多带出多少条（留最近的）。 */
export const CONSOLE_REPORT_MAX = 20;
/** 单条最多多少字符。页面可以往 console.error 里塞一整份 HTML。 */
export const CONSOLE_LINE_MAX = 200;

export const ZERO_CURSOR: ConsoleCursor = { seq: 0, suppressed: 0, dropped: 0 };

export class TabConsoleLog {
  private buf: ConsoleLine[] = [];
  private seq = 0;
  private suppressedCount = 0;
  private droppedCount = 0;
  private suppressing = false;

  /**
   * 喂一条控制台消息。
   *
   * **只收 `error`**：info / warning / debug 是噪声，而这份东西要挂进模型上下文。
   */
  record(level: string, message: string, sourceId: string, lineNumber: number): void {
    if (level !== 'error') return;
    this.seq += 1;
    // **凭据窗口里只计数，一个字都不留。** 见 suppress() 的说明。
    if (this.suppressing) { this.suppressedCount += 1; return; }
    const raw = typeof message === 'string' ? message : String(message);
    const text = raw.length > CONSOLE_LINE_MAX ? `${raw.slice(0, CONSOLE_LINE_MAX)}…` : raw;
    const where = lineNumber > 0 ? `${sourceId}:${lineNumber}` : sourceId;
    this.buf.push({ seq: this.seq, text, source: where });
    while (this.buf.length > CONSOLE_BUFFER_MAX) {
      this.buf.shift();
      this.droppedCount += 1;
    }
  }

  /**
   * 这个文档上填过凭据了，从此**不再采集内容**，只数条数。
   *
   * **为什么不是「事后比对明文再过滤」**：那要把密码明文留在主进程内存里等着比对，
   * 而且拦不住页面先编码再打印（`btoa(pw)` 那一种）。不采集是零保留，
   * 对编码同样有效。代价是登录页那一小段窗口看不到控制台 —— 接受，
   * 而且**被挡下了几条会如实报出来**，不是静默的。
   */
  suppress(): void { this.suppressing = true; }

  /** 主 frame 换了文档：凭据跟着旧文档一起走了，恢复采集。 */
  resumeOnNewDocument(): void { this.suppressing = false; }

  cursor(): ConsoleCursor {
    return { seq: this.seq, suppressed: this.suppressedCount, dropped: this.droppedCount };
  }

  /** **不消费**：同一个游标取两次结果一样。谁报告谁自己记游标。 */
  since(from: ConsoleCursor): ConsoleReport {
    const fresh = this.buf.filter((l) => l.seq > from.seq);
    const lines = fresh.slice(-CONSOLE_REPORT_MAX);
    return {
      lines,
      omitted: fresh.length - lines.length,
      dropped: this.droppedCount - from.dropped,
      suppressed: this.suppressedCount - from.suppressed,
    };
  }
}

/**
 * 报告说人话。没有任何可说的就回 `null` —— 不给每次工具调用添一段空噪声
 * （与 `loginLine` / `navLine` 同一个做法）。
 *
 * **错误正文一律走 `wrapPageContent`**：它是页面写的字，不是 KyDog 说的话。
 * 不框起来的话，一个恶意页面往 `console.error` 里写一段伪装成系统指令的文本，
 * 就能直接进模型上下文。
 */
export function renderConsole(r: ConsoleReport): string | null {
  if (r.lines.length === 0 && r.dropped === 0 && r.omitted === 0 && r.suppressed === 0) return null;
  const notes: string[] = [];
  if (r.dropped > 0) notes.push(`更早的 ${r.dropped} 条因为缓冲已满没能保留`);
  if (r.omitted > 0) notes.push(`更早的 ${r.omitted} 条因为一次最多报 ${CONSOLE_REPORT_MAX} 条被略过`);
  if (r.suppressed > 0) {
    notes.push(`另有 ${r.suppressed} 条**一个字都没有采集**：这一页上填过凭据，`
      + '期间的控制台内容一律不采集（页面脚本可以把密码打进控制台）');
  }
  const head = '── 页面报的错 ──';
  const tail = notes.length ? `\n（${notes.join('；')}。）` : '';
  if (r.lines.length === 0) return `${head}\n${notes.join('；')}。`;
  const body = r.lines.map((l) => `${l.text}\n    ${l.source}`).join('\n');
  return `${head}\n这些是**页面自己**报的错，多半能解释「点了没反应」。\n`
    + `${wrapPageContent(body)}${tail}`;
}
