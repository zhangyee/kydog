import { KydogError } from '../../shared/errors';
import type { BrowserState, BrowserTabInfo } from '../../shared/types';

/**
 * 标签账本。**纯记账，不碰 WebContentsView** —— 真正的 view 由 browserService
 * 按 id 另存一张表，那部分要真窗口、只能靠 e2e 覆盖。拆开是为了让归属、寿命、
 * 上限、接替这些容易出错的规则能被单测钉住。
 */

/** 上限是兜底，不是资源管理方案。真正控制数量的是两条设计：
 *  agent 开的在 run settle 时回收；同一个源的连续详情页复用一个标签。
 *  如果实际用起来经常撞上限，那是这两条没生效，回去改它们，不是抬高这个数。 */
export const MAX_TABS = 16;

type TabRecord = BrowserTabInfo & { ownerRunId: string | null };

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

  create(id: string, opts: { ownerRunId: string | null; url: string }): TabRecord {
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
      ownerRunId: opts.ownerRunId,
    };
    this.tabs.push(rec);
    this.activeId = id;
    this.touch();
    return rec;
  }

  /** 活动标签被移除时接替给右边那个，没有就左边，再没有就 null —— 与真浏览器一致。 */
  private removeAt(i: number): void {
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

  /** 回收本轮 agent 开的标签，返回要销毁的 id。**挂在 agent_settled 上，不是 agent_end** ——
   *  pi 在 agent_end 之后仍可能自动重试，那时标签还属于同一轮 KyDog run。 */
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
    return this.ep;
  }

  toState(): BrowserState {
    return {
      revision: this.rev,
      epoch: this.ep,
      activeTabId: this.activeId,
      // 深拷贝一层并抹掉 ownerRunId：它是主进程的记账字段，渲染层只该看到 owner。
      tabs: this.tabs.map(({ ownerRunId: _drop, ...pub }) => ({ ...pub })),
    };
  }
}
