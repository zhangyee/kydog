import type { NavigationObservation } from '../../shared/types';

/**
 * 一次主 frame 导航的观测。**只根据协议事实定论**，不用时间窗去猜。
 *
 * 这里刻意不做「等页面稳定」——「一段时间没有 mutation」本身就是一个时间阈值，
 * 它不是页面给出的完成事实，可能刚好落在两次异步更新之间。需要等某件事发生时，
 * 由调用方给显式条件（`wait` 动作）。
 */

/** Chromium 在导航被下载接管、被用户停止、被新导航取代时都会给这个码。
 *  信息量极低，单独看它不该定论 —— 见下面的 pendingAbort。 */
const ERR_ABORTED = -3;

export class NavigationTracker {
  private outcome: NavigationObservation['outcome'] | null = null;
  private resolveSettled!: () => void;
  /** 定论时兑现。调用方 await 它而不是轮询 —— 轮询的粒度是又一个时间窗。 */
  readonly settledPromise: Promise<void> = new Promise((r) => { this.resolveSettled = r; });
  /** 收到过 ERR_ABORTED 但还没定论。它可能是「下载接管了」的前兆，
   *  所以先记下来，等下载事件或超时再说。 */
  private pendingAbort: { errorCode: number; errorDesc: string } | null = null;

  constructor(readonly navigationId: string) {}

  get settled(): boolean { return this.outcome !== null; }

  private set(o: NavigationObservation['outcome']): void {
    // 先到先得。已经定论之后到达的事件一律丢弃 —— 迟到的 did-navigate 覆盖掉
    // 已经上报出去的 timeout，会让工具结果与页面实际状态对不上。
    if (this.outcome !== null) return;
    this.outcome = o;
    this.resolveSettled();
  }

  /** 403 走的就是这条路：它是一次**成功**的导航，did-fail-load 不会触发。 */
  onDidNavigate(finalUrl: string, httpStatusCode: number): void {
    this.set({ kind: 'ok', finalUrl, httpStatusCode });
  }

  onDidFailLoad(errorCode: number, errorDesc: string, isMainFrame: boolean): void {
    // 子 frame 失败是常态（广告位、统计脚本），拿它当整页失败会让 agent 无谓换源。
    if (!isMainFrame) return;
    if (errorCode === ERR_ABORTED) { this.pendingAbort ??= { errorCode, errorDesc }; return; }
    this.set({ kind: 'failed', errorCode, errorDesc });
  }

  /**
   * 导航变成了文件下载。一期一律取消下载（§5.4），但**必须如实报成 download**：
   * 报成 timeout 的话，agent 打一个 PDF 直链会以为源不可达并换源 —— 而它其实找到了文件。
   */
  onWillDownload(url: string, mimeType: string, filename: string): void {
    this.pendingAbort = null;
    this.set({ kind: 'download', url, mimeType, filename, cancelled: 'policy' });
  }

  /** 调用方在时限到达时调一次。之后要 stop() 并作废这个 navigationId。 */
  onTimeout(): void {
    // 只收到过 ERR_ABORTED、下载又始终没来 —— 那就是真的不知道发生了什么。
    // 如实报 timeout，不要拿 ERR_ABORTED 硬凑成 failed。
    this.set({ kind: 'timeout' });
  }

  /**
   * 渲染进程崩溃。没有专门表示「渲染进程死了」的 Chromium 错误码，所以借用
   * ERR_FAILED(-2)，把真正的原因放进 errorDesc —— 不这样的话，一次崩溃要挂满
   * 整个超时窗口才会给出结论，而那时报的还是 timeout（我们其实知道发生了什么）。
   */
  onCrashed(reason: string): void {
    this.set({ kind: 'failed', errorCode: -2, errorDesc: `渲染进程崩溃：${reason}` });
  }

  observation(): NavigationObservation | null {
    return this.outcome === null ? null : { navigationId: this.navigationId, outcome: this.outcome };
  }
}
