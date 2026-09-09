import { BrowserWindow, WebContentsView, session, type WebContents, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { KydogError } from '../../shared/errors';
import type { BrowserState, NavigationObservation, RectDip } from '../../shared/types';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { assertAllowedUrl, checkUrl } from './urlGuard';
import { BROWSER_PARTITION } from './partition';
import { TabRegistry } from './tabRegistry';
import { NavigationTracker } from './settle';
import type { AxSnapshot } from './snapshot';
import {
  resolveTarget, assertTypeAllowed, keyEventsFor,
  type DispatchAction, type TargetSpec, type WaitUntil,
} from './actions';
import WALKER_SOURCE from './injected/walker.js?raw';
import PW_REGISTRAR_SOURCE from './injected/pwRegistrar.js?raw';
import INTERACT_SOURCE from './injected/interact.js?raw';

/**
 * 内置浏览器。主进程持有 WebContentsView —— **不是 `<webview>`**：
 * `adoptWebContents` 在 Electron 41 上不存在，而 2026-09-08 spike 实测
 * WebContentsView 在宿主 renderer 重载后连页面 JS 状态一起完好存活。
 *
 * 渲染层只画一块空「舞台」div 并上报它的几何，网页由主进程定位过去。
 */

/** 浏览器自己的 cookie 罐子。**常量搬去了 `partition.ts`** —— `webRequestHub`
 *  要绑同一个 session，而它不该为一个字符串把整个本模块拖进依赖图。 */
const PARTITION = BROWSER_PARTITION;

/** 页面永远以这个逻辑宽度渲染。见 §2.3：不固定的话，侧栏一窄网页就切移动版，
 *  DOM 结构与可交互项全变，上一轮的快照编号整批作废。 */
const LOGICAL_WIDTH = 1280;

/**
 * 侧栏没打开时用的逻辑视口高度。
 *
 * spec §2.3 只固定宽度（决定响应式断点的是宽度，高度只改变一屏能看到多少），
 * 所以这个数不是判据、不参与任何语义判断 —— 但它必须有个值：没有屏幕上的那块地
 * 可以照抄时，也得给页面一个非零的视口，否则每个元素的 rect 都是 0×0。
 * 取 800 是因为 1280×800 是 16:10 笔记本的常见内容区，站点的懒加载与 sticky
 * 判据都按这个量级调过；配的 scale 是 1 —— 没有要去适配的物理宽度。
 */
const DEFAULT_VIEWPORT_HEIGHT = 800;

/** 导航时限。到点后 stop() 并把这次导航作废 —— 不然工具已经按 timeout 换了源，
 *  旧导航稍后还可能落进同一个标签。 */
const NAV_TIMEOUT_MS = 20_000;

/** walker 与 extract 都跑在这个隔离世界里。选一个不太可能撞车的号；
 *  页面看不见这里的任何东西，也覆写不了这里看到的 `document.querySelectorAll`。 */
export const WALKER_WORLD_ID = 31337;

type Stage = { epoch: number; visible: boolean; occluded: boolean; bounds: RectDip };

/** 一次 agent 驱动的窗口：哪一轮 run，它期间标过的标签，以及给人看的动作名。
 *  `action` 存在帧上而不是当参数逐层传：期间页面弹出来的新标签属于**同一次**动作，
 *  它们的 `markDriving` 拿到的必须是同一个字符串，不是 undefined。 */
type DrivingFrame = { runId: string; tabs: Set<string>; action?: string };

/**
 * 日志里的网址：只留 origin + pathname。
 *
 * 凭据在 userinfo 里（`https://svc:秘密密码@evil.com/` —— urlGuard 拒的正是这种形态），
 * token 常在 query 与 fragment 里。`log.ts` 的 `redactSecrets` 只按**键名**打码，
 * `url` 这个键不在名单里 —— 所以要在这里就把它变干净，否则第二批把闸的 `reason`
 * 修干净这件事被调用方原样抵消掉：闸拒得对，日志照样把明文密码写进磁盘。
 */
function logUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // 解析不出来就一个字都不回显：解析失败的串恰恰最可能是整条带着凭据的那种。
    return '(无法解析的网址)';
  }
}

/** walker 的返回值**就是**一份没有 snapshotId 的 AxSnapshot。 */
type WalkerOutput = Omit<AxSnapshot, 'snapshotId'>;

// ── 动作派发（spec §4.2）─────────────────────────────────────────────────────

/** `interact.js` 认得的目标形态。与 `ResolvedTarget` 一一对应，只是不带快照坐标。 */
type InteractTarget = { selector: string } | { nodeId: number };

type InteractRequest =
  | { op: 'measure' | 'focusSelect' | 'readValue'; target: InteractTarget }
  | { op: 'select'; target: InteractTarget; value: string }
  | { op: 'scroll'; direction: 'up' | 'down'; amount?: number };

/** `interact.js` 的返回值。它在网页里执行、类型系统管不到它，所以这里只声明形状。 */
type InteractResult = { ok: boolean; reason?: string; [k: string]: unknown };

/**
 * 拼出注进隔离世界的那段代码。
 *
 * **参数直接拼进调用里，不走 `window.__kydogTarget` 这类全局**：那要两次注入
 * （先设全局再执行），两次之间页面可以导航走 —— 第二次跑在新文档里读到的是上一次
 * 留下的目标；而且同一个标签上两次派发会互相覆盖。
 *
 * `JSON.stringify` 是唯一的插值方式（照 `extractExpression` 那批定的规矩）：
 * selector / value 都是字符串字面量，构造不出标识符逃逸。
 *
 * `notAfter` 是**主进程那道时限的同一个到点时刻**（`evalOn` 算的，两边不许各算各的）：
 * 注进去的这段是全仓唯一会**写页面**的一段，而时限到点取消不了它 —— 它自己认一次，
 * 过期就在碰页面之前退出来（见 `interact.js` 顶上那段实测）。
 */
function interactExpression(req: InteractRequest, notAfter: number): string {
  return `(${INTERACT_SOURCE})(${JSON.stringify({ ...req, notAfter })})`;
}

/** 轮询周期。**它是等待的粒度，不是任何判据** —— 判据是「条件成立了没有」这个页面事实。
 *
 *  取 100ms 的依据是量过的成本：隔离世界一次求值的往返实测 **0.14–0.16ms**
 *  （Electron 41.2.1，2026-09-08，50 次 8ms / 200 次 28ms）。按 100ms 一次，
 *  撑满 `WAIT_MAX_MS` 的 30 秒也只有 300 次求值 ≈ 45ms 渲染进程时间，
 *  而模型能感知的等待误差被压在 0.1 秒 —— 再密没有意义，再疏就开始把「等到了」
 *  拖成肉眼可见的延迟。 */
const WAIT_POLL_MS = 100;

/**
 * **单次页内求值的时限。**
 *
 * 它是兜底，不是性能策略：已知的两种「永不 settle」由 `hasRenderProcess` 那道谓词
 * 在注入之前挡掉（见它的实测表），这道时限兜的是**没量到的第三种**。
 *
 * 两头夹出来的数：
 *
 * · **下界 = 量过的最贵一次求值。** 我们注进页面最重的东西是 walker，它自己按
 *   「阻塞渲染进程 0.1 秒」定了 `MAX_WALKED = 8 万`（见 walker.js 那段预算）。
 *   本批复量（Electron 41.2.1，2026-09-09，主进程侧计时、含 IPC 往返）：
 *   2 万节点 8–23ms、8 万 33–42ms、**20 万节点封顶 101ms**。空载往返 200 次
 *   中位 0.086ms、最大 0.38ms。
 * · **它同时是「页面主线程可以卡多久」的上界**：求值排在页面自己的同步任务后面 ——
 *   实测忙循环 200 / 1000 / 3000ms 分别把一次求值推迟到 192 / 988 / 2988ms，
 *   一比一。所以时限定得太紧，等于把「页面正忙」误报成「页面死了」。
 * · **上界 = `NAV_TIMEOUT_MS`。** 一次导航我们最多等 20 秒，一次求值没有道理比
 *   整次导航还久 —— 直接引用同一个常量，两者不会漂开。相对实测最贵的那次
 *   （101ms）留了约 200 倍余量。
 */
export const PAGE_EVAL_TIMEOUT_MS = NAV_TIMEOUT_MS;

/**
 * 形状校验。walker 在页面里执行、类型系统管不到它，`as` 断言只是**声称**它长这样：
 * 页面在取快照那一刻导航走了，`executeJavaScriptInIsolatedWorld` 可能给回 undefined，
 * 之后 `renderSnapshot` 读 `s.nodes.length` 才抛 TypeError —— 那时错的位置离原因已经很远。
 */
function isWalkerOutput(raw: unknown): raw is WalkerOutput {
  if (typeof raw !== 'object' || raw === null) return false;
  const o = raw as Record<string, unknown>;
  const c = o.collection as Record<string, unknown> | undefined;
  return typeof o.generation === 'string'
    && typeof o.url === 'string'
    && typeof o.title === 'string'
    && Array.isArray(o.nodes)
    && typeof o.iframes === 'number'
    && typeof c === 'object' && c !== null
    && typeof c.truncated === 'boolean' && typeof c.returned === 'number';
}

export class BrowserService {
  private win: BrowserWindow | null = null;
  private readonly registry = new TabRegistry();
  private readonly views = new Map<string, WebContentsView>();
  private readonly snapshots = new Map<string, AxSnapshot>();
  private readonly navs = new Map<string, NavigationTracker>();
  /** 每个标签一条串行队列。跨标签仍然并行。 */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** CDP 已经不可用的标签（attach 失败，或者 DevTools 打开把我们顶掉了）。
   *  只用来「同一件事只记一条日志」，判据本身走 `debugger.isAttached()`。 */
  private readonly cdpGone = new Set<string>();
  /** 正在进行的 agent 驱动窗口，一次一帧（可以同时有好几帧，各在各的标签上）。 */
  private readonly drivingFrames: DrivingFrame[] = [];
  /** 「这个标签没了」的订阅者。见 `onTabDestroyed`。 */
  private readonly tabGone = new Set<(tabId: string) => void>();
  private stage: Stage | null = null;
  private sessionWired = false;

  // ── 装配 ────────────────────────────────────────────────────────────────

  attach(win: BrowserWindow): void {
    this.win = win;
    // 窗口销毁之后这个引用就是野的：下一次 createTab 会往一个已经析构的 contentView 上
    // addChildView。这里只负责把引用清干净（那之后 createTab 报「还没装配到窗口上」）。
    // **窗口这一路刻意不顺手 disposeAll**（裁决 2.3）：收摊统一在 `before-quit` 做一次
    // （`mainWiring.ts` 的 `installBrowserQuitWiring`），`mainWiring.test.ts` 有一条专门
    // 钉「窗口这一路一次都不 disposeAll」。
    win.once('closed', () => { if (this.win === win) this.win = null; });
    this.wireSession();
  }

