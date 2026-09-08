import type { NavigationObservation } from '../../shared/types';
import type { UrlVerdict } from './urlGuard';

/**
 * 一次主 frame 导航的观测。**只根据协议事实定论**，不用时间窗去猜。
 *
 * 这里刻意不做「等页面稳定」——「一段时间没有 mutation」本身就是一个时间阈值，
 * 它不是页面给出的完成事实，可能刚好落在两次异步更新之间。需要等某件事发生时，
 * 由调用方给显式条件（`wait` 动作）。
 *
 * 同样地，**超时不是一种结论，是「我们没能收到任何事实」**。每多一个能明确定论的
 * 输入（同文档导航、被取代、被闸拦下），就少一条要靠等满时限收场的路。
 */

/** Chromium 在导航被下载接管、被用户停止、被新导航取代时都会给这个码。
 *  信息量极低，单独看它不该定论 —— 但「主 frame 被中断过一次」本身是协议事实，
 *  收尾时要如实带上（见 abortSeen）。 */
const ERR_ABORTED = -3;

/** urlGuard 拒掉时的那一支。
 *
 *  `onBlocked` 只收这个、不收调用方自拼的字符串：`checkUrl` 的 reason 从不回显原串
 *  （解析失败那条尤其），而 blocked 的理由要进模型上下文 —— 收裸字符串等于把第二批
 *  「含凭据的原始 URL 不进日志也不进模型上下文」那条约定交给调用方自觉。 */
export type BlockedVerdict = Extract<UrlVerdict, { ok: false }>;

/** WHATWG 规范化之后再比。主机大小写、默认端口这类差异是 URL 标准定义的**等价**，
 *  不是近似匹配；解析不了就原样比，不去猜。 */
function canonical(raw: string): string {
  try { return new URL(raw).toString(); } catch { return raw; }
}

export class NavigationTracker {
  private outcome: NavigationObservation['outcome'] | null = null;
  private resolveSettled!: () => void;
  /** 定论时兑现。调用方 await 它而不是轮询 —— 轮询的粒度是又一个时间窗。 */
  readonly settledPromise: Promise<void> = new Promise((r) => { this.resolveSettled = r; });
  /**
   * 本次导航在**主 frame** 上请求过的 URL（规范化后）。构造时给的目标 + 每一次
   * did-start-navigation。会话级的 will-download 与「这一次导航」本来没有任何关联，
   * 靠它把关联变成一个可判定的事实。
   */
  private readonly requestedUrls = new Set<string>();
  /** 观测到过主 frame 的 ERR_ABORTED。它可能是「下载接管了」「用户停了」「被新导航
   *  取代了」的前兆 —— 单独看不足以定论，但超时收尾时要如实带上，不能丢掉。 */
  private abortSeen = false;

  /**
   * @param targetUrl 这次导航要去哪。`browser_open` / reload / back / forward 都
   *   知道，点击发起的（browser_act）不知道，给 `null` —— 那种情况下关联靠
   *   `onDidStartNavigation` 补上。
   */
  constructor(readonly navigationId: string, targetUrl: string | null = null) {
    if (targetUrl !== null) this.requestedUrls.add(canonical(targetUrl));
  }

  get settled(): boolean { return this.outcome !== null; }

  private set(o: NavigationObservation['outcome']): void {
    // 先到先得。已经定论之后到达的事件一律丢弃 —— 迟到的 did-navigate 覆盖掉
    // 已经上报出去的 timeout，会让工具结果与页面实际状态对不上。
    if (this.outcome !== null) return;
    this.outcome = o;
    this.resolveSettled();
  }

  /**
   * 主 frame 真正开始请求哪个 URL。**这个输入不定论**，只把 URL 记进关联集合 ——
   * 点击发起的导航（browser_act 点 Scholar 的 [PDF]）构造时压根不知道要去哪，
   * 没有它，那条路上的下载就永远对不上本次导航。
   *
   * 子 frame 的目标不进集合：否则一个广告 iframe 只要先导航到某个 URL，
   * 它自己拉起的下载就能冒充本次导航的终态。
   */
  onDidStartNavigation(url: string, isMainFrame: boolean): void {
    if (!isMainFrame) return;
    this.requestedUrls.add(canonical(url));
  }

  /** 403 走的就是这条路：它是一次**成功**的导航，did-fail-load 不会触发。 */
  onDidNavigate(finalUrl: string, httpStatusCode: number): void {
    this.set({ kind: 'ok', finalUrl, httpStatusCode });
  }

  /**
   * 同文档导航（hash 跳转、history.pushState、SPA 路由）。它**既不触发 did-navigate
   * 也不触发 did-fail-load** —— 没有这个输入，`browser_open('https://x/p#sec2')`
   * 会一个事件都收不到，跑满整个时限再报 timeout，而那次导航其实瞬间就成了。
   *
   * 单开一个 kind 而不是给 ok 加个布尔位，是因为两件事：
   * 1. 同文档导航**没有 HTTP 响应**，`httpStatusCode` 无从谈起 —— 挂在 ok 上只能
   *    编一个数或把它变成可选，前者是造假事实，后者让每个读它的地方都要判空。
   * 2. 跨文档意味着 DOM 全换、快照身份要重发号；同文档意味着 DOM 大体还在。
   *    独立的 kind 会让下游的穷尽 switch 编译不过，逼它明确表态；
   *    一个布尔位则会被「只看 kind === 'ok'」的代码悄悄抹平。
   *
   * 子 frame 也会触发（回调带 isMainFrame），按 did-fail-load 那条的做法挡掉。
   *
   * 已知的残余：本次跨文档导航还在途中时，当前页面自己的一次 pushState 也会落到
   * 这里并被当成本次导航的结果。不拿「URL 要与目标一致」去过滤，是因为点击发起的
   * 同文档导航根本没有已知目标，过滤会把最常见的那条路重新推回超时。
   */
  onDidNavigateInPage(finalUrl: string, isMainFrame: boolean): void {
    if (!isMainFrame) return;
    this.set({ kind: 'ok_same_document', finalUrl });
  }

