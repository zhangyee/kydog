import { BrowserWindow, WebContentsView, session, type WebContents, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { KydogError } from '../../shared/errors';
import type { BrowserState, NavigationObservation, RectDip } from '../../shared/types';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { assertAllowedUrl, checkUrl } from './urlGuard';
import { TabRegistry } from './tabRegistry';
import { NavigationTracker } from './settle';
import type { AxSnapshot, AxNode } from './snapshot';
import WALKER_SOURCE from './injected/walker.js?raw';

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

/** 导航时限。到点后 stop() 并把这次导航作废 —— 不然工具已经按 timeout 换了源，
 *  旧导航稍后还可能落进同一个标签。 */
const NAV_TIMEOUT_MS = 20_000;

/** walker 与 extract 都跑在这个隔离世界里。选一个不太可能撞车的号；
 *  页面看不见这里的任何东西，也覆写不了这里看到的 `document.querySelectorAll`。 */
export const WALKER_WORLD_ID = 31337;

type Stage = { epoch: number; visible: boolean; occluded: boolean; bounds: RectDip };

export class BrowserService {
  private win: BrowserWindow | null = null;
  private readonly registry = new TabRegistry();
  private readonly views = new Map<string, WebContentsView>();
  private readonly snapshots = new Map<string, AxSnapshot>();
  private readonly navs = new Map<string, NavigationTracker>();
  private stage: Stage | null = null;
  private sessionWired = false;

  // ── 装配 ────────────────────────────────────────────────────────────────

  attach(win: BrowserWindow): void {
    this.win = win;
    this.wireSession();
  }

  private get sess(): Session {
    return session.fromPartition(PARTITION);
  }

  /**
   * 下载在这一期一律取消（§5.4）。**但要如实报成 download**：报成 timeout 的话，
   * agent 打一个 PDF 直链会以为源不可达并换源 —— 而它其实找到了文件。
   */
  private wireSession(): void {
    if (this.sessionWired) return;
    this.sessionWired = true;
    this.sess.on('will-download', (event, item, wc) => {
      event.preventDefault();
      const tabId = this.tabIdOf(wc);
      if (tabId) {
        this.navs.get(tabId)?.onWillDownload(item.getURL(), item.getMimeType(), item.getFilename());
      }
      logger.info('browser.download', '按策略取消下载', { url: item.getURL(), tabId });
    });
  }

  private tabIdOf(wc: WebContents | undefined): string | null {
    if (!wc) return null;
    for (const [id, v] of this.views) if (v.webContents === wc) return id;
    return null;
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
    broadcaster.emit('browser.tabsChanged', this.registry.toState());
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
   */
  hideAll(): void {
    this.stage = null;
    for (const v of this.views.values()) v.setVisible(false);
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
      if (!st) continue;
      view.setBounds(st.bounds);
      if (isActive) this.applyViewport(id, st.bounds);
    }
  }

  /**
   * 固定逻辑视口。用 CDP 的 Emulation 而不是 setZoomFactor —— 后者按 host 存在
   * session 的 HostZoomMap 里：跨 host 导航就失效，还会被用户手动缩放污染，
   * 且污染跨 WebContentsView 实例存活（2026-09-08 spike 实测）。
   * override 跨 4 个 host 5 次导航恒 1280，且免疫手动 zoom。
   */
  private applyViewport(tabId: string, bounds: RectDip): void {
    const view = this.views.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;
    const w = Math.max(1, Math.round(bounds.width));
    const scale = w / LOGICAL_WIDTH;
    const height = Math.max(1, Math.round(bounds.height / scale));
    try {
      void view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: LOGICAL_WIDTH, height, deviceScaleFactor: 0, mobile: false, scale,
      });
    } catch (err) {
      logger.warn('browser.viewport', '设置逻辑视口失败', { tabId, err: String(err) });
    }
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
    catch (err) { logger.warn('browser.cdp', 'debugger attach 失败', { id, err: String(err) }); }
    this.emit();
    return id;
  }

  private wireView(id: string, view: WebContentsView): void {
    const wc = view.webContents;

    // 权限一律拒绝：这一期没有任何功能需要摄像头、麦克风、定位、通知。
    wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

    // target=_blank 不能被吞掉 —— 直接丢弃的话用户点一个新窗口链接会「什么都不发生」，
    // 而 CNKI 站内大量 _blank。deny 原生新窗口，改成在侧栏里新开一个标签。
    wc.setWindowOpenHandler(({ url }) => {
      const v = checkUrl(url);
      if (v.ok) {
        try {
          const newId = this.createTab(url, this.registry.ownerRunIdOf(id));
          void this.views.get(newId)?.webContents.loadURL(url);
        } catch (err) {
          // 撞上标签上限时不能把异常抛回 Electron 的 handler —— 那会让整个
          // setWindowOpenHandler 变成未捕获错误。如实记一条，链接不开。
          logger.warn('browser.popup', '新标签打开失败', { url, err: String(err) });
        }
      } else {
        logger.warn('browser.popup', '被 URL 闸拦下', { url, reason: v.reason });
      }
      return { action: 'deny' };
    });

    // URL 闸装在每一条入口上，不只是 browser.open 的参数：点链接、表单提交、
    // 服务端重定向、子 frame 都要过同一个判据。
    const guardNav = (e: { preventDefault: () => void }, url: string) => {
      const v = checkUrl(url);
      if (!v.ok) { e.preventDefault(); logger.warn('browser.nav', '被 URL 闸拦下', { url, reason: v.reason }); }
    };
    wc.on('will-navigate', (e, url) => guardNav(e, url));
    wc.on('will-redirect', (e, url) => guardNav(e, url));
    wc.on('will-frame-navigate', (e) => guardNav(e, e.url));

    wc.on('did-navigate', (_e, url, httpResponseCode) => {
      // 403 走的就是这条路：它是一次**成功**的导航，did-fail-load 不触发。
      this.navs.get(id)?.onDidNavigate(url, httpResponseCode);
      this.snapshots.delete(id);   // 页面换了，旧快照的编号一律作废
      this.syncTabMeta(id);
    });
    wc.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
      this.navs.get(id)?.onDidFailLoad(errorCode, errorDescription, isMainFrame);
    });
    wc.on('did-start-loading', () => this.syncTabMeta(id));
    wc.on('did-stop-loading', () => this.syncTabMeta(id));
    wc.on('page-title-updated', () => this.syncTabMeta(id));
    wc.on('render-process-gone', (_e, details) => {
      logger.warn('browser.crash', '页面进程没了', { id, reason: details.reason });
      // 在途导航要当场定论。不这样的话一次崩溃要挂满整个超时窗口，
      // 而且报出来的是 timeout —— 可我们明明知道发生了什么。
      this.navs.get(id)?.onCrashed(details.reason);
      this.syncTabMeta(id);
    });
  }

  private syncTabMeta(id: string): void {
    const view = this.views.get(id);
    if (!view || view.webContents.isDestroyed() || !this.registry.has(id)) return;
    const wc = view.webContents;
    this.registry.update(id, {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
    this.emit();
  }

  private destroyView(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    this.snapshots.delete(id);
    this.navs.delete(id);
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
    this.registry.activate(tabId);
    this.applyLayout();
    return { tabId, nav: await this.navigate(tabId, (wc) => wc.loadURL(url)) };
  }

  /** 所有会引发主 frame 导航的操作都经过这里 —— 观测结果要挂在**每一次**这样的操作上，
   *  不只是 browser.open：Scholar 的 403 出现在点提交按钮之后。 */
  private async navigate(tabId: string, act: (wc: WebContents) => Promise<unknown> | void): Promise<NavigationObservation> {
    const view = this.views.get(tabId);
    if (!view) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    const wc = view.webContents;

    const tracker = new NavigationTracker(randomUUID());
    this.navs.set(tabId, tracker);

    try { await act(wc); } catch { /* loadURL 在失败时会 reject，结论以事件为准 */ }

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      tracker.settledPromise,
      new Promise<void>((r) => { timer = setTimeout(r, NAV_TIMEOUT_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!tracker.settled) {
      // 到点先停，再作废这次导航：不然工具已经按 timeout 换了源，
      // 旧导航稍后还可能落进同一个标签，页面内容与 agent 以为的状态就对不上了。
      try { wc.stop(); } catch { /* 已经没了 */ }
      tracker.onTimeout();
    }
    if (this.navs.get(tabId) === tracker) this.navs.delete(tabId);
    this.syncTabMeta(tabId);
    if (this.stage) this.applyViewport(tabId, this.stage.bounds);
    return tracker.observation()!;
  }

  close(tabId: string): void { this.registry.close(tabId); this.destroyView(tabId); this.applyLayout(); this.emit(); }
  keep(tabId: string): void { this.registry.keep(tabId); this.emit(); }
  activate(tabId: string): void { this.registry.activate(tabId); this.applyLayout(); this.emit(); }

  async navControl(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    const view = this.views.get(tabId);
    if (!view) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    const h = view.webContents.navigationHistory;
    if (action === 'stop') { view.webContents.stop(); this.syncTabMeta(tabId); return; }
    await this.navigate(tabId, (wc) => {
      if (action === 'back' && h.canGoBack()) h.goBack();
      else if (action === 'forward' && h.canGoForward()) h.goForward();
      else if (action === 'reload') wc.reload();
    });
  }

  /** **挂在 agent_settled 上，不是 agent_end** —— pi 在 agent_end 之后仍可能自动重试，
   *  那时标签还属于同一轮 KyDog run。 */
  disposeForRun(runId: string): void {
    const gone = this.registry.disposeForRun(runId);
    for (const id of gone) this.destroyView(id);
    if (gone.length) { this.applyLayout(); this.emit(); }
  }

  disposeAll(): void {
    for (const id of this.registry.allIds()) { this.registry.close(id); this.destroyView(id); }
    this.stage = null;
  }

  // ── 快照（供工具层用） ───────────────────────────────────────────────────

  getSnapshot(tabId: string): AxSnapshot | null { return this.snapshots.get(tabId) ?? null; }

  /**
   * 取一份新快照。walker 在**隔离世界**里跑：页面覆写 `document.querySelectorAll`
   * 骗得到主世界，骗不到它（2026-09-08 spike 实测）；它的发号表挂在隔离世界的
   * window 上，页面既读不到也伪造不了。
   *
   * 每次都发一个新的 snapshotId —— 动作里的 `index` 必须带上它，只在那一份里解析。
   */
  async snapshot(tabId: string): Promise<AxSnapshot> {
    const wc = this.webContentsOf(tabId);
    if (!wc) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    const raw = await wc.executeJavaScriptInIsolatedWorld(WALKER_WORLD_ID, [{ code: WALKER_SOURCE }]) as {
      url: string; title: string; nodes: AxNode[]; total: number; truncated: boolean;
    };
    const snap: AxSnapshot = {
      snapshotId: `snap_${randomUUID().slice(0, 8)}`,
      url: raw.url, title: raw.title, nodes: raw.nodes,
    };
    this.snapshots.set(tabId, snap);
    return snap;
  }

  webContentsOf(tabId: string): WebContents | null {
    const v = this.views.get(tabId);
    return v && !v.webContents.isDestroyed() ? v.webContents : null;
  }
}

export const browserService = new BrowserService();
