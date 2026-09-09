import { KydogError } from '../../shared/errors';
import type { BrowserState, BrowserTabInfo, ViewportMode } from '../../shared/types';

/**
 * 标签账本。**纯记账，不碰 WebContentsView** —— 真正的 view 由 browserService
 * 按 id 另存一张表，那部分要真窗口、只能靠 e2e 覆盖。拆开是为了让归属、寿命、
 * 上限、接替这些容易出错的规则能被单测钉住。
 */

/** 上限是兜底，不是资源管理方案。真正控制数量的是两条设计：
 *  agent 开的在 run settle 时回收；同一个源的连续详情页复用一个标签。
 *  如果实际用起来经常撞上限，那是这两条没生效，回去改它们，不是抬高这个数。 */
export const MAX_TABS = 16;

type TabRecord = BrowserTabInfo & {
  ownerRunId: string | null;
  /**
   * agent 此刻正在驱动这个标签吗（spec §3 的 `Tab.isAgentActive`）。
   *
   * **与 `ownerRunId` 是两件事**：那个说的是「谁开的、回合结束要不要收走」，
   * 这个说的是「此刻是谁在操作」。spec §3 明写用户标签与 agent 标签不做能力隔离 ——
   * agent 完全可以驱动一个 `ownerRunId === null` 的用户标签，那时两个字段就分开了。
   *
   * 它存在的理由是 spec §5.1：页面里的 `window.open` 被转成新标签时，**新标签的归属
   * 按源标签当时的状态定，这是状态事实、不是猜**。没有这个字段，调用方只能拿
   * `ownerRunIdOf(源标签)` 当替身 —— 于是 agent 驱动用户标签弹出来的新标签
   * `ownerRunId` 也是 null，`agent_settled` 时不回收，一轮长检索下来标签只增不减。
   */
  isAgentActive: boolean;
};

export class TabRegistry {
  private tabs: TabRecord[] = [];
  private activeId: string | null = null;
  private rev = 0;
  private ep = 0;

  private touch(): void { this.rev += 1; }

  private indexOf(id: string): number {
    return this.tabs.findIndex((t) => t.id === id);
  }

  private require(id: string): TabRecord {
    const t = this.tabs[this.indexOf(id)];
    if (!t) throw new KydogError('browser.no_tab', `没有这个标签页：${id}`);
    return t;
  }

  get(id: string): TabRecord | undefined {
    return this.tabs[this.indexOf(id)];
  }

  has(id: string): boolean { return this.indexOf(id) !== -1; }

  ownerRunIdOf(id: string): string | null { return this.require(id).ownerRunId; }

  /**
   * 建一条标签记录。
   *
   * `activate` **默认 false**：新标签会不会顶掉用户正在看的那个，由**调用方按来源**
   * 决定，账本不替所有人拍板。页面里的每一个 `window.open` 都会被转成新标签
   * （browserService 的 `setWindowOpenHandler`），无条件抢活动标签等于让**页面内容**
   * 决定用户看到什么：用户正读着 t1，页面弹三个 `_blank`，可见的网页就跟着换三次，
   * 最后停在最后一个弹窗上。默认取「不抢」这一侧是因为两个方向的漏传代价不对称 ——
   * 漏传 true 只是「新标签没被切过去，用户点一下」，漏传 false 是屏幕被页面抢走。
   *
   * 但**账本里有标签就必须有活动标签**（`activeTabId` 非 null ⟺ `tabs` 非空）：
   * 第一个标签、以及关光之后新开的那个，无论 `activate` 给什么都会接上活动位，
   * 否则侧栏有标签却一个都不显示。
   */
  create(id: string, opts: { ownerRunId: string | null; url: string; activate?: boolean }): TabRecord {
    // 重复 id 不能静默覆盖：那会让上一个 WebContentsView 失去引用而泄漏，
    // 而且泄漏的那个还在后台跑着页面。
    if (this.has(id)) throw new KydogError('browser.bad_action', `标签页 id 重复：${id}`);
    if (this.tabs.length >= MAX_TABS) {
      throw new KydogError('browser.too_many_tabs',
        `已经开了 ${MAX_TABS} 个标签页。同一个源的连续详情页请复用一个标签，或先关掉不用的`);
    }
    const rec: TabRecord = {
      id, url: opts.url, title: '', loading: true,
      owner: opts.ownerRunId ? 'agent' : 'user',
      canGoBack: false, canGoForward: false,
      // 新标签一律从「适配」起步。**不继承别的标签的档位**：1:1 是用户对着某一页
      // 按下的一次性动作（看清那一个验证码），不是一个偏好设置。
      viewportMode: 'fit',
      ownerRunId: opts.ownerRunId,
      isAgentActive: false,
    };
    this.tabs.push(rec);
    if (opts.activate === true || this.activeId === null) this.activeId = id;
    this.touch();
    return rec;
  }