  onDidFailLoad(errorCode: number, errorDesc: string, isMainFrame: boolean): void {
    // 子 frame 失败是常态（广告位、统计脚本），拿它当整页失败会让 agent 无谓换源。
    if (!isMainFrame) return;
    if (errorCode === ERR_ABORTED) { this.abortSeen = true; return; }
    this.set({ kind: 'failed', errorCode, errorDesc });
  }

  /**
   * 导航变成了文件下载。一期一律取消下载（§5.4），但**必须如实报成 download**：
   * 报成 timeout 的话，agent 打一个 PDF 直链会以为源不可达并换源 —— 而它其实找到了文件。
   *
   * 但 will-download 是**会话级**事件，与「这一次导航」本来没有关联：页面 JS 或一个
   * 广告 frame 自发拉起的下载会把观测锁成 download，随后真正的 did-navigate 被先到
   * 先得丢弃，模型于是把一个广告文件名当成论文 PDF 报给用户。所以只有**对得上**本次
   * 导航请求过的 URL 才定论；对不上就当没看见，让真正的终态自己来。
   *
   * `urlChain` 是 `DownloadItem.getURLChain()` —— 含重定向的完整链，`chain[0]` 是最初
   * 请求的那个 URL，doi.org → 出版社 → PDF 这条路只有靠它才对得上。**要在 will-download
   * 的同一个 tick 里取齐**：`event.preventDefault()` 之后 item 从下一个 tick 起就不可用
   * （Electron 41 的 electron.d.ts 明写）。不给就只比 `url` 本身。
   */
  onWillDownload(url: string, mimeType: string, filename: string, urlChain: string[] = []): void {
    const seen = [url, ...urlChain].map(canonical);
    if (!seen.some((u) => this.requestedUrls.has(u))) return;
    this.set({ kind: 'download', url, mimeType, filename, cancelled: 'policy' });
  }

  /**
   * 被 KyDog 自己的 URL 闸挡下（§5.1 在 will-navigate / will-redirect 上 preventDefault）。
   *
   * 我们明确知道发生了什么，不该让它只落下一个 ERR_ABORTED、再等满时限报 timeout ——
   * 页面 302 到内网地址这条路上，agent 每撞一次就白等一个超时窗口，还拿到
   * 「不知道发生了什么」这个错的四分类。
   *
   * 只收 verdict，理由由闸给：原始 URL 一个字都不进终态。
   */
  onBlocked(verdict: BlockedVerdict): void {
    this.set({ kind: 'blocked', reason: verdict.reason });
  }

  /**
   * 这次观测被另一次导航接替了（用户在 agent 的 open 在途时点了刷新，或者
   * 调用方要在同一个标签上重新开一次）。
   *
   * 没有这个输入的话，旧 tracker 只能靠超时退出，而它的收尾会执行 `stop()` ——
   * 掐掉的正是接替它的那一次导航。两次导航都错，日志里还看不出原因。
   */
  onSuperseded(): void {
    this.set({ kind: 'superseded' });
  }

  /**
   * 时限到了。**stop 交给它执行，调用方不要自己先 stop 再调这里** —— 该不该停取决于
   * 这次观测有没有已经被别的事实定论（尤其是被取代：那时 stop 掐掉的正是接替它的那次
   * 导航），把判断和动作放进同一步，调用方就没有记错的余地，定时器与事件之间那点竞态
   * 也一起消掉了。
   *
   * 参数可选**只是为了让第六批接线之前的旧调用点还能编过**（那里现在是「自己 stop
   * 完再调 onTimeout()」）。第六批必须改成把 `() => wc.stop()` 传进来。
   */
  onTimeout(stop?: () => void): void {
    if (this.outcome !== null) return;
    stop?.();
    // 只收到过 ERR_ABORTED、后续什么都没来 —— 那确实不知道发生了什么，不能硬凑成
    // failed。但「主 frame 被中断过一次」是观测到的事实，带上它，别让工具只会说
    // 「我们不知道发生了什么」。
    this.set({ kind: 'timeout', abortObserved: this.abortSeen });
  }

  /**
   * 渲染进程崩溃。**不借用 ERR_FAILED(-2)**：借了之后「渲染进程崩了、重开一次多半
   * 就好」与「网络层 ERR_FAILED、该换源」只能靠 errorDesc 里的中文前缀区分，
   * 那是拿文案当协议事实。一个独立的 kind 比字符串匹配便宜得多。
   */
  onCrashed(reason: string): void {
    this.set({ kind: 'crashed', reason });
  }

  observation(): NavigationObservation | null {
    return this.outcome === null ? null : { navigationId: this.navigationId, outcome: this.outcome };
  }
}
