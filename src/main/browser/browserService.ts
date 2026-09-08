import { BrowserWindow, WebContentsView, session, type WebContents, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { KydogError } from '../../shared/errors';
import type { BrowserState, NavigationObservation, RectDip } from '../../shared/types';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { assertAllowedUrl, checkUrl } from './urlGuard';
import { TabRegistry } from './tabRegistry';
import { NavigationTracker } from './settle';
import type { AxSnapshot } from './snapshot';
import WALKER_SOURCE from './injected/walker.js?raw';
import PW_REGISTRAR_SOURCE from './injected/pwRegistrar.js?raw';

/**
 * 内置浏览器。主进程持有 WebContentsView —— **不是 `<webview>`**：
 * `adoptWebContents` 在 Electron 41 上不存在，而 2026-09-08 spike 实测
 * WebContentsView 在宿主 renderer 重载后连页面 JS 状态一起完好存活。
 *
 * 渲染层只画一块空「舞台」div 并上报它的几何，网页由主进程定位过去。
 */

/** 浏览器自己的 cookie 罐子，与 KyDog 主窗口完全隔开。持久化是刻意的：
 *  用户登录一次机构，之后 agent 都能用同一个会话。 */
const PARTITION = 'persist:kydog-browser';

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

/** 一次 agent 驱动的窗口：哪一轮 run，以及它期间标过的标签。 */
type DrivingFrame = { runId: string; tabs: Set<string> };

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
  private stage: Stage | null = null;
  private sessionWired = false;

  // ── 装配 ────────────────────────────────────────────────────────────────

  attach(win: BrowserWindow): void {
    this.win = win;
    // 窗口销毁之后这个引用就是野的：下一次 createTab 会往一个已经析构的 contentView 上
    // addChildView。这里只负责把引用清干净（那之后 createTab 报「还没装配到窗口上」），
    // **要不要顺手 disposeAll 是 main.ts 那一侧的策略**，见报告给 Task 6 的清单。
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
    // 队尾吞掉异常，否则一次失败会让这个标签的队列永久卡住。
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
  async withAgentDriving<T>(tabId: string, runId: string | null, fn: () => Promise<T>): Promise<T> {
    if (runId === null) return fn();   // 用户自己的操作，不置位
    // **一次驱动一帧，各清各的。** 队列是按标签串的，所以两次 agent 驱动的操作
    // 完全可以同时在两个标签上跑；共用一个 Set + 一个 drivingRunId 的话，
    // 先结束的那一次会把另一次的标志一起清掉，而它还在跑 —— 那一刻页面弹出来的
    // 新标签就会被判成用户的，回合结束不回收。
    const frame: DrivingFrame = { runId, tabs: new Set<string>() };
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
   * 不下发的话，新建的 view 从没被给过 bounds，walker 里每个元素的
   * `getBoundingClientRect()` 都是 0×0、被 `visible()` 全部滤掉，工具返回
   * 「这一份快照里没有可交互元素」—— 模型判定这个源是空页面并换源，全程没有任何错误。
   * （2026-09-08 实测：零 bounds / setVisible(false) / 从没 setBounds 三种情形下，
   * 加了 override 之后 innerWidth / clientWidth 都是 1280，50% 宽的元素量到 640，
   * walker 采到的节点几何与一个正常可见的 view 逐字相同；不加则 clientWidth = 0、
   * 百分比宽的元素全部塌成 0。数据见 task-2f-report.md §B3。）
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
    void wc.executeJavaScriptInIsolatedWorld(WALKER_WORLD_ID, [{ code: PW_REGISTRAR_SOURCE }])
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

  /** **挂在 agent_settled 上，不是 agent_end** —— pi 在 agent_end 之后仍可能自动重试，
   *  那时标签还属于同一轮 KyDog run。 */
  disposeForRun(runId: string): void {
    const gone = this.registry.disposeForRun(runId);
    for (const id of gone) this.destroyView(id);
    if (gone.length) { this.applyLayout(); this.emit(); }
  }

  /** 退出 / 窗口销毁时收摊。**幂等**：跑第二遍时账本已经空了，什么都不做。
   *  目前没有调用方 —— main.ts 的接线属于 Task 6，见报告里的清单。 */
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
   * **采集失败不抛**：页面在取快照那一刻导航走了、渲染进程崩了，
   * `executeJavaScriptInIsolatedWorld` 就 reject。抛出去的话，`browser_open`
   * 连已经拿到的导航结论（HTTP 403 这种）都一起丢，`browser_act` 更是把这一批
   * 已经抽到的数据全部丢掉，模型只看到一条 "Script failed to execute"。
   * 所以退回一份**显式标注没采全**的空快照：`truncated: true` + `returned: 0`
   * 是这一刻唯一为真的采集事实，渲染层会照它说出「这份快照里的 0 条不是本页的全部…
   * 找不到某个控件时不要断定它不存在」——「我没采到」与「页面上没有」从此不许长得一样。
   */
  async snapshot(tabId: string): Promise<AxSnapshot> {
    const wc = this.webContentsOf(tabId);
    if (!wc) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    // 先把视口坐实再采集：walker 报的 x/y/w/h 是**视口内**的 CSS 像素，
    // 而 `visible()` 按 rect 判可见 —— 视口还是 0×0 的那一刻采集，整页会被判成
    // 「没有可交互元素」（§B）。导航那条路已经 await 过一次，这里是第二道：
    // 背景标签、以及不经过 navigate() 的调用方（Task 4 的动作派发）也要走到。
    await this.applyViewport(tabId, this.stage?.bounds ?? null);
    let raw: unknown;
    try {
      raw = await wc.executeJavaScriptInIsolatedWorld(WALKER_WORLD_ID, [{ code: WALKER_SOURCE }]);
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
}

export const browserService = new BrowserService();