  private get sess(): Session {
    return session.fromPartition(PARTITION);
  }

  /**
   * session 级的一次性装配。**这里装的都是 setter（「设置」不是「添加」）**，
   * 所以只能装一次：早先 permission handler 装在 createTab 里，16 个标签重设 16 次，
   * 当前无害，但那一族接口是「最后一个赢」，多一个调用方就会静默互顶。
   *
   * 下载在这一期一律取消（§5.4）。**但要如实报成 download**：报成 timeout 的话，
   * agent 打一个 PDF 直链会以为源不可达并换源 —— 而它其实找到了文件。
   */
  private wireSession(): void {
    if (this.sessionWired) return;
    this.sessionWired = true;
    const sess = this.sess;

    // §5.1 的硬化契约写的是「permission request / **check** 一律拒绝」，两条路都要堵：
    // 只装 request 的话，页面走同步权限检查那条路（navigator.permissions.query 等）
    // 拿到的是 Electron 的默认答案，与我们声明的策略不一致。
    sess.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    sess.setPermissionCheckHandler(() => false);

    sess.on('will-download', (event, item, wc) => {
      event.preventDefault();
      const tabId = this.tabIdOf(wc);
      const url = item.getURL();
      if (tabId) {
        // `getURLChain()` 含重定向的完整链，`chain[0]` 是最初请求的那个 ——
        // doi.org → 出版社 → PDF 这条路只有靠它才能与本次导航对得上。
        // 对不上就不定论（状态机自己判），一个广告 frame 自发拉起的下载不许冒充终态。
        this.navs.get(tabId)?.onWillDownload(url, item.getMimeType(), item.getFilename(), item.getURLChain());
      }
      logger.info('browser.download', '按策略取消下载', { url: logUrl(url), tabId });
    });
  }

  private tabIdOf(wc: WebContents | undefined): string | null {
    if (!wc) return null;
    for (const [id, v] of this.views) if (v.webContents === wc) return id;
    return null;
  }

  // ── 串行队列（spec §4.4）────────────────────────────────────────────────

  /**
   * 同一个标签的 open / navControl / 动作派发排队执行。**跨标签仍然并行。**
   *
   * pi 的工具带 `executionMode: 'sequential'`，但那只约束 pi 那一侧；渲染层发来的
   * `browser.*` RPC 走的是另一条路。两条路同时动一个标签时，一次导航的事件会被
   * 另一次调用消费掉 —— 那种错很难在日志里认出来。
   *
   * **公开是给 Task 4 的**：动作派发那个入口建起来之后必须走这里，不要另开一条路。
   */
  enqueue<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(tabId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // **队尾这一句同时做两件事，别把因果记反：**
    //  · 它把 rejection 吞掉 —— 于是存进 `queues` 的 `prev` **永不 reject**，
    //    一次失败不会让这个标签的队列卡住。挡住卡死的是这一句，不是上面的
    //    `prev.then(fn, fn)`；正因为 `prev` 永不 reject，那里的第二个 `fn` 在当前
    //    接线下**不可达**（去掉它是等价变异，一条用例都不红）。两者是防御纵深。
    //  · 队列里存的不再是一个已经 rejected 的 promise。调用方（弹窗那条路、
    //    以及将来任何 `void enqueue(...)`）可能一个 handler 都不挂，那就是一次
    //    未处理 rejection，Node ≥15 直接上抛成 uncaughtException。
    this.queues.set(tabId, next.then(() => {}, () => {}));
    return next;
  }

  // ── agent 驱动窗口 ──────────────────────────────────────────────────────

  /**
   * 把一次 agent 驱动的操作圈起来：开始前置 `isAgentActive`，**结束时无论成败都清**。
   *
   * 漏了清的后果不是「少标一次」，是**卡在 true**：`disposeForRun(runId)` 只按
   * `ownerRunId === runId` 匹配，一个标签被标成某个已经 settle 过的 run，之后
   * 再没有任何一次回收会命中它 —— 徽标永远显示 agent、侧栏永远挂着「保留」按钮。
   *
   * 窗口内**新建的标签**（页面 `window.open` 转成的新标签）一并标上并一起清：
   * 不标的话 t1 → t2 → t3 这条链上 t3 会被判成用户的，`agent_settled` 不回收。
   *
   * 公开是给 Task 4 用的：`browser_act` 的 execute 要把整批动作包进来。
   */
  async withAgentDriving<T>(
    tabId: string, runId: string | null, fn: () => Promise<T>, action?: string,
  ): Promise<T> {
    if (runId === null) return fn();   // 用户自己的操作，不置位
    // **一次驱动一帧，各清各的。** 队列是按标签串的，所以两次 agent 驱动的操作
    // 完全可以同时在两个标签上跑；共用一个 Set + 一个 drivingRunId 的话，
    // 先结束的那一次会把另一次的标志一起清掉，而它还在跑 —— 那一刻页面弹出来的
    // 新标签就会被判成用户的，回合结束不回收。
    const frame: DrivingFrame = { runId, tabs: new Set<string>(), action };
    this.drivingFrames.push(frame);
    this.markDriving(frame, tabId);
    try {
      return await fn();
    } finally {
      const i = this.drivingFrames.indexOf(frame);
      if (i !== -1) this.drivingFrames.splice(i, 1);
      for (const id of frame.tabs) {
        // 还有别的驱动帧握着这个标签就别清 —— 清了就等于替它宣布结束。
        if (this.drivingFrames.some((f) => f.tabs.has(id))) continue;
        if (this.registry.has(id)) this.registry.setAgentActive(id, false);
        // 熄灯放在 `has` 判断**外面**：这一句要与上面的 `markDriving` 严格配对，
        // 别再多一个「有没有」的条件去决定发不发。
        //
        // **驱动期间标签被销毁的那一支走不到这里**（实测，`browserService.test.ts`
        // 「驱动期间标签被销毁」那条钉住）：`destroyView` 里有一句
        // `for (const f of this.drivingFrames) f.tabs.delete(id)`，标签早在收尾之前
        // 就从帧里摘掉了，这个循环压根不会遍历到它。**那一支的清除信号是
        // `browser.tabsChanged` 里它已经不在** —— 渲染层的 `applyAgentFocus` 表
        // 按标签清单剪枝，两者合起来才穷尽。别为它在 `destroyView` 里再开第三个
        // 发送点：那会让「谁在发这条 topic」重新散开。
        this.emitAgentFocus(id, false);
      }
    }
  }

  /**
   * 这个标签此刻归哪一轮 run 在驱动。**按标签找，不是拿「最新那一帧」顶替** ——
   * 两次驱动同时在跑时，A 的标签弹出来的新标签必须归 A，不能归恰好压在栈顶的 B，
   * 否则 B settle 时会把 A 的页面一起收走（那是「用户的页面无声消失」那条）。
   */
  private drivingRunIdOf(tabId: string): string | null {
    for (let i = this.drivingFrames.length - 1; i >= 0; i--) {
      if (this.drivingFrames[i].tabs.has(tabId)) return this.drivingFrames[i].runId;
    }
    return null;
  }

  private frameOf(runId: string): DrivingFrame | null {
    for (let i = this.drivingFrames.length - 1; i >= 0; i--) {
      if (this.drivingFrames[i].runId === runId) return this.drivingFrames[i];
    }
    return null;
  }

  private markDriving(frame: DrivingFrame, tabId: string): void {
    if (!this.registry.has(tabId)) return;
    this.registry.setAgentActive(tabId, true);
    frame.tabs.add(tabId);
    this.emitAgentFocus(tabId, true, frame.action);
  }

  /**
   * `browser.agentFocus` 的**唯一发送点**（`markDriving` 与 `withAgentDriving` 的
   * `finally` 各调一次，见 `EVENT_TOPICS` 的三方对账）。
   *
   * 为什么要单开一条广播而不搭 `browser.tabsChanged` 的顺风车：`setAgentActive`
   * **刻意不推 revision**（推一帧内容相同的状态出去，会让渲染层「按 revision 去旧」
   * 退化成「永远接受最新一帧」），而 `toState()` 又把 `isAgentActive` 整个抹掉 ——
   * 那条广播在类型上和运行时都带不出这个信号。
   *
   * **渲染层那一侧是一个集合，不是计数器**：嵌套驱动时（帧 A、帧 B 先后标住同一个
   * 标签）会发两次 `true` 只发一次 `false`，集合语义下收敛正确，计数器语义下不会。
   */
  private emitAgentFocus(tabId: string, active: boolean, action?: string): void {
    broadcaster.emit('browser.agentFocus', { tabId, active, action });
  }

  // ── 状态与几何 ──────────────────────────────────────────────────────────

  /** 渲染进程每次 bootstrap 调一次。旧 epoch 的 syncView 一律丢弃。 */
  newEpoch(): number {
    const e = this.registry.newEpoch();
    this.emit();
    return e;
  }

  getState(): BrowserState { return this.registry.toState(); }

  private emit(): void {
    // **广播里不许带 epoch**（`BrowserTabsSnapshot` 那段注释写的就是这里）：
    // 类型只挡住「读」，`emit(topic, state)` 传一份 BrowserState 在结构类型下照样
    // 编译得过。epoch 这道闸的全部意义是「只有 getState 的调用方才知道自己的代号」——
    // 广播出去，正在被替换掉的旧 renderer 就能用新 epoch 上报旧布局的 bounds，
    // 主进程判为当前并接受，view 定位到旧几何，全程不报错。
    const { epoch: _epoch, ...snapshot } = this.registry.toState();
    broadcaster.emit('browser.tabsChanged', snapshot);
  }

  syncView(args: Stage): void {
    // 过期上报直接丢。epoch 由主进程签发，不用渲染层自己数的计数器 ——
    // 组件重载后本地计数从同一个初值重新开始，分不出新旧 mount。
    if (args.epoch !== this.registry.toState().epoch) return;
    this.stage = args;
    this.applyLayout();
  }

  /**
   * 渲染进程开始重载或已经没了的时候要先把所有 view 藏起来 ——
   * 那两个时刻拿不到可靠的最后一次 syncView，不先藏，原生层会继续盖在新 UI 上。
   *
   * 藏起来**不影响页面怎么渲染**：视口照旧下发（§B），agent 手里的快照与坐标
   * 不会因为用户收了侧栏就失效。
   */
  hideAll(): void {
    this.stage = null;
    this.applyLayout();
  }