  /** 活动标签被移除时接替给右边那个，没有就左边，再没有就 null —— 与真浏览器一致。
   *
   *  **越界下标 fail-closed，不靠调用方守**：`splice(-1, 1)` 删的是**最右边那个**，
   *  而调用方手里的下标全部来自 `indexOf`，找不到时正是 -1。只靠 `close` 里那句
   *  `i === -1` 守卫的话，以后多一个调用方、它忘了先查，就是静默销毁用户最右边那个
   *  标签的账本记录 —— 而它的 `WebContentsView` 还留在 browserService 里跑着页面。 */
  private removeAt(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.tabs.length) {
      throw new KydogError('browser.no_tab', `标签下标越界：${String(i)}`);
    }
    const [gone] = this.tabs.splice(i, 1);
    if (this.activeId !== gone.id) return;
    this.activeId = this.tabs[i]?.id ?? this.tabs[i - 1]?.id ?? null;
  }

  close(id: string): void {
    const i = this.indexOf(id);
    if (i === -1) throw new KydogError('browser.no_tab', `没有这个标签页：${id}`);
    this.removeAt(i);
    this.touch();
  }

  /** 用户点「保留」：agent 的标签转成自己的，此后不会被回合结束的回收带走。 */
  keep(id: string): void {
    const t = this.require(id);
    if (t.ownerRunId === null) return;
    t.ownerRunId = null;
    t.owner = 'user';
    this.touch();
  }

  /**
   * 记下 agent 有没有在驱动这个标签。**在两个时机调，配成一对**（browserService 那一批）：
   * agent 驱动的一次操作开始前置 true，那次操作结束时（`finally`，无论成败）置回 false。
   *
   * **不推进 revision**：它不进 `BrowserState`（见 `toState`），推一帧内容完全相同的
   * 状态出去，只会让渲染层「按 revision 去旧」退化成「永远接受最新一帧」。
   */
  setAgentActive(id: string, active: boolean): void {
    this.require(id).isAgentActive = active;
  }

  isAgentActiveOf(id: string): boolean { return this.require(id).isAgentActive; }

  /**
   * 「1:1 / 适配」。**与 `setAgentActive` 相反，这一条要推 revision** ——
   * 它进 `BrowserState`（`BrowserTabInfo.viewportMode`），渲染层照着画开关，
   * 而 agent 会在 `markDriving` 里把它恢复成 `fit`：不推的话那一次恢复渲染层收不到，
   * 开关会停在 1:1 上，而页面已经回到 1280 了。
   *
   * 没有实际改动就不推（与 `update` 同一条规矩）：推一帧内容相同的状态出去，
   * 会让渲染层「按 revision 去旧」退化成「永远接受最新一帧」。
   */
  setViewportMode(id: string, mode: ViewportMode): void {
    const t = this.require(id);
    if (t.viewportMode === mode) return;
    t.viewportMode = mode;
    this.touch();
  }

  /** **不抛**：这是一个纯读取器，缺记录时给一个安全的默认档就够了，不必因为
   *  竞态去抛异常。（复审 N-1：三条销毁路径 —— `close` / `disposeForRun` /
   *  `disposeAll` —— 都是先摘账本、再摘 view、才 `applyLayout()`，所以「views
   *  里还有、账本已经没有」这个组合走不到：`applyViewport` 自己那句
   *  `this.views.get(tabId)` 会先行 return，问都问不到这里。这条 fail-open
   *  没有已知能触达它的路径，纯粹是防御纵深，不是在防一个具体的坏时序。） */
  viewportModeOf(id: string): ViewportMode { return this.get(id)?.viewportMode ?? 'fit'; }

  activate(id: string): void {
    this.require(id);
    if (this.activeId === id) return;
    this.activeId = id;
    this.touch();
  }

  update(id: string, patch: Partial<Pick<BrowserTabInfo, 'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward'>>): void {
    const t = this.require(id);
    // 没有实际改动就不推进 revision：否则渲染层每收到一帧都以为「有新东西」，
    // 而按 revision 去旧的机制会退化成「永远接受最新一帧」。
    const changed = (Object.keys(patch) as Array<keyof typeof patch>)
      .some((k) => patch[k] !== undefined && t[k] !== patch[k]);
    if (!changed) return;
    Object.assign(t, patch);
    this.touch();
  }

  /** 回收本轮 agent 开的标签，返回要销毁的 id。命不中就是空数组（**幂等**，第二遍什么都不做）。
   *  什么时候该调它，由 `browserService.disposeForRun` 那段注释统一说明（三个触发点，
   *  其中正常收尾挂的是 `agent_settled` 而不是 `agent_end`）。 */
  disposeForRun(runId: string): string[] {
    const doomed = this.tabs.filter((t) => t.ownerRunId === runId).map((t) => t.id);
    for (const id of doomed) this.removeAt(this.indexOf(id));
    if (doomed.length) this.touch();
    return doomed;
  }

  allIds(): string[] { return this.tabs.map((t) => t.id); }

  /** 渲染进程每次 bootstrap 拿一个新的 epoch，用来丢弃过期的 syncView 上报。
   *  由主进程签发 —— 渲染层自己数的计数器在组件重载后从同一个初值重新开始，分不出新旧。 */
  newEpoch(): number {
    this.ep += 1;
    // **epoch 变了 revision 必须跟着变。** 不推的话，紧接着 emit 出去的那一帧与上一帧
    // 同 revision —— 任何按上面 update 那条规则（revision 变了才算有新东西）实现的
    // 消费者都会整帧丢掉、继续用旧 epoch，于是它之后所有 syncView 都被判为过期丢弃，
    // 侧栏的网页永远拿不到 bounds、一直不可见，直到下一次真实标签变更才恢复。
    this.touch();
    return this.ep;
  }

  toState(): BrowserState {
    return {
      revision: this.rev,
      epoch: this.ep,
      activeTabId: this.activeId,
      // 深拷贝一层并抹掉**所有**主进程记账字段（ownerRunId / isAgentActive）：
      // 渲染层只该看到 owner。它们不是「顺手没带」—— 带上就等于让主进程的记账
      // 随每一次 browser.tabsChanged 广播上线。
      tabs: this.tabs.map(({ ownerRunId: _run, isAgentActive: _drive, ...pub }) => ({ ...pub })),
    };
  }
}