  private applyLayout(): void {
    const st = this.stage;
    const activeId = this.registry.toState().activeTabId;
    for (const [id, view] of this.views) {
      const isActive = id === activeId;
      // visible 与 occluded 是两件事：侧栏关闭不是「被浮层盖住」的同义词，
      // 但对原生层来说两者的处置相同 —— 让开。
      const show = !!st && st.visible && !st.occluded && isActive;
      view.setVisible(show);
      if (st) view.setBounds(st.bounds);
      // **每一个标签都下发，不只活动的那个**：后台标签留着上一次的 scale / height 时，
      // agent 对它取的快照（坐标是视口内的 CSS 像素）与它实际的渲染尺寸对不上。
      // **也不看 stage 在不在**：见 applyViewport。
      void this.applyViewport(id, st ? st.bounds : null);
    }
  }

  /**
   * 固定逻辑视口。用 CDP 的 Emulation 而不是 setZoomFactor —— 后者按 host 存在
   * session 的 HostZoomMap 里：跨 host 导航就失效，还会被用户手动缩放污染，
   * 且污染跨 WebContentsView 实例存活（2026-09-08 spike 实测）。
   * override 跨 4 个 host 5 次导航恒 1280，且免疫手动 zoom。
   *
   * **`bounds` 为 null（侧栏没打开、或者刚 hideAll）时照样下发。**
   * 浏览器的能力与侧栏的可见性完全解耦（§B，项目负责人拍板）：
   * `setDeviceMetricsOverride` 设的是**渲染**视口，与这个 view 在屏幕上多大、
   * 可不可见是两回事；stage 的 bounds 只决定「给人看的那一块在哪」。
   * 不下发的话，新建的 view 从没被给过 bounds、`clientWidth` 是 0，**百分比 / 弹性
   * 布局的元素塌到 min-content**（实测 50% 宽的 button 量到 16×36、40% 宽的 input 量到
   * 8×30），被 walker 的 `visible()` 滤掉；**固定 px 宽的元素不受影响**（120px 的 div
   * 照样是 120×20、照样被采到）。真实站点的检索框、按钮绝大多数属于前一类，所以
   * 一份快照下来基本是空的，工具返回「这一份快照里没有可交互元素」—— 模型判定这个源
   * 是空页面并换源，全程没有任何错误。
   * （需求书 §B1 写的是「每个元素的 rect 都是 0×0」，**实测比那个窄**，见上；
   * 结论不变。2026-09-08 实测：零 bounds / setVisible(false) / 从没 setBounds /
   * 压根没加进窗口四种情形下，加了 override 之后 innerWidth / clientWidth 都是 1280，
   * 50% 宽的元素量到 640，walker 采到的节点几何与一个正常可见的 view 逐字相同。
   * 数据见 task-2f-report.md §B3，评审独立复现过一次。）
   *
   * **返回 promise，且永不 reject**：调用方要么 `void` 掉（布局那条路），要么 await
   * （取快照之前那条路 —— walker 量的就是这个视口，两件事必须有先后）。
   */
  private applyViewport(tabId: string, bounds: RectDip | null): Promise<void> {
    const view = this.views.get(tabId);
    if (!view || view.webContents.isDestroyed()) return Promise.resolve();
    const wc = view.webContents;
    const dbg = wc.debugger;
    // 没 attach 上就别发：attach 失败过、或者 DevTools 打开把我们顶掉了。
    // 这是协议层现成的事实，不是「记着上次失败过」那种代偿。
    if (!dbg.isAttached()) return Promise.resolve();
    // **还没有渲染进程时一个字都不许发。** 2026-09-08 实测：一个全新的、还没 load 过
    // 任何页面的 WebContentsView 上发 Emulation.setDeviceMetricsOverride，
    // Electron 41.2.1 的主进程直接 **SIGSEGV**（复现 3/3；loadURL 已调用但还没提交时
    // 则是永不 resolve）。不是 reject，接不住 —— 只能不发。
    // `getOSProcessId()` 是「关联的渲染进程的 pid」，没有渲染进程时是 0：协议层的事实。
    // 页面崩过一次之后它也回到 0，所以这道闸同时挡住了「对着已死的 target 发命令」。
    if (wc.getOSProcessId() === 0) return Promise.resolve();
    const w = bounds ? Math.max(1, Math.round(bounds.width)) : LOGICAL_WIDTH;
    const scale = w / LOGICAL_WIDTH;
    const height = bounds ? Math.max(1, Math.round(bounds.height / scale)) : DEFAULT_VIEWPORT_HEIGHT;
    try {
      // **rejection 必须接住**：sendCommand 返回的是 promise，外面的 try/catch 只挡
      // 同步抛出。Node ≥15 把未处理 rejection 上抛成 uncaughtException —— 那是
      // 「主进程弹一个 JavaScript error 对话框并退出」。
      // 还够得着这里的是「命令在途时 detach 了」那一种（destroyView 先 detach，
      // 在途的 override 随即以 "Debugger is not attached to the target" reject）。
      // **崩溃那一种够不着**：上面那道 pid 闸在发出去之前就让开了 —— 实测那不是
      // 一个 reject，是段错误，`.catch` 接不住（见 task-2f-report.md §B3）。
      return dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: LOGICAL_WIDTH, height, deviceScaleFactor: 0, mobile: false, scale,
      }).then(() => {}, (err: unknown) => {
        logger.warn('browser.viewport', '设置逻辑视口失败', { tabId, err: String(err) });
      });
    } catch (err) {
      logger.warn('browser.viewport', '设置逻辑视口失败', { tabId, err: String(err) });
      return Promise.resolve();
    }
  }

  /** CDP 这条路断了。同一个标签只记一条 —— 每次 applyViewport 都记一条会把日志刷爆。 */
  private cdpLost(tabId: string, why: string): void {
    if (this.cdpGone.has(tabId)) return;
    this.cdpGone.add(tabId);
    logger.warn('browser.cdp', 'CDP 断开，逻辑视口与按键派发都会失效', { tabId, why });
  }

  // ── 标签生命周期 ────────────────────────────────────────────────────────

  private createTab(url: string, ownerRunId: string | null): string {
    if (!this.win) throw new KydogError('browser.no_tab', '浏览器还没有装配到窗口上');
    const id = `tab_${randomUUID().slice(0, 8)}`;
    this.registry.create(id, { ownerRunId, url });

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        // 远程页面的硬化契约显式写死，不依赖默认值 —— 这个 partition 里装着
        // 用户的机构登录态，一条都不能漏。
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    this.views.set(id, view);
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this.wireView(id, view);
    try { view.webContents.debugger.attach('1.3'); }
    catch (err) { this.cdpLost(id, `attach 失败：${String(err)}`); }
    // 这一句现在必然是空转（新 view 还没有渲染进程，applyViewport 自己让开），
    // 留着是因为「每建一个标签就给它一次视口」这条规则不该有例外 ——
    // 真正让新标签拿到 1280 的是 dom-ready 与取快照前那两次。
    void this.applyViewport(id, this.stage?.bounds ?? null);
    // agent 驱动期间页面弹出来的标签也归 agent（spec §5.1：按源标签当时的状态定），
    // 并且**加进开它那一轮自己的帧**：那一轮结束时连它一起清、一起回收。
    const frame = ownerRunId === null ? null : this.frameOf(ownerRunId);
    if (frame) this.markDriving(frame, id);
    this.emit();
    return id;
  }

  private wireView(id: string, view: WebContentsView): void {
    const wc = view.webContents;

    // 权限一律拒绝的两个 handler 装在 session 上（wireSession），不在这里 ——
    // 它们是 session 级的 setter，每个标签重设一次是「最后一个赢」。

    // target=_blank 不能被吞掉 —— 直接丢弃的话用户点一个新窗口链接会「什么都不发生」，
    // 而 CNKI 站内大量 _blank。deny 原生新窗口，改成在侧栏里新开一个标签。
    wc.setWindowOpenHandler(({ url }) => {
      const v = checkUrl(url);
      if (!v.ok) {
        logger.warn('browser.popup', '被 URL 闸拦下', { url: logUrl(url), reason: v.reason });
        return { action: 'deny' };
      }
      let newId: string;
      try {
        // 归属**按源标签当时的状态定**（spec §5.1），不是拿 ownerRunId 当替身：
        // agent 驱动一个用户标签时弹出来的新标签也归这一轮 run，回合结束要一起回收。
        // 这一句必须留在 try 里：`isAgentActiveOf` 在标签已被回收时抛 no_tab，
        // 而 handler 里抛出去会变成 Electron 的未捕获错误。
        newId = this.createTab(url, this.registry.isAgentActiveOf(id) ? this.drivingRunIdOf(id) : null);
      } catch (err) {
        // 撞上标签上限时不能把异常抛回 Electron 的 handler。如实记一条，链接不开。
        logger.warn('browser.popup', '新标签打开失败', { url: logUrl(url), err: String(err) });
        return { action: 'deny' };
      }
      // **这条路要走完整的「建标签 → 布局 → 视口 → 导航观测」**：早先只 emit 不 layout、
      // 也不走 navigate，于是新页面在一个看不见的 0×0 view 里加载、拿不到 viewport
      // override，也没有任何导航观测。走同一把队列，不在队列外单独开一条路。
      this.applyLayout();
      void this.enqueue(newId, () => this.navigate(newId, (w) => w.loadURL(url), url))
        .catch((err: unknown) => {
          logger.warn('browser.popup', '新标签导航失败', { url: logUrl(url), err: String(err) });
        });
      return { action: 'deny' };
    });

    // URL 闸装在每一条入口上，不只是 browser.open 的参数：点链接、表单提交、
    // 服务端重定向、子 frame 都要过同一个判据。
    //
    // 拦下的那一刻就告诉观测（`onBlocked`）：我们明确知道发生了什么，不该让它
    // 只落下一个 ERR_ABORTED、再等满 20 秒报「不知道发生了什么」。
    // `isMainFrame` 从 details 上取 —— 广告 iframe 302 到内网地址被拦是常态，
    // 让它替整页定论，模型会以为文章没打开而换源（状态机自己挡，但别传死 true）。
    //
    // **三条共用一个 handler，不去重 —— 因为实测根本没有重复。** electron.d.ts:17079
    // 只说 `will-frame-navigate` 主 frame 也发，看上去与 `will-navigate` 在主 frame 上
    // 重叠、会报两遍；2026-09-08 实测（Electron 41.2.1，页面改 location 与真的点 <a>
    // 各一次）**不是那样**：两条由同一个 NavigationThrottle 发出，
    // `will-frame-navigate` **先发**，它一旦 `preventDefault()`，throttle 当场 CANCEL，
    // `will-navigate` **根本不发**。被拦的主 frame 导航只会走到这里一次。
    // 反过来说：**这条 handler 不能只挂给子 frame** —— 主 frame 被拦时它是唯一
    // 走得到的那条，把主 frame 那份挪去 `will-navigate` 等于 `onBlocked` 永远收不到，
    // 那次导航要跑满 20 秒才报 timeout。数据见 task-2f-report.md 的「修复记」。
    const guardNav = (
      e: { preventDefault: () => void }, url: string, isMainFrame: boolean,
    ) => {
      const v = checkUrl(url);
      if (v.ok) return;
      e.preventDefault();
      this.navs.get(id)?.onBlocked(v, isMainFrame);
      logger.warn('browser.nav', '被 URL 闸拦下', { url: logUrl(url), reason: v.reason });
    };
    wc.on('will-navigate', (details) => guardNav(details, details.url, details.isMainFrame));
    wc.on('will-redirect', (details) => guardNav(details, details.url, details.isMainFrame));
    wc.on('will-frame-navigate', (details) => guardNav(details, details.url, details.isMainFrame));

    // **不定论**，只喂两件事：下载的关联集合、以及「跨文档导航在途」这个窗口
    // （isSameDocument 是协议层现成的信号，丢了它状态机就会把旧文档的 pushState
    // 当成本次导航的结果）。
    wc.on('did-start-navigation', (details) => {
      this.navs.get(id)?.onDidStartNavigation(details.url, details.isMainFrame, details.isSameDocument);
    });

    wc.on('did-navigate', (_e, url, httpResponseCode) => {
      // 403 走的就是这条路：它是一次**成功**的导航，did-fail-load 不触发。
      this.navs.get(id)?.onDidNavigate(url, httpResponseCode);
      this.snapshots.delete(id);   // 页面换了，旧快照的编号一律作废
      this.syncTabMeta(id);
    });

    // 同文档导航（hash 跳转 / pushState / 站内路由）既不触发 did-navigate 也不触发
    // did-fail-load —— 没有这条，`browser_open('https://x/p#sec2')` 会一个事件都收不到，
    // 跑满整个时限再报 timeout，而那次导航其实瞬间就成了。
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      this.navs.get(id)?.onDidNavigateInPage(url, isMainFrame);
      if (!isMainFrame) return;
      // **同文档也要作废快照编号**：AxNode 的 x/y/w/h 是**视口内**的 CSS 像素，
      // hash 跳转会滚动页面、站内路由会换内容，而 resolveTarget 只在 snapshotId
      // 对不上时才报错 —— 不删就是「编号还在、指向的元素已经变了」：不报错，只是点错东西。
      this.snapshots.delete(id);
      this.syncTabMeta(id);
    });

    wc.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
      this.navs.get(id)?.onDidFailLoad(errorCode, errorDescription, isMainFrame);
    });
    wc.on('did-start-loading', () => this.syncTabMeta(id));
    wc.on('did-stop-loading', () => this.syncTabMeta(id));
    wc.on('page-title-updated', () => this.syncTabMeta(id));

    wc.on('dom-ready', () => {
      // 常驻密码登记（见 injected/pwRegistrar.js）。**每个新文档都要重跑一次**：
      // 隔离世界跟着文档一起重置，上一份 WeakSet 已经不在了。
      this.registerPasswordFields(id);
      // 这是**新标签第一次真正拿到 1280** 的地方：新建时还没有渲染进程，
      // applyViewport 只能让开（见那里的实测注释）。
      void this.applyViewport(id, this.stage?.bounds ?? null);
    });

    wc.on('render-process-gone', (_e, details) => {
      logger.warn('browser.crash', '页面进程没了', { id, reason: details.reason });
      // 在途导航要当场定论。不这样的话一次崩溃要挂满整个超时窗口，
      // 而且报出来的是 timeout —— 可我们明明知道发生了什么。
      this.navs.get(id)?.onCrashed(details.reason);
      this.syncTabMeta(id);
    });

    // DevTools 一打开就会顶掉我们的 attach（同一个 target 只能有一个 debugger）。
    // 一个都不挂的话，之后每次 override 都静默失败 —— 而且是以未处理 rejection
    // 的形式炸掉主进程。挂上：记一条，后续 applyViewport 靠 isAttached() 自己让开。
    wc.debugger.on('detach', (_e, reason) => this.cdpLost(id, `detach：${reason}`));
  }

  /**
   * 把常驻密码登记装进这个文档的隔离世界。
   *
   * 它必须与 walker 跑在**同一个世界 id** 里：`world.pw` 是同一份 WeakSet，
   * 各写各的等于没写。失败只记一条日志 —— 页面在 dom-ready 与执行之间导航走了
   * 是常态，而这不该让任何一次工具调用失败。
   */
  private registerPasswordFields(tabId: string): void {
    const wc = this.webContentsOf(tabId);
    if (!wc) return;
    // 走 evalOn 是为了那道时限：不罩的话，一次永不 settle 的求值留下一个永远挂着的
    // promise（`.catch` 也不会跑），而这条路每个 dom-ready 都走一次。
    void this.evalOn(wc, tabId, PW_REGISTRAR_SOURCE)
      .catch((err: unknown) => {
        logger.warn('browser.password', '密码登记没能装上', { tabId, err: String(err) });
      });
  }

  private syncTabMeta(id: string): void {
    const view = this.views.get(id);
    if (!view || view.webContents.isDestroyed() || !this.registry.has(id)) return;
    const wc = view.webContents;
    const before = this.registry.toState().revision;
    this.registry.update(id, {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
    // **revision 真的推进了才广播。** 站点拿 document.title 做跑马灯（学术站点的
    // 「加载中…」动画常见）时，page-title-updated 每秒来若干次，每次都广播一份
    // 全量 BrowserState 而 revision 不变 —— 渲染层「按 revision 去旧」对这些帧
    // 完全不起作用，等于拿掉了那道闸。
    if (this.registry.toState().revision !== before) this.emit();
  }

  private destroyView(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    this.snapshots.delete(id);
    // 在途的观测当场定论。不这样的话 navigate() 还卡在 race 上白等满 20 秒，
    // 再报一个「我们不知道发生了什么」—— 而我们明确知道：标签被关了。
    this.navs.get(id)?.onCancelled();
    this.navs.delete(id);
    this.queues.delete(id);      // 否则 queues 只增不减
    this.cdpGone.delete(id);
    for (const f of this.drivingFrames) f.tabs.delete(id);
    try { if (!view.webContents.isDestroyed()) view.webContents.debugger.detach(); } catch { /* 已经断开 */ }
    try { this.win?.contentView.removeChildView(view); } catch { /* 窗口已经没了 */ }
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* 同上 */ }
    // **最后一句**：上面那些清理必须先做完 —— 订阅者会在回调里回头问这个标签
    // 还在不在，问到一个半拆的状态就成了「我看它还在」。
    for (const fn of [...this.tabGone]) {
      // 一个订阅者抛异常不能让别的订阅者收不到通知，更不能让 close() / disposeAll()
      // 半路停下来（那会留下没有账本记录、却还在跑页面的 view）。
      try { fn(id); } catch (err) { logger.warn('browser.tab', '标签销毁的订阅者抛了异常', { id, err: String(err) }); }
    }
  }

  /**
   * 订阅「这个标签没了」。**销毁是唯一的清除时机**，而 `destroyView` 有三个调用方
   * （`close` / `disposeForRun` / `disposeAll`）—— 订阅者不该去逐个盯它们。
   *
   * 第一个订阅者是 `loginFlow`：它按标签存着「本轮已经填过一次凭据」和那次填充
   * 的 webRequest 观测者，两样都只在标签销毁时清（见 `loginFlow.ts` 那张表）。
   *
   * **反过来的方向刻意没有**（本模块不 import loginFlow）：那会是一条 import 环，
   * 而 `browserService` 是几乎所有浏览器模块的叶子。
   */
  onTabDestroyed(fn: (tabId: string) => void): () => void {
    this.tabGone.add(fn);
    return () => { this.tabGone.delete(fn); };
  }

  // ── 对外操作 ────────────────────────────────────────────────────────────

  async open(args: { url: string; tabId?: string; ownerRunId?: string | null }): Promise<{ tabId: string; nav: NavigationObservation }> {
    const url = assertAllowedUrl(args.url).toString();
    if (args.tabId && !this.registry.has(args.tabId)) {
      throw new KydogError('browser.no_tab', `没有这个标签页：${args.tabId}`);
    }
    const tabId = args.tabId ?? this.createTab(url, args.ownerRunId ?? null);
    // createTab 默认**不抢**活动标签（页面弹窗不许决定用户看什么）；
    // browser_open 这条路是显式要求切过去的，所以这里补一句。
    this.registry.activate(tabId);
    this.applyLayout();
    const nav = await this.enqueue(tabId, () => this.withAgentDriving(
      tabId, args.ownerRunId ?? null,
      // 目标 URL 传的是**已经规范化**的那份：它进下载的关联集合，
      // 一个 PDF 直链要靠它才能被认成本次导航的终态。
      () => this.navigate(tabId, (wc) => wc.loadURL(url), url),
      '打开网页',
    ));
    return { tabId, nav };
  }

  /** 所有会引发主 frame 导航的操作都经过这里 —— 观测结果要挂在**每一次**这样的操作上，
   *  不只是 browser.open：Scholar 的 403 出现在点提交按钮之后。 */
  private async navigate(
    tabId: string,
    act: (wc: WebContents) => Promise<unknown> | void,
    targetUrl: string | null,
  ): Promise<NavigationObservation> {
    const view = this.views.get(tabId);
    if (!view) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    const wc = view.webContents;

    // 换 tracker **之前**先告诉旧的它被接替了：它自己的收尾会 stop()，
    // 掐掉的正是接替它的这一次导航。两次导航都错，日志里还看不出原因。
    this.navs.get(tabId)?.onSuperseded();
    const tracker = new NavigationTracker(randomUUID(), targetUrl);
    this.navs.set(tabId, tracker);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((r) => { timer = setTimeout(r, NAV_TIMEOUT_MS); });
    // **act 只负责触发，不等它返回。** `loadURL` 的 promise 要等 did-finish-load 才
    // resolve（electron.d.ts 明写），一个永不返回的 <script src> 就能让它永远挂着 ——
    // 时限罩在它**后面**等于没有时限，`browser_open` 这个工具调用会无限挂起。
    // 结论一律以事件为准，它的 rejection 只可能重复事件已经说过的话，接住丢掉。
    try {
      void Promise.resolve(act(wc)).catch(() => { /* 结论以事件为准 */ });
    } catch { /* 同步抛出（goBack 之类）也一样，以事件为准 */ }
    await Promise.race([tracker.settledPromise, deadline]);
    if (timer) clearTimeout(timer);
    // 到点了就收尾。**停不停由 tracker 判**：被取代的观测绝不能 stop（掐掉的正是
    // 接替它的那一次导航），已经成了的也不该 stop（会打断还在加载的子资源）。
    // 判断与动作在同一步，调用方没有记错的余地，「先看 settled 再动手」那点竞态
    // 也一并消掉。停下来才作废这次导航：不然工具已经按 timeout 换了源，旧导航
    // 稍后还可能落进同一个标签，页面内容与 agent 以为的状态就对不上了。
    tracker.onTimeout(() => { try { wc.stop(); } catch { /* 已经没了 */ } });
    if (this.navs.get(tabId) === tracker) this.navs.delete(tabId);
    this.syncTabMeta(tabId);
    // **await**：这次导航提交之后渲染进程已经在了，这一发才是真的落得下去；
    // 而调用方紧接着就会取快照，walker 量的正是这个视口。
    await this.applyViewport(tabId, this.stage?.bounds ?? null);
    return tracker.observation()!;
  }

  close(tabId: string): void { this.registry.close(tabId); this.destroyView(tabId); this.applyLayout(); this.emit(); }
  keep(tabId: string): void { this.registry.keep(tabId); this.emit(); }
  activate(tabId: string): void { this.registry.activate(tabId); this.applyLayout(); this.emit(); }

  async navControl(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    const view = this.views.get(tabId);
    if (!view) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    const wc = view.webContents;
    if (action === 'stop') {
      // **停止不排队。** 它不是一次导航，也不消费任何导航事件 —— 它要打断的正是
      // 队首那一次。排在后面的话，用户按下停止之后最长要等一个完整的 20 秒时限
      // 才轮到它执行，那时该停的早就停了：一个看起来没反应的按钮。
      wc.stop();
      this.syncTabMeta(tabId);
      return;
    }
    // 目标 URL 要在导航发生**之前**算：goBack 之后 activeIndex 就变了。
    const target = this.historyTarget(wc, action);
    await this.enqueue(tabId, () => this.navigate(tabId, (w) => {
      const h = w.navigationHistory;
      if (action === 'back' && h.canGoBack()) h.goBack();
      else if (action === 'forward' && h.canGoForward()) h.goForward();
      else if (action === 'reload') w.reload();
    }, target));
  }

  /** 这次 back / forward / reload 要去哪。给 NavigationTracker 当下载的关联依据 ——
   *  拿不到就给 null（状态机自己会去等 did-start-navigation），不猜。 */
  private historyTarget(wc: WebContents, action: 'back' | 'forward' | 'reload'): string | null {
    try {
      if (action === 'reload') return wc.getURL() || null;
      const h = wc.navigationHistory;
      const i = h.getActiveIndex() + (action === 'back' ? -1 : 1);
      if (i < 0 || i >= h.length()) return null;
      return h.getEntryAtIndex(i)?.url ?? null;
    } catch { return null; }
  }

  /** 回收某一轮 agent 开的标签。**三个触发点**，都在 `AgentService` 里、都读同一个
   *  `bound.runId`（见那段注释），一轮 run 从哪个出口结束就由哪一处收尾：
   *   · `agent_settled` —— 正常收尾。**挂在它上面，不是 `agent_end`**：pi 在 agent_end
   *     之后仍可能自动重试，那时标签还属于同一轮 KyDog run；
   *   · `send()` 的 catch —— `prompt()` reject（没配 key / OAuth 过期…）时 pi 不补发
   *     `agent_settled`，本轮在那里就地落地；
   *   · `dispose()` —— session 一拆就永远等不到 settle，最后回收一次。
   *  **幂等**：标签已被摘走时 `doomed` 为空，直接返回。 */
  disposeForRun(runId: string): void {
    const gone = this.registry.disposeForRun(runId);
    for (const id of gone) this.destroyView(id);
    if (gone.length) { this.applyLayout(); this.emit(); }
  }

  /** 退出时收摊。**幂等**：跑第二遍时账本已经空了，什么都不做。
   *  唯一的调用方是 `mainWiring.ts` 挂在 `app.on('before-quit')` 上的那一处
   *  （`main.ts` 顶层的 `installBrowserQuitWiring`）。窗口 `closed` 不走这里，见 `attach`。 */
  disposeAll(): void {
    const ids = this.registry.allIds();
    for (const id of ids) { this.registry.close(id); this.destroyView(id); }
    this.stage = null;
    this.queues.clear();
    this.drivingFrames.length = 0;
    if (ids.length) this.emit();
  }

  // ── 快照（供工具层用） ───────────────────────────────────────────────────

  getSnapshot(tabId: string): AxSnapshot | null { return this.snapshots.get(tabId) ?? null; }

  /**
   * 取一份新快照。walker 在**隔离世界**里跑：页面覆写 `document.querySelectorAll`
   * 骗得到主世界，骗不到它（2026-09-08 spike 实测）；它的发号表挂在隔离世界的
   * window 上，页面既读不到也伪造不了。
   *
   * 每次都发一个新的 snapshotId —— 动作里的 `index` 必须带上它，只在那一份里解析。
   *
   * walker 报回来的**一个字段都不能丢**：`generation` 是 diff 判定「这两批号可不可比」
   * 的唯一依据（丢了它，跨文档的快照会被逐条配对成假话），`collection` / `iframes`
   * 是截断与未穿透的显式回报（spec §5.5，丢了它模型会以为没采到的东西不存在）。
   * 这里除了补一个 snapshotId，原样透传。
   *
   * **采集失败不抛**：页面在取快照那一刻导航走了，`executeJavaScriptInIsolatedWorld`
   * 就 reject（实测：同源导航中 6ms、跨进程导航中 41ms 照常 resolve，真换掉文档
   * 那一下才 reject）。抛出去的话，`browser_open`
   * 连已经拿到的导航结论（HTTP 403 这种）都一起丢，`browser_act` 更是把这一批
   * 已经抽到的数据全部丢掉，模型只看到一条 "Script failed to execute"。
   * 所以退回一份**显式标注没采全**的空快照：`truncated: true` + `returned: 0`
   * 是这一刻唯一为真的采集事实，渲染层会照它说出「这份快照里的 0 条不是本页的全部…
   * 找不到某个控件时不要断定它不存在」——「我没采到」与「页面上没有」从此不许长得一样。
   *
   * **渲染进程崩了走的是另一条路**：那一种 `executeJavaScriptInIsolatedWorld`
   * 不 reject，是**永不 settle**（实测，见 `hasRenderProcess`）—— 所以那一种要在
   * 注入之前就被 pid 谓词挡掉，靠 catch 是接不住的。这里两道都在：先问 pid，
   * 再罩时限。
   */
  async snapshot(tabId: string): Promise<AxSnapshot> {
    const wc = this.webContentsOf(tabId);
    if (!wc) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    // 没有渲染进程就**一个字都不注**：那时求值永不 settle，而 `browser_act` 的
    // 收尾快照就在这条路上 —— 挂在这里等于整轮 run 永远不返回（闸挡住了 CDP
    // 那一侧，这里曾经是剩下的唯一出口）。
    if (!BrowserService.hasRenderProcess(wc)) {
      return this.failedSnapshot(tabId, wc, '这个标签还没有渲染进程（页面没加载成功过，或者刚崩过）');
    }
    // 先把视口坐实再采集：walker 报的 x/y/w/h 是**视口内**的 CSS 像素，
    // 而 `visible()` 按 rect 判可见 —— 视口还是 0×0 的那一刻采集，整页会被判成
    // 「没有可交互元素」（§B）。导航那条路已经 await 过一次，这里是第二道：
    // 背景标签、以及不经过 navigate() 的调用方（Task 4 的动作派发）也要走到。
    await this.applyViewport(tabId, this.stage?.bounds ?? null);
    let raw: unknown;
    try {
      raw = await this.evalOn(wc, tabId, WALKER_SOURCE);
    } catch (err) {
      return this.failedSnapshot(tabId, wc, `采集脚本没能执行：${String(err)}`);
    }
    if (!isWalkerOutput(raw)) {
      return this.failedSnapshot(tabId, wc, '采集脚本的返回值不是一份快照');
    }
    const snap: AxSnapshot = { snapshotId: `snap_${randomUUID().slice(0, 8)}`, ...raw };
    this.snapshots.set(tabId, snap);
    return snap;
  }

  /**
   * 采集失败时那份如实标注的空快照。
   *
   * `generation` 给一个**全新的随机值**：这一刻我们并不知道页面还是不是刚才那个文档，
   * 而 diff 的判据是「世代不同就一个节点都不配对」—— 取新值是 fail-closed
   * （下一次退回全量，那份至少是真的），沿用旧值则可能把两个文档的号硬配成假话。
   */
  private failedSnapshot(tabId: string, wc: WebContents, why: string): AxSnapshot {
    logger.warn('browser.snapshot', '取快照失败，返回一份显式标注未采全的空快照', { tabId, why });
    const snap: AxSnapshot = {
      snapshotId: `snap_${randomUUID().slice(0, 8)}`,
      generation: `failed_${randomUUID()}`,
      url: this.safeCall(() => wc.getURL(), ''),
      title: this.safeCall(() => wc.getTitle(), ''),
      nodes: [],
      // limit 不给：撞的不是任何一道上限，我们**不知道**页面上有多少东西。
      // totalKnown 同理 —— 数不出来的数不要编一个。
      collection: { truncated: true, returned: 0 },
      iframes: 0,
    };
    this.snapshots.set(tabId, snap);
    return snap;
  }

  /** 页面刚没的那一刻，连 getURL() 都会抛。 */
  private safeCall<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
  }

  webContentsOf(tabId: string): WebContents | null {
    const v = this.views.get(tabId);
    return v && !v.webContents.isDestroyed() ? v.webContents : null;
  }

  /**
   * 这个标签**此刻已提交**的 URL。`null` = 没有这个标签（或它已经销毁）。
   *
   * **与 `getState().tabs[].url` 不是一回事，别拿那个代替它。** 账本里那份靠
   * `syncTabMeta` 在导航事件上更新，慢一拍；而 `loginFlow` 的 TOCTOU 重判问的是
   * 「我马上要往里面写校园密码的**这个文档**是谁」—— 慢一拍的答案在这里等于没答。
   *
   * 页面刚没的那一刻连 `getURL()` 都会抛，所以走 `safeCall`（回空串：wc 还在、
   * 只是这一刻问不出来，与「没有这个标签」是两件事）。
   */
  currentUrlOf(tabId: string): string | null {
    const wc = this.webContentsOf(tabId);
    if (!wc) return null;
    return this.safeCall(() => wc.getURL(), '');
  }

  /**
   * 这个标签的 `WebContents.id`。**webRequest 的归属判据就是它**：
   * `OnBeforeRequestListenerDetails.webContentsId`（`electron.d.ts:21933`）与它相等
   * 才算这个标签发出的请求。拿不到（标签已经没了）就 null —— 调用方不许去猜。
   */
  webContentsIdOf(tabId: string): number | null {
    const wc = this.webContentsOf(tabId);
    if (!wc) return null;
    return this.safeCall<number | null>(() => wc.id, null);
  }

  // ── 页内求值（隔离世界）───────────────────────────────────────────────────

  /**
   * 这个标签此刻有渲染进程吗。**`getOSProcessId()` 是协议层现成的事实**：没有渲染
   * 进程时它是 0，页面崩过一次之后也回到 0。
   *
   * 它同时是 CDP 输入与**页内求值**的前提，实测（Electron 41.2.1，2026-09-09，
   * 每个情形独立进程 + 独立 userData）：
   *
   * | 情形 | `executeJavaScriptInIsolatedWorld(31337, '1+1')` |
   * | --- | --- |
   * | 全新的、从没 load 过页面的 view | **3000ms 内永不 settle** |
   * | `forcefullyCrashRenderer()` 之后 | **永不 settle** |
   * | 同源 / 跨进程导航进行中 | 照常 resolve（6ms / 41ms） |
   *
   * **崩溃之后 `debugger.isAttached()` 仍是 true、`isDestroyed()` 是 false**，
   * `render-process-gone` 只记日志不回收 view —— 所以 `webContentsOf()` 照常回一个
   * 非 null 的 wc，而「这个标签能不能问」这件事**只有 pid 说得出来**。
   * （`assertDispatchable` 那道 `isAttached()` 管的是另一件事：CDP 通道。
   * 页内求值不走 CDP，DevTools 顶掉 attach 之后它照样能跑，所以那一条不在这里。）
   */
  private static hasRenderProcess(wc: WebContents): boolean {
    return wc.getOSProcessId() !== 0;
  }

  /** 没有渲染进程就当场说清楚。措辞与处置：**先把页面打开**。 */
  private static assertRenderProcess(tabId: string, wc: WebContents): void {
    if (BrowserService.hasRenderProcess(wc)) return;
    throw new KydogError('browser.not_dispatchable',
      `标签 ${tabId} 还没有渲染进程 —— 页面从来没加载成功过，或者刚刚崩过。`
      + '先用 browser_open 打开一个页面再操作。');
  }

  /**
   * 在隔离世界里求值，**罩一个时限**。所有页内求值都要走它。
   *
   * 时限的理由见 `PAGE_EVAL_TIMEOUT_MS`：pid 那道谓词挡住已知的两种永不 settle，
   * 这里兜住没量到的第三种。到点后 reject 一条**说得出「我们没等到」的错**，
   * 而不是让一次 sequential 的工具调用永远不返回。
   *
   * ── 时限到点之后那次求值怎么办 —— 量过的三条 ────────────────────────────
   *
   * **主进程这一侧取消不了它。** Electron 41.2.1 的
   * `executeJavaScriptInIsolatedWorld(worldId, scripts, userGesture)` 没有 signal、
   * 没有句柄、没有配套的 cancel（查了 `electron.d.ts` 的整个 `webContents` 面）。
   * CDP 的 `Runtime.terminateExecution` 也不行，实测：主线程被占住时**这条命令自己
   * 也进不去**（ack 要等 7.3 秒、等到忙循环结束才回来，那时早过了点），而且它落地
   * 之后那次求值的 promise **永不 settle**；它还是「终止页面当前正在跑的 JS」这种
   * 页面级的大锤，会打断站点自己的脚本。
   *
   * **被丢掉的那次稍后照常执行，而注进去的并不都是纯读取的。**
   * 实测（Electron 41.2.1，2026-09-09，真页面 + 真 `window.scrollBy`，3/3 复现）：
   * 页面忙循环 8 秒、时限 3 秒 → 主进程 3.00 秒报「没等到」，**页面 7.2–7.8 秒真的
   * 滚了 800 像素**。`interact.js` 的 `scroll` / `select` / `focusSelect` 都写页面，
   * `measure` 还调 `scrollIntoView()`。（`snapshot` 的 walker、`extract`、
   * `browser_read` 的正文、`waitFor` 的 `querySelector` 这四条才是纯读取。）
   *
   * **页面那一侧认得出来。** 把同一个到点时刻拼进注入的代码里，页面回魂之后自己先
   * 看一眼、过期就在碰页面之前退出来 —— 实测同一构造下 `scrollY` 停在 0（3/3），
   * 而忙 4 秒、时限 20 秒的慢页面照常滚（**自检不误杀**）。写页面的只有
   * `interactExpression` 那一条路，守卫就装在它上面。
   *
   * **但这仍然不是取消**：求值卡在到点那一刻的窗口里时，自检过了之后写照样会落地。
   * 所以这条错说的是「结果未知」，**不是「没有发生」**——「没有发生」只有页面把
   * `expired` 送回来的时候才成立（见 `interactError` 的那一格）。
   */
  private evalOn(wc: WebContents, tabId: string, code: string | ((notAfter: number) => string)): Promise<unknown> {
    // **一个到点时刻，两边共用。** 页面那道自检与这里的定时器各算各的话，守卫要么
    // 提前把好的求值废掉、要么晚到根本不挡。
    const notAfter = Date.now() + PAGE_EVAL_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_res, rej) => {
      timer = setTimeout(() => rej(new KydogError('browser.page_no_result',
        `标签 ${tabId} 的页面在 ${PAGE_EVAL_TIMEOUT_MS} 毫秒内没有回应这次求值 —— `
        + '它要么正被自己的脚本占着主线程，要么已经不回话了。'
        + '**这一步到底生效了没有，我们不知道**：这次求值取消不掉，页面回过神来还会执行它'
        + '（写页面的那条路带着同一个时限自检，过期就自己不做，但卡在到点那一刻的窗口里仍可能已经落地）。'
        + '别按「它没做」去重试 —— 要重试就先取一份快照看页面现在什么样。',
        undefined, 'unknown')), PAGE_EVAL_TIMEOUT_MS);
    });
    return Promise.race([
      wc.executeJavaScriptInIsolatedWorld(WALKER_WORLD_ID,
        [{ code: typeof code === 'string' ? code : code(notAfter) }]),
      deadline,
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /**
   * 给工具层用的页内求值：**两道保护齐全**（没有渲染进程就不注入、注了就罩时限）。
   *
   * `browser_read` 的正文与 `extract` 的抽取都走它 —— 那两条路此前直接拿
   * `webContentsOf()` 注脚本，崩过一次的标签上就是一次挂死，而它们**都在
   * `browser_act` / `browser_read` 这种 sequential 工具里**。
   *
   * `code` 收**拼装函数**那一档是给要带过期自检的注入用的（`loginFlow` 的填充脚本，
   * 与 `interactExpression` 同一个道理）：到点时刻由 `evalOn` 算一次、两边共用 ——
   * 调用方自己 `Date.now() + PAGE_EVAL_TIMEOUT_MS` 会与这里的定时器差开一小段，
   * 守卫要么提前把好的求值废掉、要么晚到根本不挡。
   */
  async evalInPage(tabId: string, code: string | ((notAfter: number) => string)): Promise<unknown> {
    const wc = this.webContentsOf(tabId);
    if (!wc) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    BrowserService.assertRenderProcess(tabId, wc);
    return this.evalOn(wc, tabId, code);
  }

  // ── 动作派发（spec §4.2）──────────────────────────────────────────────────

  /**
   * 这个标签此刻发得了输入事件吗。**两道闸，判据都是协议层现成的事实。**
   *
   * 不闸住的代价实测有三种形状，没有一种会自己说出「这个标签还没法操作」
   * （Electron 41.2.1，2026-09-08，全新的、还没 load 过任何页面的 WebContentsView，
   * `getOSProcessId() === 0`，每个情形独立进程 + 独立 userData，3/3 复现）：
   *
   * | 命令 | pid=0 时 |
   * | --- | --- |
   * | `Input.dispatchMouseEvent`（pressed / released / moved / wheel） | reject `Internal error` |
   * | `Input.insertText` | **永不 settle** —— 进程退出时才以 "target closed" reject |
   * | `Input.dispatchKeyEvent` | resolve `{}`（静默无效） |
   *
   * 中间那一条会让一次 `browser_act`（sequential 工具）**永远不返回**；最后一条更糟：
   * 回报「按下 Enter」而它一个字都没发到页面上。
   * （`Emulation.setDeviceMetricsOverride` 在同样情形下是 **SIGSEGV**，见 applyViewport
   * 那段 —— 那条更硬，但闸是同一道。）
   */
  private assertDispatchable(tabId: string, wc: WebContents): void {
    if (!wc.debugger.isAttached()) {
      throw new KydogError('browser.not_dispatchable',
        `标签 ${tabId} 的调试通道已经断开（多半是 DevTools 打开把它顶掉了），现在发不了任何输入事件。`
        + '这是 KyDog 这一侧的通道问题，与站点无关。');
    }
    // 第二条与页内求值那道谓词**是同一个判据**，提出去共用：崩溃之后 pid 回 0
    // 而 isAttached() 仍是 true —— 只有它挡得住（见 hasRenderProcess 的实测表）。
    BrowserService.assertRenderProcess(tabId, wc);
  }

  /**
   * 把一段 `interact.js` 送进隔离世界。返回值形状不对就当场说清，绝不往下读 undefined。
   *
   * 三种失败共用 `browser.page_no_result`，**不是 `not_dispatchable`**：它们的处置
   * 是「等一下重试 / 重新取一份快照」，而 `not_dispatchable` 的处置是「先把页面
   * 打开」。两件事一度共用一个码，代价有两头 —— 模型收到它会去重开页面（白白丢掉
   * 当前页面状态），而闸那一侧的用例也断不准（把闸删掉之后，这里会用同一个码把它兜住，
   * 用例照样绿）。
   */
  private async interact(tabId: string, wc: WebContents, req: InteractRequest): Promise<InteractResult> {
    let raw: unknown;
    try {
      // 传的是**拼装函数**不是拼好的串：到点时刻由 `evalOn` 算，页面那道自检与
      // 主进程那道定时器共用同一个数（漂开就等于守卫失效）。
      raw = await this.evalOn(wc, tabId, (notAfter) => interactExpression(req, notAfter));
    } catch (err) {
      // 时限那一条自己就是 page_no_result，原样放行（它的消息说得更准）。
      if (err instanceof KydogError) throw err;
      throw new KydogError('browser.page_no_result',
        `在标签 ${tabId} 的页面里执行定位脚本失败：${String(err)}。页面多半正在导航 —— `
        + '等一下重试，或者重新取一份快照再操作。');
    }
    if (!raw || typeof raw !== 'object' || typeof (raw as { ok?: unknown }).ok !== 'boolean') {
      throw new KydogError('browser.page_no_result',
        `标签 ${tabId} 的页面没有回传定位结果 —— 多半是在派发中途导航走了。这一步没有发生，`
        + '重新取一份快照再操作。');
    }
    return raw as InteractResult;
  }

  /** 报错时说得出「哪个目标」。selector 与编号两种说法不能混：处置不同。 */
  private static describeTarget(action: DispatchAction): string {
    const s = action as { selector?: string; index?: number; snapshotId?: string };
    if (typeof s.selector === 'string') return `选择器 ${JSON.stringify(s.selector)}`;
    return `编号 ${s.index}（来自快照 ${s.snapshotId}）`;
  }

  /**
   * 把 `interact.js` 报的失败翻译成错误码。
   *
   * **每一种的处置都不同**，所以绝不能收敛成一句话：换选择器 / 重新取快照 /
   * 先关掉浮层 / 换一个目标。收敛掉的那一刻，模型就只能靠猜。
   *
   * `priorInputDispatched`：这次 `interact()` 调用之前，这一个动作**有没有已经
   * 往页面发过 CDP 输入事件**（`type` 的 `focusSelect` 排在两条 `Input.dispatchMouseEvent`
   * 之后——探针实证：那两条命令是真的先发出去了）。`expired` 那句「它按约定什么
   * 都没做」对 `measure`/`select`/`scroll`（各自都是这个动作的第一次求值）成立，
   * 但对排在点击之后的 `focusSelect` 不成立——不能一句话覆盖两种情形。
   */
  private static interactError(
    r: InteractResult, action: DispatchAction, ctx: { priorInputDispatched?: boolean } = {},
  ): KydogError {
    const where = BrowserService.describeTarget(action);
    switch (r.reason) {
      case 'not_found':
        return new KydogError('browser.target_unusable',
          `${where} 在当前页面上没有匹配。重新取一份快照看看页面现在长什么样，或者换一个选择器。`);
      case 'bad_selector':
        return new KydogError('browser.bad_action', `${where} 不是合法的 CSS 选择器。`);
      case 'stale_node':
        return new KydogError('browser.stale_index',
          `${where} 指向的元素已经不在当前文档里了 —— 页面换过或那一段 DOM 被重建了。重新取一份快照再操作。`);
      case 'not_visible':
        return new KydogError('browser.target_unusable',
          `${where} 在页面上折叠到了看不见的尺寸（${String(r.w)}×${String(r.h)}），点不到。`);
      case 'offscreen':
        return new KydogError('browser.target_unusable',
          `${where} 滚进视野之后仍然落在视口外（坐标 ${String(r.x)},${String(r.y)}，视口 ${String(r.vw)}×${String(r.vh)}）`
          + '—— 多半有一个自己就在视口外的滚动容器，或者 position:fixed 的祖先。');
      case 'intercepted':
        return new KydogError('browser.click_intercepted',
          `${where} 那个位置上被 ${String(r.by)} 挡住了（cookie 横幅、授权对话框这类浮层会静默吃掉点击）。`
          + '先把浮层关掉再点。');
      case 'password':
        return new KydogError('browser.password_field',
          '不能往密码框里输入。机构登录用 browser_login（由主进程填），其他登录请交给用户');
      case 'not_editable':
        return new KydogError('browser.target_unusable',
          `${where} 不是能打字的控件（${String(r.tag)}${r.type ? ` type=${String(r.type)}` : ''}）。`
          + '往它上面打字不会有任何效果 —— 找真正的输入框。');
      case 'no_text_input':
        // 与 not_editable 分开：那条的下一步是「找真正的输入框」，而这条的目标
        // **就是**那个日期框 —— 它只是收不了文本插入。说成同一件事会让模型
        // 满页去找一个不存在的「真正的年份输入框」。
        return new KydogError('browser.target_unusable',
          `${where} 是 ${String(r.type)} 这类分段选择器。实测 insertText 对它完全无效：`
          + '打进去一个字都不会进，而先清空再打会把它原本的值抹掉。'
          + '所以这里拒绝 —— 这一期没有设置这类控件的动作，改用页面上的其他入口（下拉框走 select）。');
      case 'not_select':
        return new KydogError('browser.target_unusable',
          `${where} 不是 <select>（是 ${String(r.tag)}）。select 动作只对下拉框有效。`);
      case 'no_option':
        return new KydogError('browser.target_unusable',
          `${where} 这个下拉框里没有值为这一项的选项。它一共有 ${String(r.totalKnown)} 项，`
          + `可选值：${JSON.stringify(r.options)}`
          // 截断必须显式说出口（spec §5.5）：不说的话，模型看完这几项都不匹配，
          // 就会以为自己要的那个不存在。
          + (r.truncated === true
            ? `（这里只列出前 ${String(r.returned)} 项，**其余的没有列出来** —— 别据此断定你要的值不存在）`
            : '')
          + '。（直接写一个不存在的值会把它变成「什么都没选」，所以这里拒绝。）');
      case 'bad_direction':
        return new KydogError('browser.bad_action',
          `scroll 的方向只能是 up 或 down，收到 ${JSON.stringify(r.direction)}。`);
      case 'expired':
        // 页面赶在主进程那道定时器之前把 `expired` 送回来了（页面回魂得早，或者
        // 主进程自己被卡了一下）——**这次求值**本身确实什么都没做，撞时限那一条
        // （outcome:'unknown'）才说不出这句话，两者不许共用措辞（见 `evalOn` 的实测表）。
        // 但「这次求值什么都没做」不等于「这个动作什么都没做」：`type` 的
        // `focusSelect` 排在两条 `Input.dispatchMouseEvent` 之后，点击已经真的
        // 发出去了——这种情形下不能说「它按约定什么都没做」（探针实证过，见上）。
        return new KydogError('browser.page_no_result',
          ctx.priorInputDispatched === true
            ? `${where} 点击已经发出去了，但随后这一步（对焦并全选）到达页面的时候已经过了`
              + '这次求值的时限，没有做到——**点击本身不受这个影响，页面可能已经因为它变了样**'
              + '（展开了面板、弹出了下拉之类）。别假设页面还停在点击之前：先取一份快照看看现在什么样。'
            : `${where} 这一步到达页面的时候已经过了这次求值的时限，它按约定什么都没做。`
              + '页面多半正被自己的脚本占着主线程 —— 等一下重试，或者先取一份快照看它现在什么样。',
          undefined, 'none');
      default:
        return new KydogError('browser.target_unusable', `${where} 这一步没能执行：${String(r.reason)}`);
    }
  }

  /**
   * 执行一个动作，返回一句给模型看的说明。**真正碰页面的只有这里。**
   *
   * **不自己 enqueue**：调用方（`browser_act` 的整批）已经在队列里了，这里再排一次
   * 会把自己排在自己后面 —— 死锁。新增任何别的调用方时，要在**外面**包 `enqueue`
   * （与 `open` / `navControl` 同一条路），不要绕过队列直接调这里。
   *
   * 三件事（spec §4.2「点击之前有三件事，一件都不能省」）全在 `interact.js` 里做：
   * 滚进视野 → 在派发那一刻重新量 → 命中检查。`snapshot` 参数只用来解析 `index`
   * （`resolveTarget` 给的 x/y 是**快照当时**的，这里一个字都不用）。
   */
  async dispatch(tabId: string, action: DispatchAction, snapshot: AxSnapshot | null): Promise<string> {
    const wc = this.webContentsOf(tabId);
    if (!wc) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    this.assertDispatchable(tabId, wc);

    if (action.kind === 'key') {
      for (const ev of keyEventsFor(action.key)) {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', ev);
      }
      return `按下 ${action.key}`;
    }

    if (action.kind === 'scroll') {
      // **不发 `Input.dispatchMouseEvent` 的 mouseWheel。** 2026-09-08 实测
      // （Electron 41.2.1）：那条命令**永不 ack、也一个像素都不滚**，五种组合逐一试过
      // （view 隐藏 / view 可见但窗口隐藏 / 窗口也显示 × 禁不禁用硬件加速）；
      // `Input.synthesizeScrollGesture` 会 ack（约 1030ms）但同样不滚。
      // 隔离世界里的 scrollBy 是同步的、当场量得到，而且不挑可见性 ——
      // 这也正是「侧栏开不开都一样」那条要求的。
      const r = await this.interact(tabId, wc, {
        op: 'scroll', direction: action.direction, ...(action.amount === undefined ? {} : { amount: action.amount }),
      });
      if (!r.ok) throw BrowserService.interactError(r, action);
      const dir = action.direction === 'up' ? '上' : '下';
      const where = r.container === 'document' ? '整页' : `内层滚动容器 ${String(r.container)}`;
      // 「滚到底了」与「这次滚动没生效」必须分得开：前者是页面事实（scrollTop 已经
      // 顶到 scrollHeight - clientHeight），后者是我们这一侧的问题。
      const edge = action.direction === 'down' ? r.atEnd : r.atStart;
      const tail = r.delta === 0
        ? (edge ? `，一像素都没动 —— 已经到${action.direction === 'up' ? '顶' : '底'}了`
          : '，但一像素都没动（这个容器滚不动，内容多半没有超出它）')
        : '';
      return `已把${where}向${dir}滚了 ${String(r.delta)} 像素（${String(r.before)} → ${String(r.after)}）${tail}`;
    }

    // 剩下四种都要目标。**密码硬闸第一道排在这里**：快照里 walker 已经判过它是
    // 密码框的，连页面都不许碰（第二道在 interact.js 里，管 selector 定位那条路）。
    const resolved = resolveTarget(action as TargetSpec, snapshot);
    if (action.kind === 'type') assertTypeAllowed(resolved);
    const target: InteractTarget = resolved.kind === 'selector'
      ? { selector: resolved.selector } : { nodeId: resolved.nodeId };

    if (action.kind === 'select') {
      // 不派发任何鼠标事件，所以「三件事」不适用：赋值 + 派发 input/change 就是全部。
      const r = await this.interact(tabId, wc, { op: 'select', target, value: action.value });
      if (!r.ok) throw BrowserService.interactError(r, action);
      const label = String(r.label ?? '');
      return `已在下拉框里选中 ${label ? `「${label}」` : ''}（value=${JSON.stringify(r.value)}）`
        + (r.changed === false ? '（它本来就是这个值）' : '');
    }

    // spec §4.2 的三件事：滚进视野 → 重新量 → 命中检查。缺一件都是「打偏了还不报错」。
    const m = await this.interact(tabId, wc, { op: 'measure', target });
    if (!m.ok) throw BrowserService.interactError(m, action);
    // 第二道密码闸：selector 定位时快照那层看不出来，这里拿到的是活元素。
    if (action.kind === 'type' && m.isPassword === true) {
      throw BrowserService.interactError({ ok: false, reason: 'password' }, action);
    }
    // 「能不能打字」也要**在点下去之前**问。放到 focusSelect 之后就晚了：那时
    // 这一下已经点出去了 —— 而 `type {selector:'#submit'}` 点的是提交按钮，
    // 一次没人要求过的表单提交，然后才报「这个目标不能打字」。
    if (action.kind === 'type' && m.editable === false) {
      throw BrowserService.interactError(
        { ok: false, reason: 'not_editable', tag: m.tag, type: '' }, action);
    }
    // 分段选择器（date / time / month / week / datetime-local）同样要**在点下去
    // 之前**拒：实测 `Input.insertText` 对它们完全无效，而「先清空再打」会把用户
    // 原本填好的年份抹掉 —— 网页不可回滚。（详见 interact.js 的 SEGMENTED_TYPES。）
    if (action.kind === 'type' && m.segmented === true) {
      throw BrowserService.interactError(
        { ok: false, reason: 'no_text_input', tag: m.tag, type: m.type }, action);
    }
    const x = Number(m.x);
    const y = Number(m.y);
    const label = String(m.label ?? '') || String(m.tag ?? '');

    if (action.kind === 'hover') {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      return `已把指针移到「${label}」上（${x},${y}）`;
    }

    // disabled 的控件在 Chromium 里**根本收不到 click**。发出去就是「什么都没发生
    // 但回报成功」—— 最后一页那个 disabled 的「下一页」按钮正是这个形状，
    // 一个 repeat×3 会把第一页抽三遍而且不报任何错。
    if (m.disabled === true) {
      throw new KydogError('browser.target_unusable',
        `${BrowserService.describeTarget(action)}「${label}」是 disabled 的，点它不会有任何效果。`
        + '（翻页控件到了最后一页就是这个样子。）');
    }

    const press = { x, y, button: 'left' as const, clickCount: 1 };
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...press });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press });
    if (action.kind === 'click') return `已点击「${label}」（${x},${y}）`;

    // type：点一下是为了聚焦（很多站点的检索框要点开才展开），随后**必须全选** ——
    // 实测 `Input.insertText` 是在光标处**插入**："旧内容" + "石墨烯" → "旧内容石墨烯"，
    // 而光标落在哪取决于点到了哪个像素。同一个动作在同一个页面上能产出不同的串，
    // 还不报错。全选之后 insertText 替换选区（实测 "旧内容" → "量子计算"）。
    const f = await this.interact(tabId, wc, { op: 'focusSelect', target });
    // 到这里两条 `Input.dispatchMouseEvent` 已经真的发出去了（见上两行）——
    // `expired` 那句「什么都没做」对这一次求值不成立，见 `interactError` 的判据。
    if (!f.ok) throw BrowserService.interactError(f, action, { priorInputDispatched: true });
    // **`focusSelect` 报回来的事实必须读。** 它在页面里算出「焦点到底在不在目标上」
    // 与「这一下有没有真的清空」，这里拿到手就丢的话，紧接着的 insertText 是一次
    // 没有依据的输入 —— 而返回值仍然会说「已在「X」里输入」。
    if (f.focused !== true) {
      // 焦点没落在目标上时，insertText 打进的是**当时真正持有焦点的那个元素**
      // （多半是上一个动作留下的框）。那是往一个谁也没指定的地方写字。
      throw new KydogError('browser.target_unusable',
        `${BrowserService.describeTarget(action)}「${label}」点过之后焦点并没有落在它身上，`
        + '这时候打字会打进当时真正持有焦点的那个元素里。这一步没有发生 —— '
        + '多半有一个浮层抢走了焦点，或者这个控件根本不接受键盘焦点。');
    }
    if (f.selected !== true && f.emptyBefore !== true) {
      // 「先清空」没有发生：insertText 会**插在光标处**，最终的串取决于点到了哪个
      // 像素（实测 "旧内容" + "石墨烯" → "旧内容石墨烯"；年份框 2020 + 2024 →
      // "20202024"）。同一个动作在同一个页面上产出不同的结果，还不报错 ——
      // 所以这里 fail-closed，一个字都不打。
      throw new KydogError('browser.target_unusable',
        `${BrowserService.describeTarget(action)}「${label}」里原有的内容没能清空（既没被全选，框也不是空的）。`
        + '这时候打字是**追加**不是替换，最终的内容取决于光标落在哪 —— 所以这一步没有发生。');
    }
    await wc.debugger.sendCommand('Input.insertText', { text: action.text });
    // 打完把框里**真正**变成什么读回来：`Input.insertText` 在焦点不是可编辑元素时
    // **ack 0ms 而什么都不做**（实测 body / button / readonly / disabled 四种都是）。
    // 不读回来的话「打进去了」就是一句没有依据的话。
    const v = await this.interact(tabId, wc, { op: 'readValue', target });
    // 打完之后框里是空的，而我们打的是非空文本 —— 那这一次 insertText 什么都没做。
    // （`text: ''` 在 validateBatch 就被拒了，所以「空」只可能是没打进去：站点在
    // input 事件里把它清了，或者这个控件根本收不了文本插入。）
    // 不判这一条的话，返回值会变成「已在「起始年」里输入，框里现在是「」」——
    // 一句读起来像成功的话。
    if (v.ok && v.value === '' && action.text !== '') {
      throw new KydogError('browser.target_unusable',
        `${BrowserService.describeTarget(action)}「${label}」打完之后框里是空的 —— `
        + '这一次输入没有生效（站点可能在 input 事件里清空了它，或者这个控件收不了文本插入）。');
    }
    const now = v.ok && typeof v.value === 'string' ? `，框里现在是「${v.value}」` : '';
    return `已在「${label}」里输入${now}`;
  }

  /**
   * 等一个**显式条件**成立（spec §4.2 的第 3 条）。成立返回 true，到时限返回 false。
   *
   * 轮询在这里是**等待手段**，不是判定依据 —— 判定的是「条件成立了没有」这个页面
   * 事实（`querySelector` 命中与否 / 当前 URL 含不含那一段），不是「一段时间没有
   * mutation」那种时间阈值。超时**只表示条件未达成**，不表示别的。
   *
   * `urlMatches` 判的是**主进程手里的 `getURL()`**，不往页面里注脚本：这条件的典型
   * 用法就是「等它跳到结果页」，而那一刻页面正在换文档 —— 脚本要么跑在旧文档上、
   * 要么直接 reject。两边是同一个协议层事实，主进程这一份不挑时机。
   */
  async waitFor(tabId: string, until: WaitUntil, timeoutMs: number): Promise<boolean> {
    const wc0 = this.webContentsOf(tabId);
    if (!wc0) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    // selector 那一支要往页面里注脚本，所以先问一次「这个标签问得了吗」：没有渲染
    // 进程时求值**永不 settle**（实测），轮询会一次次注进去、一个都不回来，最后烧满
    // 时限报「条件未达成」—— 而真相是「这个标签压根问不了」。urlMatches 不进页面，
    // 不受这道闸管（它读的是主进程手里的 getURL()）。
    if (!('urlMatches' in until)) BrowserService.assertRenderProcess(tabId, wc0);

    /** 'yes' / 'no' 是页面给的答案，'unknown' 是**没问出来** —— 三者不许合并。 */
    type Answer = 'yes' | 'no' | 'unknown';
    const probe = async (): Promise<Answer> => {
      const wc = this.webContentsOf(tabId);
      if (!wc) return 'unknown';
      if ('urlMatches' in until) {
        return this.safeCall(() => wc.getURL(), '').includes(until.urlMatches) ? 'yes' : 'no';
      }
      // 语法错的选择器在页面里抛 DOMException。**它当场就判得出来**，不该被当成
      // 「条件还没成立」去烧满 8–30 秒 —— 动作那一侧早就分开报了（bad_selector）。
      const code = `(() => { try { return !!document.querySelector(${JSON.stringify(until.selector)}); }`
        + ' catch { return \'bad_selector\'; } })()';
      const raw = await this.evalOn(wc, tabId, code).then((v) => v, () => 'unknown');
      if (raw === 'bad_selector') {
        throw new KydogError('browser.bad_action',
          `wait 的选择器 ${JSON.stringify(until.selector)} 不是合法的 CSS 选择器 —— `
          + '这是写法的问题，等多久都不会成立。');
      }
      // 页面在轮询中途导航走了，脚本就 reject。**那既不是「元素在」也不是
      // 「元素不在」，是没问出来** —— 接着等就是了。把它当成「不在」的话，
      // `state: 'absent'` 会立刻取反成「等到了：它消失了」，而我们一次都没问出结果。
      const present: Answer = raw === true ? 'yes' : raw === false ? 'no' : 'unknown';
      if (present === 'unknown') return 'unknown';
      const want = until.state === 'absent' ? 'no' : 'yes';
      return present === want ? 'yes' : 'no';
    };

    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((r) => { timer = setTimeout(() => r(false), timeoutMs); });
    const loop = async (): Promise<boolean> => {
      for (;;) {
        // 先问一次再等：条件一开始就成立时不该白等一个轮询周期。
        if (await probe() === 'yes') return true;
        if (stopped) return false;
        await new Promise<void>((r) => setTimeout(r, WAIT_POLL_MS));
        if (stopped) return false;
      }
    };
    try {
      // **时限罩在轮询外面**：一次挂住的求值（页面卡死时 `executeJavaScript` 可以
      // 永远不 settle）不许把整轮 run 一起拖死 —— wait 是 sequential 工具里的一步。
      return await Promise.race([loop(), deadline]);
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  }
}

export const browserService = new BrowserService();
