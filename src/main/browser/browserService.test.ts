import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WALKER_SOURCE from './injected/walker.js?raw';
import PW_REGISTRAR_SOURCE from './injected/pwRegistrar.js?raw';
import INTERACT_SOURCE from './injected/interact.js?raw';
import { compileExtractPlan, extractExpression, type ExtractResult } from './extract';
import type { AxSnapshot } from './snapshot';

/**
 * browserService 的替身测试。
 *
 * 这个文件持有 WebContentsView、CDP、session 与导航事件，全量集成测试要真窗口
 * （那是 e2e 的事）。但**接线本身**是可以被替身钉住的：哪个 Electron 事件喂给状态机的
 * 哪个输入、时限罩不罩得住 act、rejection 有没有人接、日志里有没有凭据、广播里有没有
 * epoch —— 这些都是纯粹的调用关系，替身能考，而且这些正是四位评审在这个文件里
 * 找出来的那四条 Critical 的形状。
 */

const H = vi.hoisted(() => {
  type Fn = (...args: never[]) => void;

  class Emitter {
    readonly handlers = new Map<string, Fn[]>();
    on(ev: string, fn: Fn): this {
      const list = this.handlers.get(ev) ?? [];
      list.push(fn);
      this.handlers.set(ev, list);
      return this;
    }
    once(ev: string, fn: Fn): this { return this.on(ev, fn); }
    /** 让用例扮演 Chromium：把一个真实事件打进来。 */
    fire(ev: string, ...args: unknown[]): void {
      for (const fn of [...(this.handlers.get(ev) ?? [])]) (fn as (...a: unknown[]) => void)(...args);
    }
    listenerCount(ev: string): number { return (this.handlers.get(ev) ?? []).length; }
  }

  class FakeDebugger extends Emitter {
    attached = false;
    /** 每一条发出去的 CDP 命令，按顺序。 */
    readonly sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    attachThrows: Error | null = null;
    /** 默认成功。用例可以换成 rejected promise（§A 的三个触发点都是这个形状）。 */
    respond: () => Promise<unknown> = () => Promise.resolve({});
    attach(): void {
      if (this.attachThrows) throw this.attachThrows;
      this.attached = true;
    }
    detach(): void { this.attached = false; }
    isAttached(): boolean { return this.attached; }
    sendCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
      this.sent.push({ method, params });
      return this.respond();
    }
  }

  class FakeWebContents extends Emitter {
    readonly debugger = new FakeDebugger();
    destroyed = false;
    url = '';
    title = '';
    loading = false;
    /** 关联的渲染进程 pid。**默认 0** —— 与真实的全新 WebContentsView 一致：
     *  还没 load 过任何页面时它就是 0，那时发 CDP 命令会让主进程 SIGSEGV（实测）。 */
    osPid = 0;
    stopCalls = 0;
    reloadCalls = 0;
    closeCalls = 0;
    readonly loadCalls: string[] = [];
    /** loadURL 的返回值。默认立刻 resolve；§D 的用例换成永不 resolve 的那种。 */
    loadImpl: () => Promise<unknown> = () => Promise.resolve();
    /** 隔离世界里跑的脚本，按顺序（walker / 密码登记都走这里）。 */
    readonly isolated: Array<{ worldId: number; code: string }> = [];
    isolatedImpl: (code: string) => Promise<unknown> = () => Promise.resolve(undefined);
    windowOpenHandler: ((d: { url: string }) => unknown) | null = null;
    historyIndex = 1;
    historyEntries: string[] = ['https://prev.example/', 'https://cur.example/'];
    readonly navigationHistory = {
      canGoBack: () => this.historyIndex > 0,
      canGoForward: () => this.historyIndex < this.historyEntries.length - 1,
      goBack: () => { this.historyIndex -= 1; },
      goForward: () => { this.historyIndex += 1; },
      getActiveIndex: () => this.historyIndex,
      length: () => this.historyEntries.length,
      getEntryAtIndex: (i: number) => ({ url: this.historyEntries[i], title: '' }),
    };
    isDestroyed(): boolean { return this.destroyed; }
    getURL(): string { return this.url; }
    getTitle(): string { return this.title; }
    isLoading(): boolean { return this.loading; }
    getOSProcessId(): number { return this.osPid; }
    stop(): void { this.stopCalls += 1; }
    reload(): void { this.reloadCalls += 1; }
    close(): void { this.closeCalls += 1; this.destroyed = true; }
    setWindowOpenHandler(fn: (d: { url: string }) => unknown): void { this.windowOpenHandler = fn; }
    loadURL(u: string): Promise<unknown> { this.loadCalls.push(u); this.url = u; return this.loadImpl(); }
    executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>): Promise<unknown> {
      this.isolated.push({ worldId, code: scripts[0].code });
      return this.isolatedImpl(scripts[0].code);
    }
  }

  const views: FakeWebContentsView[] = [];

  class FakeWebContentsView {
    readonly webContents = new FakeWebContents();
    visible: boolean | null = null;
    bounds: { x: number; y: number; width: number; height: number } | null = null;
    constructor(readonly options: unknown) { views.push(this); }
    setVisible(v: boolean): void { this.visible = v; }
    setBounds(b: { x: number; y: number; width: number; height: number }): void { this.bounds = b; }
  }

  class FakeBrowserWindow extends Emitter {
    readonly children: FakeWebContentsView[] = [];
    readonly contentView = {
      addChildView: (v: FakeWebContentsView) => { this.children.push(v); },
      removeChildView: (v: FakeWebContentsView) => {
        const i = this.children.indexOf(v);
        if (i !== -1) this.children.splice(i, 1);
      },
    };
  }

  class FakeSession extends Emitter {
    permissionRequestHandler: ((wc: unknown, perm: string, cb: (ok: boolean) => void) => void) | null = null;
    permissionCheckHandler: (() => boolean) | null = null;
    permissionRequestSets = 0;
    permissionCheckSets = 0;
    setPermissionRequestHandler(fn: typeof this.permissionRequestHandler): void {
      this.permissionRequestHandler = fn; this.permissionRequestSets += 1;
    }
    setPermissionCheckHandler(fn: typeof this.permissionCheckHandler): void {
      this.permissionCheckHandler = fn; this.permissionCheckSets += 1;
    }
  }

  let sess = new FakeSession();

  const logs: Array<{ level: string; scope: string; msg: string; ctx?: unknown }> = [];
  const emitted: Array<{ topic: string; payload: unknown }> = [];

  return {
    views, logs, emitted,
    FakeWebContentsView, FakeBrowserWindow, FakeSession,
    session: { fromPartition: () => sess },
    getSess: () => sess,
    reset: () => {
      views.length = 0; logs.length = 0; emitted.length = 0;
      sess = new FakeSession();
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: H.FakeBrowserWindow,
  WebContentsView: H.FakeWebContentsView,
  session: H.session,
}));

vi.mock('../log', () => ({
  logger: {
    debug: (scope: string, msg: string, ctx?: unknown) => H.logs.push({ level: 'debug', scope, msg, ctx }),
    info: (scope: string, msg: string, ctx?: unknown) => H.logs.push({ level: 'info', scope, msg, ctx }),
    warn: (scope: string, msg: string, ctx?: unknown) => H.logs.push({ level: 'warn', scope, msg, ctx }),
    error: (scope: string, msg: string, ctx?: unknown) => H.logs.push({ level: 'error', scope, msg, ctx }),
  },
}));

vi.mock('../ipc/broadcaster', () => ({
  broadcaster: { emit: (topic: string, payload: unknown) => H.emitted.push({ topic, payload }) },
}));

const { BrowserService, WALKER_WORLD_ID, PAGE_EVAL_TIMEOUT_MS } = await import('./browserService');

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 让排在微任务里的那几步（enqueue → navigate → loadURL）真的跑起来。 */
const flush = async (n = 8): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

type Svc = InstanceType<typeof BrowserService>;

function make(): { svc: Svc; win: InstanceType<typeof H.FakeBrowserWindow> } {
  H.reset();
  const svc = new BrowserService();
  const win = new H.FakeBrowserWindow();
  svc.attach(win as never);
  return { svc, win };
}

const wcOf = (i = 0) => H.views[i].webContents;

/** 起一次 open 并把导航事件打进去，返回结果。 */
async function openTab(svc: Svc, url = 'https://a.example/', ownerRunId: string | null = null) {
  const p = svc.open({ url, ownerRunId });
  await flush();
  const wc = H.views[H.views.length - 1].webContents;
  wc.osPid = 4321;                       // 导航提交了，渲染进程这时才有
  wc.fire('did-navigate', {}, url, 200);
  return { nav: (await p), wc };
}

const logText = () => JSON.stringify(H.logs);

const overrides = (wc: ReturnType<typeof wcOf>) =>
  wc.debugger.sent.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride');

const STAGE = { epoch: 1, visible: true, occluded: false, bounds: { x: 10, y: 20, width: 640, height: 900 } };

beforeEach(() => { H.reset(); });
afterEach(() => { vi.useRealTimers(); });

// ── §F 串行队列 ───────────────────────────────────────────────────────────

describe('enqueue：同一个标签排队，跨标签并行', () => {
  it('同一个标签：后一个不许在前一个结束之前开始', async () => {
    const { svc } = make();
    const order: string[] = [];
    let releaseA!: () => void;
    const a = svc.enqueue('t1', async () => {
      order.push('a-start');
      await new Promise<void>((r) => { releaseA = r; });
      order.push('a-end');
    });
    const b = svc.enqueue('t1', async () => { order.push('b-start'); });
    await flush();
    expect(order).toEqual(['a-start']);   // b 还没被允许开始
    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('跨标签仍然并行 —— 一个标签卡住，另一个标签照跑', async () => {
    const { svc } = make();
    const order: string[] = [];
    void svc.enqueue('t1', () => new Promise<void>(() => { order.push('t1-start'); }));  // 永不结束
    const other = svc.enqueue('t2', async () => { order.push('t2-done'); });
    await other;
    expect(order).toEqual(['t1-start', 't2-done']);
  });

  it('一次失败不许让这个标签的队列永久卡住', async () => {
    const { svc } = make();
    await expect(svc.enqueue('t1', () => Promise.reject(new Error('炸了')))).rejects.toThrow('炸了');
    await expect(svc.enqueue('t1', () => Promise.resolve('后一个照样跑'))).resolves.toBe('后一个照样跑');
  });

  // 队尾那句 `.then(() => {}, () => {})` 真正挡住的是**这个**：队列里存着的是一个
  // 已经 rejected 的 promise，而调用方（弹窗那条路、以及将来任何 `void enqueue(...)`）
  // 有可能一个 handler 都不挂 —— 那就是一次未处理 rejection，Node ≥15 直接上抛成
  // uncaughtException，主进程弹框退出。
  // 顺带把因果说清楚（上一条用例的名字容易读反）：**让队列继续往下走的也是队尾这一句**
  // —— 它把 rejection 吞掉，于是存进 `queues` 的 `prev` 永不 reject。正因为如此，
  // `prev.then(fn, fn)` 的第二个 `fn` 在当前接线下**不可达**（把它去掉是等价变异，
  // 一条都不红）。两者是防御纵深，不是「第二个 fn 在挡卡死」。
  it('调用方一个 handler 都不挂时，失败也不许冒成未处理 rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { svc } = make();
      void svc.enqueue('t1', () => Promise.reject(new Error('没人接的失败')));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // 标签销毁时 `destroyView` 要把它的队列条目一起删掉，否则 `queues` 只增不减
  // （上限 16 个标签，反复开关是常态，每个死标签都留一个 promise）。
  // 从外面看得见的后果是这条：**同一个 tabId 上的新调用会挂在死标签那条队列后面。**
  // 关标签时队首那次导航正卡着（20 秒时限）的话，队列条目就是一个永远不 settle 的
  // promise —— 不删的话此后这个 id 上的每一次 enqueue 都永远轮不到。
  it('关标签时把它的队列条目也清掉，别让新调用挂在死标签的队尾', async () => {
    const { svc } = make();
    await openTab(svc);
    const id = svc.getState().tabs[0].id;
    void svc.enqueue(id, () => new Promise<void>(() => { /* 永不结束：在途的那次导航 */ }));
    await flush();
    svc.close(id);
    let ran = false;
    const after = svc.enqueue(id, async () => { ran = true; return '轮得到'; });
    await flush();
    expect(ran).toBe(true);
    await expect(after).resolves.toBe('轮得到');
  });

  it('open 与 navControl 都走队列：前一次没结束，后一次不许动这个标签', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.loadImpl = () => new Promise(() => {});    // 这一次永远不返回
    const first = svc.open({ url: 'https://slow.example/' , tabId: svc.getState().tabs[0].id });
    await flush();
    const loadsAfterFirst = wc.loadCalls.length;
    void svc.navControl(svc.getState().tabs[0].id, 'reload');
    await flush();
    expect(wc.reloadCalls).toBe(0);              // 排在队里，一次都没执行
    expect(wc.loadCalls.length).toBe(loadsAfterFirst);
    await vi.advanceTimersByTimeAsync(20_000);
    await first;
    await flush();
    expect(wc.reloadCalls).toBe(1);              // 前一个收尾之后才轮到它
  });
});

// ── §D 时限必须罩住 act ───────────────────────────────────────────────────

describe('导航时限罩住 act 本身（§D）', () => {
  it('loadURL 永不 resolve 时，open 仍然按时限返回 timeout，而不是挂死', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const p = svc.open({ url: 'https://hang.example/' });
    await flush();
    const wc = wcOf();
    wc.loadImpl = () => new Promise(() => {});
    // 上面那次 open 已经调过 loadURL 了（loadImpl 默认 resolve），换一条路重来：
    // 直接让这个标签再开一次，这一次 loadURL 永不返回。
    wc.fire('did-navigate', {}, 'https://hang.example/', 200);
    await p;

    const p2 = svc.open({ url: 'https://hang.example/2', tabId: svc.getState().tabs[0].id });
    await flush();
    let settled = false;
    void p2.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(19_000);
    await flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    const r = await p2;
    expect(r.nav.outcome).toEqual({ kind: 'timeout', abortObserved: false });
    expect(wc.stopCalls).toBe(1);   // 到点先 stop 再作废
  });

  it('act 同步抛出也不许把 navigate 掀翻 —— 结论仍然以事件为准', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    const id = svc.getState().tabs[0].id;
    wc.loadImpl = () => { throw new Error('同步炸'); };
    const p = svc.open({ url: 'https://x.example/y', tabId: id });
    await flush();
    wc.fire('did-navigate', {}, 'https://x.example/y', 200);
    const r = await p;
    expect(r.nav.outcome).toMatchObject({ kind: 'ok', httpStatusCode: 200 });
  });
});

// ── §A CDP rejection ──────────────────────────────────────────────────────

describe('CDP 的 rejection 必须被接住（§A）', () => {
  it('sendCommand reject 不会冒成未处理 rejection，只记一条日志', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { svc } = make();
      await openTab(svc);
      const wc = wcOf();
      wc.debugger.respond = () => Promise.reject(new Error('Debugger is not attached to the target'));
      svc.syncView({ ...STAGE, epoch: svc.getState().epoch });
      await flush();
      await new Promise((r) => setTimeout(r, 0));   // 给 unhandledRejection 一个真实的 tick
      expect(unhandled).toEqual([]);
      expect(logText()).toContain('设置逻辑视口失败');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('debugger attach 失败之后，后续每一次布局都不再发 CDP 命令', async () => {
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/' });
    await flush();
    const wc = wcOf();
    // 建标签那一刻 attach 就失败了：此后 isAttached() 恒 false。
    wc.debugger.attached = false;
    wc.fire('did-navigate', {}, 'https://a.example/', 200);
    await p;
    const before = wc.debugger.sent.length;
    svc.syncView({ ...STAGE, epoch: svc.getState().epoch });
    await flush();
    expect(wc.debugger.sent.length).toBe(before);
  });

  it('DevTools 顶掉 attach（detach 事件）：记一条日志，之后不再发命令', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.debugger.fire('detach', {}, 'target closed');
    wc.debugger.attached = false;      // detach 之后 Electron 那边就是这个状态
    const before = wc.debugger.sent.length;
    svc.syncView({ ...STAGE, epoch: svc.getState().epoch });
    await flush();
    expect(wc.debugger.sent.length).toBe(before);
    expect(logText()).toContain('CDP 断开');
  });

  it('同一个标签的 CDP 断开只记一条日志，不刷屏', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.debugger.fire('detach', {}, 'a');
    wc.debugger.fire('detach', {}, 'b');
    wc.debugger.fire('detach', {}, 'c');
    expect(H.logs.filter((l) => l.msg.includes('CDP 断开')).length).toBe(1);
  });

  it('还没有渲染进程时一个 CDP 命令都不许发（实测：那会让主进程 SIGSEGV）', async () => {
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/' });
    await flush();
    const wc = wcOf();
    // 建标签那一刻 getOSProcessId() 就是 0（实测：全新的 WebContentsView 没有渲染进程）。
    // 这条闸挡的不是一个 reject，是一次真的段错误 —— 接不住，只能不发。
    expect(wc.getOSProcessId()).toBe(0);
    expect(overrides(wc).length).toBe(0);
    svc.syncView({ ...STAGE, epoch: svc.getState().epoch });
    await flush();
    expect(overrides(wc).length).toBe(0);   // 拖分栏也不许把命令发出去
    wc.debugger.fire('detach', {}, 'x');    // 就算别的路子也来一遍，还是不发
    wc.osPid = 4321;
    wc.fire('did-navigate', {}, 'https://a.example/', 200);
    await p;
    expect(overrides(wc).length).toBeGreaterThan(0);   // 渲染进程在了才发
  });
});

// ── §B 侧栏没打开也一样 ───────────────────────────────────────────────────

describe('侧栏没打开时照样下发 1280（§B）', () => {
  it('从来没有 syncView 过：dom-ready 上就把 1280 逻辑视口发下去', async () => {
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/' });
    await flush();
    const wc = wcOf();
    wc.osPid = 4321;                 // 文档已经在了，渲染进程随之存在
    wc.fire('dom-ready');
    await flush();
    const cmd = overrides(wc)[0];
    expect(cmd).toBeDefined();
    expect(cmd.params).toEqual({
      width: 1280, height: 800, deviceScaleFactor: 0, mobile: false, scale: 1,
    });
    wc.fire('did-navigate', {}, 'https://a.example/', 200);
    await p;
  });

  it('取快照之前一定先坐实视口 —— 顺序不能反', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.isolatedImpl = () => Promise.resolve(walkerOut());
    const seq: string[] = [];
    const realRespond = wc.debugger.respond;
    wc.debugger.respond = () => { seq.push('cdp'); return realRespond(); };
    wc.isolatedImpl = (code) => {
      seq.push(code === WALKER_SOURCE ? 'walker' : 'other');
      return Promise.resolve(walkerOut());
    };
    await svc.snapshot(svc.getState().tabs[0].id);
    expect(seq).toEqual(['cdp', 'walker']);
  });

  // 上面那条断的是「发出顺序」——`sendCommand` 本身是**同步**把 'cdp' 推进 seq 的，
  // 收尾那句改成 await 还是 void 顺序都不变，所以它区分不了两者（复审 M16）。
  // 这里换一条真的区分先后的用例：override 落地之前，walker 压根不许被执行。
  // 背景标签的第一次快照、以及不经过 navigate() 的调用方（Task 4 的动作派发）
  // 走的都是这一句 —— 比 navigate() 收尾那句更承重。
  it('snapshot() 收尾必须 await 视口：override 落地之前 walker 不许先跑', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    const id = svc.getState().tabs[0].id;
    wc.isolatedImpl = () => Promise.resolve(walkerOut());
    let land!: () => void;
    wc.debugger.respond = () => new Promise((r) => { land = () => r({}); });
    const p = svc.snapshot(id);
    await flush();
    expect(wc.isolated.length).toBe(0);   // CDP 命令还没落地，walker 不许先跑
    land();
    await p;
    expect(wc.isolated.length).toBe(1);
  });

  // navigate() 收尾那一发是防御纵深（snapshot() 里那句也在守），但它是**唯一**
  // 保证「open 返回时视口已经落地」的一句：调用方拿到导航结论之后未必立刻取快照，
  // 中间任何一次读几何（Task 4 的动作派发按快照坐标点击）都要求它已经落定。
  it('navigate 收尾要 await 视口：override 还在路上时 open 不许先返回', async () => {
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/' });
    await flush();
    const wc = wcOf();
    wc.osPid = 4321;
    let land!: () => void;
    wc.debugger.respond = () => new Promise((r) => { land = () => r({}); });
    wc.fire('did-navigate', {}, 'https://a.example/', 200);
    let done = false;
    void p.then(() => { done = true; });
    await flush();
    expect(overrides(wc).length).toBeGreaterThan(0);   // 发出去了
    expect(done).toBe(false);                          // 但还没落地，不许返回
    land();
    await p;
    expect(done).toBe(true);
  });

  it('侧栏有几何时按几何算 scale，宽度恒 1280', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    svc.syncView({ ...STAGE, epoch: svc.getState().epoch });
    await flush();
    const last = overrides(wc).at(-1)!;
    // 640 宽的舞台：scale = 640/1280 = 0.5，高度按 scale 反算 900/0.5 = 1800。
    expect(last.params).toEqual({
      width: 1280, height: 1800, deviceScaleFactor: 0, mobile: false, scale: 0.5,
    });
  });

  it('后台标签也要跟着改视口，不只活动的那个（§G）', async () => {
    const { svc } = make();
    await openTab(svc, 'https://a.example/');
    await openTab(svc, 'https://b.example/');
    const [first, second] = [wcOf(0), wcOf(1)];
    const beforeFirst = overrides(first).length;
    const beforeSecond = overrides(second).length;
    svc.syncView({ ...STAGE, epoch: svc.getState().epoch });
    await flush();
    expect(overrides(first).length).toBe(beforeFirst + 1);
    expect(overrides(second).length).toBe(beforeSecond + 1);
  });

  it('hideAll 只是不给人看：视口照旧下发', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    const before = overrides(wc).length;
    svc.hideAll();
    await flush();
    expect(H.views[0].visible).toBe(false);
    expect(overrides(wc).length).toBe(before + 1);
    expect(overrides(wc).at(-1)!.params.width).toBe(1280);
  });
});

// ── §C target=_blank ──────────────────────────────────────────────────────

describe('_blank 新标签要走完整的一条路（§C）', () => {
  it('建标签 → 布局 → 视口 → 导航，全都要有', async () => {
    const { svc } = make();
    await openTab(svc);
    const opener = wcOf();
    const r = opener.windowOpenHandler!({ url: 'https://popup.example/p' });
    expect(r).toEqual({ action: 'deny' });         // 原生新窗口一律拒绝
    await flush();
    expect(H.views.length).toBe(2);
    const popup = wcOf(1);
    expect(popup.loadCalls).toEqual(['https://popup.example/p']);   // 真的导航了
    expect(H.views[1].visible).not.toBeNull();                      // applyLayout 走到了
  });

  it('弹窗不抢活动标签 —— 页面内容不许决定用户看什么', async () => {
    const { svc } = make();
    await openTab(svc);
    const firstId = svc.getState().activeTabId;
    wcOf().windowOpenHandler!({ url: 'https://popup.example/p' });
    await flush();
    expect(svc.getState().tabs.length).toBe(2);
    expect(svc.getState().activeTabId).toBe(firstId);
  });

  it('弹窗的归属按源标签当时的状态定：agent 在驱动就归这一轮 run', async () => {
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/', ownerRunId: 'run-1' });
    await flush();
    const wc = wcOf();
    // 这一刻 agent 正在驱动源标签（open 还没返回）
    wc.windowOpenHandler!({ url: 'https://popup.example/p' });
    await flush();
    expect(svc.getState().tabs[1].owner).toBe('agent');
    wc.fire('did-navigate', {}, 'https://a.example/', 200);
    await p;
    // 驱动窗口结束之后再弹的那个归用户
    wc.windowOpenHandler!({ url: 'https://popup2.example/p' });
    await flush();
    expect(svc.getState().tabs[2].owner).toBe('user');
  });

  it('两轮 run 同时在跑：先结束的那一次不许清掉另一次的驱动标志', async () => {
    const { svc } = make();
    const pA = svc.open({ url: 'https://a.example/', ownerRunId: 'run-A' });
    await flush();
    const wcA = wcOf(0);
    const pB = svc.open({ url: 'https://b.example/', ownerRunId: 'run-B' });
    await flush();
    const wcB = wcOf(1);

    wcA.osPid = 4321;
    wcA.fire('did-navigate', {}, 'https://a.example/', 200);
    await pA;                                   // A 先结束

    // B 还在跑，它的标签弹出来的新标签仍然该归 agent
    wcB.windowOpenHandler!({ url: 'https://popup.example/x' });
    await flush();
    expect(svc.getState().tabs.at(-1)!.owner).toBe('agent');

    wcB.osPid = 4321;
    wcB.fire('did-navigate', {}, 'https://b.example/', 200);
    await pB;
  });

  it('两轮同时在跑时，弹窗归**开它的那一轮**，不是恰好压在栈顶的那一轮', async () => {
    const { svc } = make();
    const pA = svc.open({ url: 'https://a.example/', ownerRunId: 'run-A' });
    await flush();
    const wcA = wcOf(0);
    const pB = svc.open({ url: 'https://b.example/', ownerRunId: 'run-B' });
    await flush();
    const wcB = wcOf(1);

    // A 的标签弹出来的新标签归 run-A：归错的话 run-B settle 时会把它一起收走
    wcA.windowOpenHandler!({ url: 'https://popup.example/from-a' });
    await flush();
    const popupId = svc.getState().tabs.at(-1)!.id;

    wcA.osPid = 4321; wcA.fire('did-navigate', {}, 'https://a.example/', 200); await pA;
    wcB.osPid = 4321; wcB.fire('did-navigate', {}, 'https://b.example/', 200); await pB;

    svc.disposeForRun('run-B');
    expect(svc.getState().tabs.map((t) => t.id)).toContain(popupId);
    svc.disposeForRun('run-A');
    expect(svc.getState().tabs.map((t) => t.id)).not.toContain(popupId);
  });

  it('弹窗被 URL 闸拦下：不建标签，也不抛回 Electron 的 handler', async () => {
    const { svc } = make();
    await openTab(svc);
    const r = wcOf().windowOpenHandler!({ url: 'http://127.0.0.1:8080/admin' });
    await flush();
    expect(r).toEqual({ action: 'deny' });
    expect(H.views.length).toBe(1);
  });

  it('撞标签上限时 handler 不抛异常，只记一条', async () => {
    const { svc } = make();
    await openTab(svc);
    for (let i = 0; i < 15; i++) {
      wcOf().windowOpenHandler!({ url: `https://popup.example/${i}` });
      await flush();
    }
    expect(svc.getState().tabs.length).toBe(16);
    expect(() => wcOf().windowOpenHandler!({ url: 'https://popup.example/over' })).not.toThrow();
    expect(logText()).toContain('新标签打开失败');
  });
});

// ── §E1 广播不许带 epoch ──────────────────────────────────────────────────

describe('browser.tabsChanged 的载荷不含 epoch（§E1）', () => {
  it('每一帧都不含，getState 仍然含', async () => {
    const { svc } = make();
    svc.newEpoch();
    await openTab(svc);
    svc.activate(svc.getState().tabs[0].id);
    expect(H.emitted.length).toBeGreaterThan(0);
    for (const e of H.emitted) {
      expect(e.topic).toBe('browser.tabsChanged');
      expect(Object.keys(e.payload as object)).not.toContain('epoch');
    }
    expect(svc.getState().epoch).toBe(1);
  });
});

// ── §E2 日志里不许有凭据 ──────────────────────────────────────────────────

describe('日志里只留 origin + pathname（§E2）', () => {
  const SECRET = 'hunter2secret';

  it('被 URL 闸拦下的导航：不回显整条网址', async () => {
    const { svc } = make();
    await openTab(svc);
    wcOf().fire('will-navigate', {
      preventDefault: () => {}, url: `https://svc:${SECRET}@10.0.0.5/admin?token=${SECRET}`, isMainFrame: true,
    });
    expect(logText()).not.toContain(SECRET);
    expect(logText()).toContain('被 URL 闸拦下');
  });

  it('弹窗被拦下：同样不回显', async () => {
    const { svc } = make();
    await openTab(svc);
    wcOf().windowOpenHandler!({ url: `https://svc:${SECRET}@127.0.0.1/x` });
    expect(logText()).not.toContain(SECRET);
  });

  it('新标签打开失败：query 里的 token 也不许落盘', async () => {
    const { svc } = make();
    await openTab(svc);
    for (let i = 0; i < 15; i++) {
      wcOf().windowOpenHandler!({ url: `https://popup.example/${i}` });
      await flush();
    }
    wcOf().windowOpenHandler!({ url: `https://ok.example/paper?token=${SECRET}` });
    await flush();
    expect(logText()).toContain('新标签打开失败');
    expect(logText()).not.toContain(SECRET);
  });

  it('取消下载：item 的原始网址不整条落盘', async () => {
    const { svc } = make();
    await openTab(svc);
    fireDownload(`https://svc:${SECRET}@files.example/a.pdf?key=${SECRET}`, wcOf());
    expect(logText()).toContain('按策略取消下载');
    expect(logText()).not.toContain(SECRET);
  });

  it('留下的仍然够定位：host 与 path 还在', async () => {
    const { svc } = make();
    await openTab(svc);
    wcOf().fire('will-navigate', {
      preventDefault: () => {}, url: 'https://10.0.0.5/admin/panel?token=x', isMainFrame: true,
    });
    expect(logText()).toContain('10.0.0.5/admin/panel');
    expect(logText()).not.toContain('token=x');
  });
});

// ── §E3 导航观测的接线 ────────────────────────────────────────────────────

function fireDownload(url: string, wc: ReturnType<typeof wcOf>, chain: string[] = []): void {
  H.getSess().fire('will-download', { preventDefault: () => {} }, {
    getURL: () => url,
    getMimeType: () => 'application/pdf',
    getFilename: () => 'paper.pdf',
    getURLChain: () => chain,
  }, wc);
}

describe('NavigationTracker 的输入全部接上（§E3）', () => {
  it('被 URL 闸拦下 → blocked，不必等满时限', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    const p = svc.open({ url: 'https://a.example/next', tabId: svc.getState().tabs[0].id });
    await flush();
    wc.fire('will-redirect', { preventDefault: () => {}, url: 'http://169.254.169.254/latest/meta-data/', isMainFrame: true });
    const r = await p;
    expect(r.nav.outcome).toMatchObject({ kind: 'blocked' });
  });

  it('子 frame 被拦下不替整页定论', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    const p = svc.open({ url: 'https://a.example/next', tabId: svc.getState().tabs[0].id });
    await flush();
    wc.fire('will-frame-navigate', { preventDefault: () => {}, url: 'http://10.1.2.3/ad', isMainFrame: false });
    await flush();
    wc.fire('did-navigate', {}, 'https://a.example/next', 200);
    const r = await p;
    expect(r.nav.outcome).toMatchObject({ kind: 'ok' });
  });

  // **`will-frame-navigate` 这一条也必须去定论。** 第五批的交接清单写的是「不要在
  // will-frame-navigate 上调 onBlocked」，那条清单是错的：2026-09-08 实测
  // （Electron 41.2.1）主 frame 被拦时，两条由同一个 throttle 发出、
  // `will-frame-navigate` **先发**且 `preventDefault()` 之后 `will-navigate` 根本不发 ——
  // 它是唯一走得到的那条。这条不定论，被拦的主 frame 导航就要跑满 20 秒报 timeout。
  // **不许只 `await p`**：关联/定论一断，这种写法不是明确地红，而是等满 vitest 的
  // 默认超时，报出来的是「测试超时」而不是「被拦的主 frame 导航没有定论」（见下面两条
  // reload/back 用例同样的写法与理由）。改成显式的 done 标志。
  it('主 frame 的 will-frame-navigate 被拦 → 当场 blocked，不必等满时限', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    const p = svc.open({ url: 'https://a.example/next', tabId: svc.getState().tabs[0].id });
    await flush();
    let prevented = 0;
    wc.fire('will-frame-navigate', {
      preventDefault: () => { prevented += 1; },
      url: 'http://169.254.169.254/latest/meta-data/', isMainFrame: true,
    });
    let done = false;
    let outcome: unknown;
    void p.then((r) => { outcome = r.nav.outcome; done = true; });
    await flush();
    expect(done).toBe(true);          // 一秒都没推进就定论了，不必等满时限
    expect(prevented).toBe(1);
    expect(outcome).toMatchObject({ kind: 'blocked' });
    expect(H.logs.filter((l) => l.msg === '被 URL 闸拦下').length).toBe(1);
  });

  it('同文档导航 → ok_same_document，并且作废快照编号', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    const id = svc.getState().tabs[0].id;
    wc.isolatedImpl = () => Promise.resolve(walkerOut());
    await svc.snapshot(id);
    expect(svc.getSnapshot(id)).not.toBeNull();

    const p = svc.open({ url: 'https://a.example/#sec2', tabId: id });
    await flush();
    wc.fire('did-navigate-in-page', {}, 'https://a.example/#sec2', true);
    const r = await p;
    expect(r.nav.outcome).toMatchObject({ kind: 'ok_same_document' });
    // 同文档也要作废：坐标是视口内的 CSS 像素，hash 跳转会滚动页面
    expect(svc.getSnapshot(id)).toBeNull();
  });

  it('子 frame 的同文档导航既不定论也不作废快照', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    const id = svc.getState().tabs[0].id;
    wc.isolatedImpl = () => Promise.resolve(walkerOut());
    await svc.snapshot(id);
    const p = svc.open({ url: 'https://a.example/next', tabId: id });
    await flush();
    wc.fire('did-navigate-in-page', {}, 'https://ad.example/frame', false);
    await flush();
    expect(svc.getSnapshot(id)).not.toBeNull();
    wc.fire('did-navigate', {}, 'https://a.example/next', 200);
    await p;
  });

  it('下载能与本次导航对上（靠构造时的目标 URL）→ download', async () => {
    const { svc } = make();
    const p = svc.open({ url: 'https://files.example/paper.pdf' });
    await flush();
    fireDownload('https://files.example/paper.pdf', wcOf());
    const r = await p;
    expect(r.nav.outcome).toMatchObject({ kind: 'download', filename: 'paper.pdf' });
  });

  it('对不上的下载不许冒充终态', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/' });
    await flush();
    fireDownload('https://ads.example/tracker.pdf', wcOf());
    await flush();
    wcOf().fire('did-navigate', {}, 'https://a.example/', 200);
    const r = await p;
    expect(r.nav.outcome).toMatchObject({ kind: 'ok' });
  });

  it('重定向链上的下载靠 getURLChain 对上', async () => {
    const { svc } = make();
    const p = svc.open({ url: 'https://doi.org/10.1/x' });
    await flush();
    fireDownload('https://publisher.example/final.pdf', wcOf(), ['https://doi.org/10.1/x', 'https://publisher.example/final.pdf']);
    const r = await p;
    expect(r.nav.outcome).toMatchObject({ kind: 'download' });
  });

  it('did-start-navigation 只喂关联集合，自己不定论', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/' });
    await flush();
    const wc = wcOf();
    wc.fire('did-start-navigation', { url: 'https://a.example/redirected.pdf', isMainFrame: true, isSameDocument: false });
    await flush();
    let done = false;
    void p.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);                       // 没定论
    fireDownload('https://a.example/redirected.pdf', wc);
    const r = await p;
    expect(r.nav.outcome).toMatchObject({ kind: 'download' });   // 但它进了关联集合
  });

  it('跨文档在途时，旧文档的 pushState 不算本次导航的结果', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/next' });
    await flush();
    const wc = wcOf();
    wc.fire('did-start-navigation', { url: 'https://a.example/next', isMainFrame: true, isSameDocument: false });
    wc.fire('did-navigate-in-page', {}, 'https://a.example/old#x', true);
    await flush();
    let done = false;
    void p.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    wc.fire('did-navigate', {}, 'https://a.example/next', 200);
    const r = await p;
    expect(r.nav.outcome).toMatchObject({ kind: 'ok' });
  });

  it('关标签 → 在途的观测当场定论成 cancelled，不白等 20 秒', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/' });
    await flush();
    svc.close(svc.getState().tabs[0].id);
    const r = await p;
    expect(r.nav.outcome).toEqual({ kind: 'cancelled' });
  });

  it('页面崩溃 → crashed', async () => {
    const { svc } = make();
    const p = svc.open({ url: 'https://a.example/' });
    await flush();
    wcOf().fire('render-process-gone', {}, { reason: 'oom' });
    const r = await p;
    expect(r.nav.outcome).toEqual({ kind: 'crashed', reason: 'oom' });
  });

  // navControl 返回 void，拿不到 observation —— 所以断言落在**它有没有当场定论**上：
  // 假时钟下不推进一秒，那次 navControl 就必须已经 settle（关联成 download 才会这样），
  // 而且 tracker 不会去 stop（onTimeout 在已定论时直接返回）。
  // **不许只 `await p`**：关联一断，那种写法不是明确地红，而是等满 vitest 的默认超时，
  // 报出来的还是「测试超时」而不是「下载没对上」。
  it('reload 的目标 URL 进关联集合：直链 PDF 的下载对得上', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    await openTab(svc, 'https://files.example/paper.pdf');
    const wc = wcOf();
    wc.url = 'https://files.example/paper.pdf';
    const id = svc.getState().tabs[0].id;
    const p = svc.navControl(id, 'reload');
    await flush();
    expect(wc.reloadCalls).toBe(1);
    const stopsBefore = wc.stopCalls;
    fireDownload('https://files.example/paper.pdf', wc);
    let done = false;
    void p.then(() => { done = true; });
    await flush();
    expect(done).toBe(true);                    // 一秒都没推进就定论了
    expect(wc.stopCalls).toBe(stopsBefore);     // 定论成 download，不该再去 stop
    await p;
  });

  it('back 的目标取的是历史里上一条', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    await openTab(svc, 'https://cur.example/');
    const wc = wcOf();
    const id = svc.getState().tabs[0].id;
    const p = svc.navControl(id, 'back');
    await flush();
    expect(wc.historyIndex).toBe(0);
    const stopsBefore = wc.stopCalls;
    fireDownload('https://prev.example/', wc);       // 与 back 的目标对得上
    let done = false;
    void p.then(() => { done = true; });
    await flush();
    expect(done).toBe(true);
    expect(wc.stopCalls).toBe(stopsBefore);
    await p;
  });
});

// ── §G 四条 ───────────────────────────────────────────────────────────────

describe('权限 handler 与广播节流（§G）', () => {
  it('request 与 check 两个 handler 都装，且都拒绝', async () => {
    const { svc } = make();
    await openTab(svc);
    const sess = H.getSess();
    expect(sess.permissionCheckHandler).not.toBeNull();
    expect(sess.permissionCheckHandler!()).toBe(false);
    let answered: boolean | null = null;
    sess.permissionRequestHandler!(null, 'media', (ok) => { answered = ok; });
    expect(answered).toBe(false);
  });

  it('两个 handler 是 session 级的，开 3 个标签也只设一次', async () => {
    const { svc } = make();
    await openTab(svc, 'https://a.example/');
    await openTab(svc, 'https://b.example/');
    await openTab(svc, 'https://c.example/');
    expect(H.views.length).toBe(3);
    expect(H.getSess().permissionRequestSets).toBe(1);
    expect(H.getSess().permissionCheckSets).toBe(1);
  });

  it('标题跑马灯：revision 没推进就不广播', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.title = '加载中…';
    wc.fire('page-title-updated');
    const after = H.emitted.length;
    for (let i = 0; i < 20; i++) wc.fire('page-title-updated');   // 同一个标题，反复来
    expect(H.emitted.length).toBe(after);
    wc.title = '检索结果';
    wc.fire('page-title-updated');
    expect(H.emitted.length).toBe(after + 1);
  });

  it('disposeAll 幂等：跑第二遍什么都不做', async () => {
    const { svc } = make();
    await openTab(svc, 'https://a.example/');
    await openTab(svc, 'https://b.example/');
    svc.disposeAll();
    expect(svc.getState().tabs).toEqual([]);
    const after = H.emitted.length;
    expect(() => svc.disposeAll()).not.toThrow();
    expect(H.emitted.length).toBe(after);
  });

  it('disposeAll 之后 view 真的被销毁、也从窗口上摘掉了', async () => {
    const { svc, win } = make();
    await openTab(svc);
    svc.disposeAll();
    expect(win.children.length).toBe(0);
    expect(wcOf().closeCalls).toBe(1);
  });

  it('停止不排队 —— 它要打断的正是队首那一次', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.loadImpl = () => new Promise(() => {});
    const id = svc.getState().tabs[0].id;
    const slow = svc.open({ url: 'https://slow.example/', tabId: id });
    await flush();
    await svc.navControl(id, 'stop');
    expect(wc.stopCalls).toBe(1);          // 立刻执行，不等前面那次导航
    await vi.advanceTimersByTimeAsync(20_000);
    await slow;
  });
});

// ── 窗口生命周期 ──────────────────────────────────────────────────────────

describe('窗口没了之后不许再往它上面挂 view', () => {
  it('closed 之后建标签报「还没有装配到窗口上」', async () => {
    const { svc, win } = make();
    win.fire('closed');
    await expect(svc.open({ url: 'https://a.example/' })).rejects.toThrow('浏览器还没有装配到窗口上');
  });
});

// ── 快照 ──────────────────────────────────────────────────────────────────

const walkerOut = (over: Record<string, unknown> = {}) => ({
  generation: 'gen-1',
  url: 'https://a.example/',
  title: 'T',
  nodes: [{ index: 1, nodeId: 7, role: 'button', name: '搜索', x: 0, y: 0, w: 100, h: 20 }],
  collection: { truncated: false, returned: 1, totalKnown: 1 },
  iframes: 2,
  ...over,
});

describe('快照：一个字段都不丢，采集失败也不掀翻调用方（§E4）', () => {
  it('walker 报回来的字段原样透传，只补一个 snapshotId', async () => {
    const { svc } = make();
    await openTab(svc);
    wcOf().isolatedImpl = () => Promise.resolve(walkerOut());
    const snap = await svc.snapshot(svc.getState().tabs[0].id);
    expect(snap).toMatchObject({
      generation: 'gen-1', iframes: 2,
      collection: { truncated: false, returned: 1, totalKnown: 1 },
    });
    expect(snap.snapshotId).toMatch(/^snap_/);
  });

  it('walker 跑在隔离世界里，世界 id 与 extract 一致', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.isolatedImpl = () => Promise.resolve(walkerOut());
    await svc.snapshot(svc.getState().tabs[0].id);
    const walkerRun = wc.isolated.find((r) => r.code === WALKER_SOURCE)!;
    expect(walkerRun.worldId).toBe(WALKER_WORLD_ID);
  });

  it('采集脚本 reject：不抛，退回一份显式标注没采全的空快照', async () => {
    const { svc } = make();
    await openTab(svc);
    wcOf().isolatedImpl = () => Promise.reject(new Error('Script failed to execute'));
    const snap = await svc.snapshot(svc.getState().tabs[0].id);
    expect(snap.nodes).toEqual([]);
    // 「我没采到」与「页面上没有」不许长得一样
    expect(snap.collection).toEqual({ truncated: true, returned: 0 });
    expect(logText()).toContain('取快照失败');
  });

  it('采集脚本返回的东西不是一份快照：同样退回空快照而不是让下游读到 undefined', async () => {
    const { svc } = make();
    await openTab(svc);
    wcOf().isolatedImpl = () => Promise.resolve({ nodes: 'not-an-array' });
    const snap = await svc.snapshot(svc.getState().tabs[0].id);
    expect(snap.collection.truncated).toBe(true);
    expect(snap.nodes).toEqual([]);
  });

  it('失败的那份快照给一个全新世代：下一次 diff 退回全量，不许硬配', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.isolatedImpl = () => Promise.resolve(walkerOut());
    const good = await svc.snapshot(svc.getState().tabs[0].id);
    wc.isolatedImpl = () => Promise.reject(new Error('boom'));
    const bad = await svc.snapshot(svc.getState().tabs[0].id);
    expect(bad.generation).not.toBe(good.generation);
  });
});

// ── E3b 常驻密码登记 ──────────────────────────────────────────────────────
//
// walker.js 与 pwRegistrar.js 都在网页里执行、类型系统管不到它们，所以照
// snapshot.test.ts 那套办法：用 new Function 把两份源码**真的跑起来**，配一套替身 DOM。

type FakeStyle = { visibility: string; display: string; opacity: string };

class FakeEl {
  attrs: Record<string, string> = {};
  kids: FakeEl[] = [];
  shadowRoot: FakeRoot | null = null;
  interactive = false;
  innerText = '';
  nodeType = 1;
  style: FakeStyle = { visibility: 'visible', display: 'block', opacity: '1' };
  rect = { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 };
  type?: string;
  value?: string;
  constructor(readonly tagName: string, init: Partial<FakeEl> = {}) { Object.assign(this, init); }
  matches(): boolean { return this.interactive; }
  getAttribute(name: string): string | null {
    const k = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  getBoundingClientRect() { return this.rect; }
  getElementsByTagName(tag: string): FakeEl[] {
    return flatten(this.kids).filter((e) => e.tagName.toUpperCase() === tag.toUpperCase());
  }
}

class FakeRoot {
  constructor(public kids: FakeEl[]) {}
  querySelectorAll(sel: string): FakeEl[] {
    const all = flatten(this.kids);
    if (sel === '*') return all;
    const tags = sel.split(',').map((t) => t.trim().toUpperCase());
    return all.filter((e) => tags.indexOf(e.tagName.toUpperCase()) !== -1);
  }
  getElementsByTagName(tag: string): FakeEl[] {
    return flatten(this.kids).filter((e) => e.tagName.toUpperCase() === tag.toUpperCase());
  }
}

const flatten = (els: FakeEl[]): FakeEl[] => els.flatMap((e) => [e, ...flatten(e.kids)]);
const el = (tagName: string, init: Partial<FakeEl> = {}) => new FakeEl(tagName, init);
const pwInput = (init: Partial<FakeEl> = {}) =>
  new FakeEl('INPUT', { interactive: true, type: 'password', value: 'hunter2', ...init });

/** MutationObserver 的记录。字段名与形状照 DOM 规范，脚本读哪几个就给哪几个。 */
type MoRecord = {
  type: 'attributes' | 'childList';
  target?: FakeEl;
  attributeName?: string;
  oldValue?: string | null;
  addedNodes?: FakeEl[];
};
type MoOptions = {
  childList?: boolean; subtree?: boolean;
  attributes?: boolean; attributeFilter?: string[]; attributeOldValue?: boolean;
};
type FakeObserver = { cb: (records: MoRecord[]) => void; target: unknown; options: MoOptions | null };

type World = {
  crypto: Crypto;
  getComputedStyle: (e: FakeEl) => FakeStyle;
  MutationObserver: new (cb: (records: MoRecord[]) => void) => { observe(t: unknown, o: MoOptions): void };
  /** 这个世界里装起来的观察器，按装的顺序。用例扮演 Chromium 时往这里投递记录。 */
  __observers: FakeObserver[];
};

/**
 * 替身世界。**`MutationObserver` 挂在这个 window 上**（不是 node 的全局）——
 * 脚本注进的是页面的隔离世界，「这个世界有没有 MutationObserver」是那个 window 的
 * 事实。脚本读裸全局的话这里塞什么都看不见，常驻观察那半边就一条用例都覆盖不到。
 */
const newWorld = (): World => {
  const observers: FakeObserver[] = [];
  class FakeMutationObserver {
    private readonly rec: FakeObserver;
    constructor(cb: (records: MoRecord[]) => void) {
      this.rec = { cb, target: null, options: null };
      observers.push(this.rec);
    }
    observe(target: unknown, options: MoOptions): void { this.rec.target = target; this.rec.options = options; }
    disconnect(): void { this.rec.options = null; }
  }
  return {
    crypto: globalThis.crypto,
    getComputedStyle: (e: FakeEl) => e.style,
    MutationObserver: FakeMutationObserver,
    __observers: observers,
  };
};

const worldPwOf = (win: World) =>
  (win as World & { __kydogWorld: { pw: WeakSet<object> } }).__kydogWorld.pw;

/**
 * 扮演 Chromium 投递变动记录。**一个任务里的若干处改动攒成一批一起投递**，
 * 投递时元素身上已经是**改完之后**的状态 —— MutationObserver 的回调是微任务批处理，
 * 规范如此，而这正是「只看元素当下的 type」会漏掉的那种情形。
 *
 * 投递按每个观察器自己登记的 `options` 过滤，不按用例的心愿：
 * 没登记 `attributeOldValue` 的，记录里的 `oldValue` 就是 `null`（规范如此）；
 * 没登记 `subtree` 的收不到嵌套改动；一个观察器都没装的，什么都收不到。
 */
class DomStage {
  private readonly pending: Array<MoRecord & { parent?: unknown }> = [];
  constructor(private readonly win: World, private readonly observedRoot: unknown) {}

  insert(parent: FakeRoot | FakeEl, node: FakeEl): this {
    (parent as { kids: FakeEl[] }).kids.push(node);
    this.pending.push({ type: 'childList', addedNodes: [node], parent });
    return this;
  }

  setType(node: FakeEl, next: string): this {
    const old = node.type ?? null;
    node.type = next;
    this.pending.push({ type: 'attributes', attributeName: 'type', target: node, oldValue: old });
    return this;
  }

  deliver(): this {
    const batch = this.pending.splice(0);
    for (const o of this.win.__observers) {
      const opt = o.options;
      if (!opt) continue;
      const out: MoRecord[] = [];
      for (const r of batch) {
        if (r.type === 'childList') {
          if (!opt.childList) continue;
          if (r.parent !== this.observedRoot && !opt.subtree) continue;
          out.push({ type: 'childList', addedNodes: r.addedNodes });
          continue;
        }
        if (!opt.attributes) continue;
        if (opt.attributeFilter && opt.attributeFilter.indexOf(r.attributeName!) === -1) continue;
        out.push({
          type: 'attributes', attributeName: r.attributeName, target: r.target,
          oldValue: opt.attributeOldValue ? r.oldValue : null,
        });
      }
      if (out.length) o.cb(out);
    }
    return this;
  }
}

function docOf(root: FakeRoot) {
  return Object.assign(root, {
    title: 'T', getElementById: () => null, documentElement: null,
  });
}

function runWalker(win: object, root: FakeRoot) {
  const run = new Function('window', 'document', 'location', `const __out =\n${WALKER_SOURCE}\nreturn __out;`);
  return run(win, docOf(root), { href: 'https://a.example/' }) as {
    nodes: Array<{ name: string; value?: string; isPassword?: boolean }>;
  };
}

function runRegistrar(win: object, root: FakeRoot) {
  const run = new Function('window', 'document', `const __out =\n${PW_REGISTRAR_SOURCE}\nreturn __out;`);
  return run(win, docOf(root)) as { registered: boolean; scanned: number; observing: boolean };
}

describe('常驻密码登记（E3b）', () => {
  it('a · 首次快照之前站点就把 type 改成了 text：明文仍然不进快照', () => {
    const win = newWorld();
    const box = pwInput({ attrs: {}, innerText: '' });
    const root = new FakeRoot([box]);
    // 用户手输密码 → 登记（dom-ready 时它还是 password 态）
    runRegistrar(win, root);
    // 站点点了「显示密码」，把 type 改成 text —— 这个文档从头到尾没有过一次 password 态的快照
    box.type = 'text';
    const out = runWalker(win, root);
    expect(out.nodes[0].isPassword).toBe(true);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('a′ · 没有登记的话明文真的会漏 —— 这条反过来钉住上一条不是空绿', () => {
    const win = newWorld();
    const box = pwInput();
    const root = new FakeRoot([box]);
    box.type = 'text';                 // 不跑登记
    const out = runWalker(win, root);
    expect(out.nodes[0].isPassword).toBeUndefined();
    expect(JSON.stringify(out)).toContain('hunter2');
  });

  it('c · 排在遍历上限之外的密码框照样登记得到（登记不受任何遍历上限约束）', () => {
    const win = newWorld();
    const box = pwInput();
    // 前面 80001 个垃圾元素，walker 的遍历会在 MAX_WALKED 处停手、根本走不到 box
    const junk = Array.from({ length: 80_001 }, () => el('SPAN'));
    const big = new FakeRoot([...junk, box]);
    const first = runWalker(win, big);
    expect(first.nodes).toEqual([]);            // 遍历停在半路，密码框连走都没走到

    // 登记走的是 getElementsByTagName('input')，与遍历上限无关
    runRegistrar(win, big);
    // 站点随后把前面的内容清掉、把 type 改成 text
    box.type = 'text';
    const out = runWalker(win, new FakeRoot([box]));
    expect(out.nodes[0].isPassword).toBe(true);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('b · 换掉整个元素这条**仍然堵不住** —— 如实登记，别当成已经解决', () => {
    const win = newWorld();
    const oldBox = pwInput({ attrs: { name: 'j_pass', id: 'input-42', autocomplete: 'off' } });
    const root = new FakeRoot([oldBox]);
    runRegistrar(win, root);
    // jQuery 那类「显示密码」插件：新建一个 text input，把值搬过去，再 replaceWith
    const fresh = el('INPUT', {
      interactive: true, type: 'text', value: 'hunter2',
      attrs: { name: 'j_pass2', id: 'input-43', autocomplete: 'off' },
    });
    root.kids = [fresh];
    const out = runWalker(win, root);
    // 新元素从来没有过 password 态，两侧都记不到它：这条边界是真的
    expect(out.nodes[0].isPassword).toBeUndefined();
    expect(JSON.stringify(out)).toContain('hunter2');
  });

  it('登记与 walker 的判据必须是同一套：同一份 DOM 喂给两边，登记结果逐个相等', () => {
    const cases: Array<[string, FakeEl]> = [
      ['大写 PASSWORD 的 type', el('INPUT', { type: 'PASSWORD' })],
      ['XHTML 的小写 input', el('input', { type: 'password' })],
      ['普通 text', el('INPUT', { type: 'text' })],
      ['autocomplete 声明的（登记不管，判据 3 在快照时读得到）', el('INPUT', { type: 'text', attrs: { autocomplete: 'current-password' } })],
      ['名字里带 pwd 的（同上，判据 4）', el('INPUT', { type: 'text', attrs: { name: 'user_pwd' } })],
      ['textarea', el('TEXTAREA', {})],
      ['不是表单控件', el('A', { attrs: { name: 'password-reset' } })],
    ];
    for (const [label, node] of cases) {
      // walker 侧：让元素不可见，collect 早退 —— 这样 world.pw 里就只剩遍历那一层
      // 的登记（rememberIfPassword），也就是「会消失的那条判据」本身。
      node.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      const w1 = newWorld() as World & { __kydogWorld?: { pw: WeakSet<object> } };
      runWalker(w1, new FakeRoot([node]));
      const byWalker = w1.__kydogWorld!.pw.has(node);

      const w2 = newWorld() as World & { __kydogWorld?: { pw: WeakSet<object> } };
      runRegistrar(w2, new FakeRoot([node]));
      const byRegistrar = w2.__kydogWorld!.pw.has(node);

      expect(`${label}: ${byRegistrar}`).toBe(`${label}: ${byWalker}`);
    }
  });

  it('登记先跑时也要把世代建对 —— 少一个 gen，跨文档的快照会被读成「没有变化」', () => {
    const w1 = newWorld();
    runRegistrar(w1, new FakeRoot([el('INPUT', { type: 'text' })]));
    const a = runWalker(w1, new FakeRoot([el('BUTTON', { interactive: true, innerText: '搜索' })])) as unknown as { generation: string };
    const w2 = newWorld();
    runRegistrar(w2, new FakeRoot([]));
    const b = runWalker(w2, new FakeRoot([el('BUTTON', { interactive: true, innerText: '搜索' })])) as unknown as { generation: string };
    expect(typeof a.generation).toBe('string');
    expect(a.generation.length).toBeGreaterThan(8);
    expect(b.generation).not.toBe(a.generation);
  });

  it('dom-ready 上真的把登记脚本注进了 walker 的那个世界', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.isolated.length = 0;
    wc.fire('dom-ready');
    await flush();
    const run = wc.isolated.find((r) => r.code === PW_REGISTRAR_SOURCE);
    expect(run).toBeDefined();
    expect(run!.worldId).toBe(WALKER_WORLD_ID);
  });

  // ── 常驻观察器（登记跑完之后页面还在动的那半边）────────────────────────────

  it('常驻观察 · 插入与改 type 落在同一个任务里：记录一起到，也要登记得住', () => {
    const win = newWorld();
    const root = new FakeRoot([]);
    runRegistrar(win, root);          // dom-ready：这一屏上一个 input 都还没有
    // 多步登录的第二屏：密码框插进来，站点在**同一个任务里**顺手把 type 改成 text
    // （「显示密码」默认打开的那种）。回调是微任务批处理，两条记录一起到，
    // 而那一刻元素当下的 type 已经是 text —— 只看当下就漏了，得看记录里的旧值。
    const box = pwInput({ type: 'password' });
    new DomStage(win, root).insert(root, box).setType(box, 'text').deliver();
    expect(worldPwOf(win).has(box)).toBe(true);
    // 端到端：随后的快照里明文不许出现
    const out = runWalker(win, root);
    expect(out.nodes[0].isPassword).toBe(true);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('常驻观察 · 后插入的是一整块子树，密码框在里面：也要递归登记', () => {
    const win = newWorld();
    const root = new FakeRoot([]);
    runRegistrar(win, root);
    // 折叠面板 / 第二屏是整块插进来的，addedNodes 里只有那个容器，
    // 密码框是它的后代 —— 只 remember 容器本身等于一个都没记。
    const box = pwInput({ type: 'password' });
    const panel = el('DIV', { kids: [el('LABEL'), box] });
    new DomStage(win, root).insert(root, panel).deliver();
    expect(worldPwOf(win).has(box)).toBe(true);
    // 之后站点再把 type 改掉，快照里也不会有明文
    box.type = 'text';
    const out = runWalker(win, root);
    expect(out.nodes[0].isPassword).toBe(true);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  // 上面那条插的是容器（panel），考的是 rememberTree 对子树的递归
  // （node.getElementsByTagName('input')）。这一条插的是密码框自己 —— 考的是
  // rememberTree 对「新增节点自己」这一步（remember(node) 那一行）：
  // addedNodes 里的元素本身就是 <input type=password>，没有子节点可递归。
  it('常驻观察 · dom-ready 之后插入一个 password 框（元素本身，不是容器）：也要登记得住', () => {
    const win = newWorld();
    const root = new FakeRoot([]);
    runRegistrar(win, root);          // dom-ready：这一屏还没有密码框
    const box = pwInput({ type: 'password' });
    new DomStage(win, root).insert(root, box).deliver();
    expect(worldPwOf(win).has(box)).toBe(true);
    const out = runWalker(win, root);
    expect(out.nodes[0].isPassword).toBe(true);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('常驻观察 · 登记的观察范围就是与 Chromium 的那份契约', () => {
    const win = newWorld();
    const root = new FakeRoot([]);
    const out = runRegistrar(win, root);
    expect(out.observing).toBe(true);
    expect(win.__observers.length).toBe(1);
    expect(win.__observers[0].target).toBe(root);
    // 少一样都会让上面两条漏：没有 attributeOldValue 就看不到「此前是 password」，
    // 没有 subtree 就收不到嵌套插入，没有 attributeFilter 就是白收一堆无关记录。
    expect(win.__observers[0].options).toEqual({
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['type'], attributeOldValue: true,
    });
  });

  // 上面那条只断言了「注册时带没带 subtree」这份契约，没有一条行为用例真的
  // 让 subtree 派上用场 —— 之前两条 childList 用例插入的都是 observedRoot 的
  // **直接**子节点（parent === root），不需要 subtree 也收得到投递。
  // 这才是多步登录第二屏的真实形状：第二屏的密码框插在一个早就在页面里的深层
  // 容器（<div id=app><div class=step2>…</div></div>）下面，不是直接挂在 body 上。
  it('常驻观察 · 密码框插在深层容器里（多步登录第二屏的真实形状），subtree 接得住', () => {
    const win = newWorld();
    const step2 = el('DIV', {});
    const app = el('DIV', { kids: [step2] });
    const root = new FakeRoot([app]);
    runRegistrar(win, root);          // dom-ready：第二屏还没出现
    const box = pwInput({ type: 'password' });
    // 插入点是 step2，不是 observedRoot（root）本身 —— 没有 subtree 就收不到这条记录
    new DomStage(win, root).insert(step2, box).deliver();
    expect(worldPwOf(win).has(box)).toBe(true);
    const out = runWalker(win, root);
    expect(out.nodes[0].isPassword).toBe(true);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('常驻观察 · 同一个文档里登记跑第二次，观察器不许装第二个', () => {
    const win = newWorld();
    const root = new FakeRoot([]);
    runRegistrar(win, root);
    runRegistrar(win, root);          // 子 frame 的 dom-ready 也会把主进程那条监听器打起来
    expect(win.__observers.length).toBe(1);
    // 而且第一个仍然是活的
    const box = pwInput({ type: 'password' });
    new DomStage(win, root).insert(root, box).setType(box, 'text').deliver();
    expect(worldPwOf(win).has(box)).toBe(true);
  });

  it('登记脚本执行失败只记一条日志，不掀翻任何一次工具调用', async () => {
    const { svc } = make();
    await openTab(svc);
    const wc = wcOf();
    wc.isolatedImpl = () => Promise.reject(new Error('页面导航走了'));
    wc.fire('dom-ready');
    await flush();
    expect(logText()).toContain('密码登记没能装上');
  });
});

// ── 密码判据三方差分：walker ↔ extract ↔ interact ──────────────────────────
//
// extract.ts 从前只有一条判据（此刻 IDL type === 'password'），而它的注释明写「与
// walker 用的是同一个协议层判据」——那句话是假的：walker 有四条。这条差分用例是
// 三边不再漂移的唯一保障（照 D8 那条裁决的办法：不物理共享，用差分用例守）。
//
// **interact.js 是第三方**（Task 4 新增）：它是 `type` 动作的第二道密码闸 ——
// selector 定位时快照那一层压根看不出目标是不是密码框，只有拿到活元素的它能判。
// 判据写窄一条，`type {selector:'#pwd'}` 就能绕过整条硬闸。
//
// **三边各跑在自己的世界里**：让 walker 先跑就等于替另外两边把 world.pw 填好，
// 那样这组用例会全绿而什么都没考到（walker 判 hit 时会 world.pw.add）。
//
// 每一条都带**期望值**（不只是「三边相等」）：只断言相等的话，三边一起漂到
// 「全都不算密码框」也照样绿 —— 那正是这条用例要挡的事故本身。
describe('walker ↔ extract ↔ interact 的密码判据三方差分', () => {
  type PwWorld = World & { __kydogWorld?: { pw: WeakSet<object> } };

  /** walker 侧的裁决：元素可见且命中选择器，看它有没有被打上 isPassword。 */
  const walkerSays = (node: FakeEl, pre?: (w: PwWorld, r: FakeRoot) => void): boolean => {
    const w = newWorld() as PwWorld;
    const root = new FakeRoot([node]);
    pre?.(w, root);
    const out = runWalker(w, root);
    return out.nodes.some((n) => n.isPassword === true);
  };

  /** extract 侧的裁决：@value 被抹成 null 就是「判成密码框」。 */
  const extractSays = (node: FakeEl, pre?: (w: PwWorld, r: FakeRoot) => void): boolean => {
    const w = newWorld() as PwWorld;
    const root = new FakeRoot([node]);
    pre?.(w, root);
    const plan = compileExtractPlan({ item: '.row', v: 'target@value' });
    const doc = { querySelectorAll: () => [{ querySelector: (s: string) => (s === 'target' ? node : null) }] };
    const build = new Function('window', 'document', 'HTMLInputElement',
      `return (${extractExpression(plan)});`) as (w: unknown, d: unknown, i: unknown) => ExtractResult;
    // HTMLInputElement 只参与 hidden/value 那一条判据（另有用例），这里给一个够不着的类
    return build(w, doc, class {}).rows[0].v === null;
  };

  /** interact 侧的裁决：`readValue` 被拒成 password 就是「判成密码框」。 */
  const interactSays = (node: FakeEl, pre?: (w: PwWorld, r: FakeRoot) => void): boolean => {
    const w = newWorld() as PwWorld;
    const root = new FakeRoot([node]);
    pre?.(w, root);
    const doc = { querySelector: (s: string) => (s === 'target' ? node : null) };
    const build = new Function('window', 'document', `return (${INTERACT_SOURCE});`) as
      (win: unknown, d: unknown) => (req: unknown) => { ok: boolean; reason?: string };
    const r = build(w, doc)({ op: 'readValue', target: { selector: 'target' } });
    return r.ok === false && r.reason === 'password';
  };

  /** 三边都要读得到 value：walker 读 IDL `el.value`，extract 读 `getAttribute('value')`，
   *  interact 读 IDL `el.value`。 */
  const box = (tagName: string, init: Partial<FakeEl> = {}) =>
    el(tagName, { interactive: true, value: 'hunter2', ...init,
      attrs: { value: 'hunter2', ...(init.attrs ?? {}) } });

  const cases: Array<[string, FakeEl, boolean]> = [
    ['判据 1 · 此刻就是 password', box('INPUT', { type: 'password' }), true],
    ['判据 1 · 大写 PASSWORD', box('INPUT', { type: 'PASSWORD' }), true],
    ['判据 3 · autocomplete=current-password 的 text', box('INPUT', { type: 'text', attrs: { autocomplete: 'Section-Blue CURRENT-PASSWORD' } }), true],
    ['判据 3 · new-password', box('INPUT', { type: 'text', attrs: { autocomplete: 'new-password' } }), true],
    ['判据 4 · name 里带 password', box('INPUT', { type: 'text', attrs: { name: 'password' } }), true],
    ['判据 4 · id 里带 pwd', box('INPUT', { type: 'text', attrs: { id: 'user_pwd' } }), true],
    ['判据 4 · textarea 也算', box('TEXTAREA', { attrs: { name: 'j_passwd' } }), true],
    ['不算 · 普通检索框', box('INPUT', { type: 'text', attrs: { name: 'q' } }), false],
    ['不算 · autocomplete=username', box('INPUT', { type: 'text', attrs: { autocomplete: 'username' } }), false],
    ['不算 · submit 按钮（装不下用户打进去的文本）', box('INPUT', { type: 'submit', attrs: { name: 'passwordSubmit' } }), false],
    ['不算 · <a name=password-reset>', box('A', { attrs: { name: 'password-reset' } }), false],
  ];

  for (const [label, node, expected] of cases) {
    it(`${label}：三边裁决相等，且都等于期望值`, () => {
      expect({ walker: walkerSays(node), extract: extractSays(node), interact: interactSays(node) })
        .toEqual({ walker: expected, extract: expected, interact: expected });
    });
  }

  // 判据 2 单独一条：它不是元素身上的属性，而是隔离世界里那份记忆。
  // 评审实测的场景 A —— 站点点「显示密码」把 type 改成 text，walker 判 isPassword，
  // 而 extract 从前返回 "hunter2"。
  it('判据 2 · 曾经是 password（world.pw 记忆）：两边裁决相等，且都判成密码框', () => {
    const mk = () => box('INPUT', { type: 'password' });
    const flip = (w: PwWorld, r: FakeRoot) => {
      runRegistrar(w, r);                                  // dom-ready 时还是 password 态
      (r.kids[0] as FakeEl).type = 'text';                 // 站点点了「显示密码」
    };
    // 三个各自新建：flip 会把 type 改成 text，同一个元素跑第二遍时
    // runRegistrar 已经看不到 password 态了 —— 那样测的就不是判据 2。
    const a = mk(); const b = mk(); const c = mk();
    expect(walkerSays(a, flip)).toBe(true);
    expect(extractSays(b, flip)).toBe(true);
    expect(interactSays(c, flip)).toBe(true);
  });

  it('判据 2′ · 同一个元素没有那份记忆时三边都放行 —— 上一条不是空绿', () => {
    const node = box('INPUT', { type: 'text', attrs: { name: 'q', value: 'hunter2' } });
    expect(walkerSays(node)).toBe(false);
    expect(extractSays(node)).toBe(false);
    expect(interactSays(node)).toBe(false);
  });
});

// ── §G 动作派发（Task 4）────────────────────────────────────────────────────
//
// **两道闸的依据是实测，不是推理**（Electron 41.2.1，2026-09-08，show:false +
// 独立 userData，每个情形一个独立进程，3/3 复现）。一个全新的、还没 load 过任何页面的
// WebContentsView（`getOSProcessId() === 0`）上发命令：
//
// | 命令 | 结果 |
// | --- | --- |
// | `Input.dispatchMouseEvent`（pressed/released/moved/wheel 四种） | reject `Internal error` |
// | `Input.insertText` | **永不 settle** —— 进程退出时才以 "target closed" reject |
// | `Input.dispatchKeyEvent` | resolve `{}`（静默无效） |
//
// 三种失败形状各不相同、没有一种会自己说出「这个标签还没法操作」：insertText 那种
// 直接把一次 sequential 的工具调用挂死，key 那种更糟 —— 回报「按下 Enter」而它
// 一个字都没发到页面上。所以派发之前必须自己问 `getOSProcessId()`。
//
// mouseWheel 另有一条：**在有渲染进程的活页面上它也永不 ack、一个像素都不滚**
// （五种组合逐一试过：view 隐藏 / view 可见但窗口隐藏 / 窗口也显示 × 禁不禁用硬件加速；
// `Input.synthesizeScrollGesture` 会 ack 约 1030ms 但同样不滚）。所以 scroll 走隔离世界。

/** 从注进去的那段代码里认出这一次的 op —— 源码本身不含 `"op":"` 这个串。 */
const opOf = (code: string): string | null => /"op":"(\w+)"/.exec(code)?.[1] ?? null;

const inputCmds = (wc: ReturnType<typeof wcOf>) =>
  wc.debugger.sent.filter((c) => c.method.startsWith('Input.'));

/** 起一个可派发的标签：有渲染进程、CDP 在。 */
async function dispatchableTab(svc: Svc) {
  const { wc } = await openTab(svc);
  const id = svc.getState().tabs[0].id;
  wc.debugger.sent.length = 0;
  return { id, wc };
}

const okMeasure = (over: Record<string, unknown> = {}) => ({
  ok: true, x: 111, y: 222, isPassword: false, editable: true, disabled: false,
  tag: 'button', label: '搜索', ...over,
});

describe('dispatch：派发之前的两道闸（实测得来）', () => {
  it('标签不在 → no_tab', async () => {
    const { svc } = make();
    await expect(svc.dispatch('nope', { kind: 'click', selector: '#a' }, null))
      .rejects.toMatchObject({ code: 'browser.no_tab' });
  });

  it('没有渲染进程（osPid=0）→ not_dispatchable，且一条 CDP 都不发', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.osPid = 0;                                  // 页面崩了之后它就回到 0
    await expect(svc.dispatch(id, { kind: 'click', selector: '#a' }, null))
      .rejects.toMatchObject({ code: 'browser.not_dispatchable' });
    expect(inputCmds(wc)).toEqual([]);
    expect(wc.isolated).toEqual([]);
  });

  // insertText 在 pid=0 时**永不 settle**：不闸住的话这一次 browser_act 永远不返回。
  it('type 在没有渲染进程时也拦住 —— insertText 那条实测永不 settle', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.osPid = 0;
    await expect(svc.dispatch(id, { kind: 'type', selector: '#q', text: '石墨烯' }, null))
      .rejects.toMatchObject({ code: 'browser.not_dispatchable' });
    expect(inputCmds(wc)).toEqual([]);
  });

  // dispatchKeyEvent 在 pid=0 时 resolve {} —— 不闸住就会回报「按下 Enter」，
  // 而它一个字都没发到页面上。这是「以成功措辞返回一件没发生的事」。
  it('key 也走这道闸：pid=0 时报错，而不是回报「按下 Enter」', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.osPid = 0;
    await expect(svc.dispatch(id, { kind: 'key', key: 'Enter' }, null))
      .rejects.toMatchObject({ code: 'browser.not_dispatchable' });
    expect(inputCmds(wc)).toEqual([]);
  });

  // **断言要落到「是哪一道闸挡的」**：只断言 not_dispatchable 的话，去掉这道闸
  // 也照样绿 —— 后面 `interact` 的形状校验会用**同一个码**兜住（脚本没回结果）。
  // 那是空绿：闸没了，而我们已经往一个 CDP 断掉的标签里注了一次脚本。
  it('CDP 断开（DevTools 顶掉了 attach）→ not_dispatchable，脚本也一次都不注', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.debugger.detach();
    const p = svc.dispatch(id, { kind: 'click', selector: '#a' }, null);
    await expect(p).rejects.toMatchObject({ code: 'browser.not_dispatchable' });
    await expect(p).rejects.toThrow(/调试通道/);
    expect(inputCmds(wc)).toEqual([]);
    expect(wc.isolated).toEqual([]);
  });

  // 世界 id 错了不会报任何错，只会静默失效：`world.ids` 是另一个（空的）对象，
  // 于是每个 nodeId 都反查不到（报「这个编号找不到了」而它就在页面上），
  // 而密码记忆 `world.pw` 也整份看不见 —— 判据 2 当场失效。
  it('定位脚本注进的是 walker 那个隔离世界，主世界一次都不碰', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure());
    await svc.dispatch(id, { kind: 'click', selector: '#a' }, null);
    expect(wc.isolated.map((r) => r.worldId)).toEqual([WALKER_WORLD_ID]);
  });

  // dispatch **不自己 enqueue**：调用方（browser_act 的整批）已经在队列里了，
  // 里面再排一次就是把自己排在自己后面 —— 死锁，而且是「工具永远不返回」那种。
  it('在队列里调 dispatch 不许死锁', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure());
    await expect(svc.enqueue(id, () => svc.dispatch(id, { kind: 'click', selector: '#a' }, null)))
      .resolves.toContain('已点击');
  });

  it('闸都过了才真的发 —— 上面几条不是「整个 dispatch 都在抛」', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure());
    await expect(svc.dispatch(id, { kind: 'click', selector: '#a' }, null)).resolves.toContain('搜索');
    expect(inputCmds(wc).map((c) => c.method)).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
  });
});

describe('dispatch · click：坐标是这一刻量的，命中检查不放水', () => {
  it('坐标用重量到的那份，不是快照里那份', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure({ x: 640, y: 400 }));
    const stale: AxSnapshot = {
      snapshotId: 's1', generation: 'g', url: 'https://a/', title: 'T', iframes: 0,
      collection: { truncated: false, returned: 1, totalKnown: 1 },
      // 快照当时它在 (10,10) 20×20 —— 中心 (20,20)。派发必须用 interact 回的 (640,400)。
      nodes: [{ index: 1, nodeId: 5, role: 'button', name: '搜索', x: 10, y: 10, w: 20, h: 20 }],
    };
    await svc.dispatch(id, { kind: 'click', index: 1, snapshotId: 's1' }, stale);
    const pts = inputCmds(wc).map((c) => `${c.params.x},${c.params.y}`);
    expect(pts).toEqual(['640,400', '640,400']);
  });

  it('先按下再松开，button 与 clickCount 齐全', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure());
    await svc.dispatch(id, { kind: 'click', selector: '#a' }, null);
    expect(inputCmds(wc).map((c) => c.params.type)).toEqual(['mousePressed', 'mouseReleased']);
    for (const c of inputCmds(wc)) {
      expect(c.params.button).toBe('left');
      expect(c.params.clickCount).toBe(1);
    }
  });

  it('被浮层挡住 → click_intercepted，消息里带上是谁挡的，且不发鼠标事件', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({ ok: false, reason: 'intercepted', by: 'div.cookie-banner', x: 1, y: 2 });
    await expect(svc.dispatch(id, { kind: 'click', selector: '#a' }, null))
      .rejects.toMatchObject({ code: 'browser.click_intercepted', message: expect.stringContaining('div.cookie-banner') });
    expect(inputCmds(wc)).toEqual([]);
  });

  // 三种失败的处置完全不同：换选择器 / 重新取快照 / 换目标。报成同一件事就等于没报。
  it('选择器无匹配 → target_unusable，不是 stale_index', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({ ok: false, reason: 'not_found' });
    await expect(svc.dispatch(id, { kind: 'click', selector: '#gone' }, null))
      .rejects.toMatchObject({ code: 'browser.target_unusable', message: expect.stringContaining('#gone') });
  });

  it('编号指向的元素已经不在了 → stale_index，让模型去重新取快照', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({ ok: false, reason: 'stale_node' });
    const snapshot: AxSnapshot = {
      snapshotId: 's1', generation: 'g', url: 'https://a/', title: 'T', iframes: 0,
      collection: { truncated: false, returned: 1, totalKnown: 1 },
      nodes: [{ index: 1, nodeId: 5, role: 'button', name: '搜索', x: 1, y: 1, w: 10, h: 10 }],
    };
    await expect(svc.dispatch(id, { kind: 'click', index: 1, snapshotId: 's1' }, snapshot))
      .rejects.toMatchObject({ code: 'browser.stale_index' });
  });

  it('滚进视野之后仍在视口外 → target_unusable，不是「被 null 挡住」', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({ ok: false, reason: 'offscreen', x: 5, y: 4000, vw: 1280, vh: 800 });
    const p = svc.dispatch(id, { kind: 'click', selector: '#a' }, null);
    await expect(p).rejects.toMatchObject({ code: 'browser.target_unusable' });
    await expect(p).rejects.toThrow(/视口/);
  });

  // Chromium 里 disabled 的控件根本收不到 click。发出去就是「什么都没发生但回报成功」——
  // 最后一页的「下一页」按钮正是这个形状（repeat×3 把第一页抽三遍）。
  it('目标是 disabled 的控件 → 拒，且一条鼠标事件都不发', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure({ disabled: true, label: '下一页' }));
    await expect(svc.dispatch(id, { kind: 'click', selector: '.next' }, null))
      .rejects.toMatchObject({ code: 'browser.target_unusable', message: expect.stringContaining('disabled') });
    expect(inputCmds(wc)).toEqual([]);
  });

  // 处置完全不同：这一条是「等一下重试 / 重新取快照」，而 not_dispatchable 是
  // 「先把页面打开」。共用一个码的话，模型收到它只能去重开页面 —— 白白丢掉当前
  // 页面状态，而真实原因只是页面正在导航。
  it('页面在派发中途导航走了（脚本没回结果）→ page_no_result，不是 not_dispatchable', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(undefined);
    const p = svc.dispatch(id, { kind: 'click', selector: '#a' }, null);
    await expect(p).rejects.toMatchObject({ code: 'browser.page_no_result' });
    await expect(p).rejects.toThrow(/重新取|再试|导航/);
  });

  it('脚本求值直接 reject（页面换文档了）→ 同样是 page_no_result', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.reject(new Error('Script failed to execute'));
    await expect(svc.dispatch(id, { kind: 'click', selector: '#a' }, null))
      .rejects.toMatchObject({ code: 'browser.page_no_result' });
  });

  // 两个码的**消息**也不许长得一样：这一期渲染层还没有 browser.* 的错误码路由，
  // 模型分流靠的就是这两段文本。
  it('两条错误的下一步说的不是同一件事', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.osPid = 0;
    const gate = await svc.dispatch(id, { kind: 'click', selector: '#a' }, null).catch((e: Error) => e.message);
    wc.osPid = 4321;
    wc.isolatedImpl = () => Promise.resolve(undefined);
    const nav = await svc.dispatch(id, { kind: 'click', selector: '#a' }, null).catch((e: Error) => e.message);
    expect(gate).toMatch(/browser_open/);          // 先把页面打开
    expect(nav).not.toMatch(/browser_open/);       // 重开页面正是这里**不该**做的事
  });
});

// ── §G2 隔离世界求值的两道保护（C1）────────────────────────────────────────
//
// **实测（Electron 41.2.1，2026-09-09，独立进程 + 独立 userData）：**
//
// | 情形 | `executeJavaScriptInIsolatedWorld(31337, '1+1')` |
// | --- | --- |
// | 全新的、从没 load 过页面的 view（pid=0） | **3000ms 内永不 settle** |
// | `forcefullyCrashRenderer()` 之后 | **永不 settle** |
// | 页面主线程被同步忙循环占住 K 毫秒 | 推迟 K 毫秒后照常 resolve（200/1000/3000 → 192/988/2988ms） |
// | 空载 200 次往返 | 中位 0.086ms，最大 0.38ms |
//
// 崩溃之后：`getOSProcessId()` 回 0，而 **`debugger.isAttached()` 仍是 true**、
// `isDestroyed()` 是 false，`render-process-gone` 只记日志不回收 view —— 所以
// `webContentsOf()` 照常回一个非 null 的 wc，取快照那条路会一头撞进永不 settle。
// **`isAttached()` 挡不住这一种**，只有 pid 挡得住。
describe('取快照与页内求值：没有渲染进程时一个字都不注', () => {
  it('pid=0 时 snapshot 不注入脚本，退一份显式标注未采全的空快照', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.osPid = 0;                                   // 页面崩过一次之后就是这样
    wc.isolated.length = 0;
    const snap = await svc.snapshot(id);
    // **载荷断言是这一条**：注进去就等于一次永不 settle。
    expect(wc.isolated).toEqual([]);
    expect(snap.nodes).toEqual([]);
    expect(snap.collection).toMatchObject({ truncated: true, returned: 0 });
    expect(snap.collection.totalKnown).toBeUndefined();   // 数不出来的数不要编一个
  });

  it('pid 回来了就照常采集 —— 上一条不是把 snapshot 整个关掉了', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(walkerOut());
    const snap = await svc.snapshot(id);
    expect(wc.isolated.length).toBeGreaterThan(0);
    expect(snap.collection.truncated).toBe(false);
  });

  // 已知的两种 pid=0 由上面那道谓词挡掉；这一条兜的是**没量到的第三种**。
  // 时限的下界来自量过的成本：我们注进去最重的东西是 walker，20 万节点的页面上
  // 实测封顶 101ms（它自己按「阻塞渲染进程 0.1 秒」定了 MAX_WALKED=8 万）。
  it('求值永不 settle 时，snapshot 在时限到点后退空快照，而不是挂死', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => new Promise(() => {});
    const p = svc.snapshot(id);
    await vi.advanceTimersByTimeAsync(PAGE_EVAL_TIMEOUT_MS + 100);
    const snap = await p;
    expect(snap.nodes).toEqual([]);
    expect(snap.collection.truncated).toBe(true);
  });

  // 这正是 C1 的失败序列：闸把 CDP 那一侧堵死之后，剩下的唯一出口就是这里。
  // browser_act 是 sequential 工具，挂在这里等于整轮 run 永远不返回。
  it('求值永不 settle 时，dispatch 在时限到点后报错，而不是挂死', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => new Promise(() => {});
    const p = svc.dispatch(id, { kind: 'click', selector: '#a' }, null);
    const settled = p.then(() => 'resolved', (e: Error & { code?: string }) => e.code);
    await vi.advanceTimersByTimeAsync(PAGE_EVAL_TIMEOUT_MS - 10);
    expect(await Promise.race([settled, Promise.resolve('still-pending')])).toBe('still-pending');
    await vi.advanceTimersByTimeAsync(200);
    expect(await settled).toBe('browser.page_no_result');
  });

  // ── 时限到点说的是「还没有发生」，不是「没有发生」（评审 F2）──────────────
  //
  // 时限到点**取消不了**那次求值（Electron 没有这个入口，见 evalOn 的实测表），
  // 被丢掉的那一次稍后照常执行 —— 实测忙循环 8 秒的页面上，主进程 3.0 秒报「时限」、
  // 页面 7.8 秒真的滚了 800 像素（3/3 复现）。所以这条消息**不许说「这一步没有
  // 发生」**：模型据此重试，两次都会落地，`select` 那条还会把 change 派发两遍
  // （学术站点上 change 就是「立刻重新检索」）。
  // 复审 N2：上一版只用三个字面量守这句消息（不含「没有发生」/ 含「不知道」/
  // 含「快照」），变异 M8 把结尾改写成「…不过实际上它并未生效，直接重试即可，
  // 不必先取一份快照」——三个字面量全部满足，语义却被改回了 F2 抓的那句谎话。
  // 所以判据挪到结构上：`outcome` 是撞时限这条路径**唯一**的赋值来源（'unknown'，
  // 见 errors.ts 的字段注释），散文再怎么改写都动不了它；散文本身则钉住这句消息
  // 里真正带着「下一步该做什么」的那半句原话，不是可以被同义词绕开的散碎关键词。
  it('时限那条错不说「没有发生」，如实说结果未知、重试前先看页面（outcome 字段是判据）', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => new Promise(() => {});
    const p = svc.dispatch(id, { kind: 'scroll', direction: 'down' }, null);
    const settled = p.then(() => null, (e: Error & { code?: string; outcome?: string }) => e);
    await vi.advanceTimersByTimeAsync(PAGE_EVAL_TIMEOUT_MS + 100);
    const err = await settled;
    expect(err?.code).toBe('browser.page_no_result');
    // 结构判据：这条路径必须、且只能是 'unknown'。散文改写不了这个值。
    expect(err?.outcome).toBe('unknown');
    expect(err?.message).not.toContain('没有发生');
    // 带走的那半句指令必须原样在——这才是 M8 想绕开的那句话。
    expect(err?.message).toContain('别按「它没做」去重试');
  });

  // 页面那一侧的自检要认**同一个到点时刻**：主进程的定时器与注进去的 notAfter
  // 各算各的话，守卫要么提前把好的求值废掉、要么晚到根本不挡。
  it('注进去的动作请求带 notAfter，且与主进程那道时限是同一个到点时刻', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure());
    wc.isolated.length = 0;
    const want = Date.now() + PAGE_EVAL_TIMEOUT_MS;
    await svc.dispatch(id, { kind: 'click', selector: '#a' }, null);
    expect(wc.isolated.length).toBeGreaterThan(0);
    for (const s of wc.isolated) {
      const m = /"notAfter":(\d+)/.exec(s.code);
      expect(m).not.toBeNull();
      expect(Number(m?.[1])).toBe(want);
    }
  });

  // 守卫真的挡下来的时候（页面赶在主进程定时器之前把 expired 送回来），
  // 那才是唯一一种说得出「什么都没做」的情形 —— 它与撞时限那条不是一回事。
  // `scroll` 不派发任何 CDP 输入事件（见 dispatch 里的注释），所以这一条路径上
  // 「什么都没做」是真的；`type` 上不是，见下一条。
  it('页面回 expired → page_no_result，outcome=none，且这一条才说得出「什么都没做」', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({ ok: false, reason: 'expired' });
    const err = await svc.dispatch(id, { kind: 'scroll', direction: 'down' }, null)
      .then(() => null, (e: Error & { code?: string; outcome?: string }) => e);
    expect(err?.code).toBe('browser.page_no_result');
    expect(err?.outcome).toBe('none');
    expect(err?.message).toContain('什么都没做');
  });

  // 复审 N1：`type` 的 focusSelect 排在两条 `Input.dispatchMouseEvent` 之后
  // （点击已经真的发出去了——探针实证，见 interactError 的 `priorInputDispatched`
  // 注释）。这时如果 focusSelect 撞上 expired，「它按约定什么都没做」对**这一步**
  // 成立，但对**这个动作**是假话：点击已经落地，页面可能已经因此变了样。
  it('type 在点击之后、focusSelect 才撞 expired —— 不许说「它按约定什么都没做」', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = (code) => Promise.resolve(
      opOf(code) === 'measure' ? okMeasure({ tag: 'input', label: '检索词' })
        : { ok: false, reason: 'expired' },
    );
    const err = await svc.dispatch(id, { kind: 'type', selector: '#q', text: '石墨烯' }, null)
      .then(() => null, (e: Error & { code?: string; outcome?: string }) => e);
    // 先坐实前提：点击真的已经发出去了，这正是措辞必须不同的依据。
    expect(inputCmds(wc).map((c) => c.method))
      .toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
    expect(inputCmds(wc).map((c) => c.method)).not.toContain('Input.insertText');
    expect(err?.code).toBe('browser.page_no_result');
    expect(err?.outcome).toBe('none');
    expect(err?.message).not.toContain('它按约定什么都没做');
    expect(err?.message).toContain('点击已经发出去了');
  });

  it('evalInPage 对没有渲染进程的标签当场报错，不注入', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.osPid = 0;
    wc.isolated.length = 0;
    await expect(svc.evalInPage(id, '1+1')).rejects.toMatchObject({ code: 'browser.not_dispatchable' });
    expect(wc.isolated).toEqual([]);
  });

  it('evalInPage 对不存在的标签报 no_tab', async () => {
    const { svc } = make();
    await expect(svc.evalInPage('nope', '1+1')).rejects.toMatchObject({ code: 'browser.no_tab' });
  });

  it('evalInPage 正常时原样把页面的返回值给回来', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve('正文');
    await expect(svc.evalInPage(id, 'x')).resolves.toBe('正文');
    expect(wc.isolated.map((r) => r.worldId)).toEqual([WALKER_WORLD_ID]);
  });
});

describe('dispatch · type：两道密码闸 + 打完读回来', () => {
  const pwSnapshot: AxSnapshot = {
    snapshotId: 's1', generation: 'g', url: 'https://idp/', title: '登录', iframes: 0,
    collection: { truncated: false, returned: 1, totalKnown: 1 },
    nodes: [{ index: 1, nodeId: 9, role: 'textbox', name: '密码', x: 1, y: 1, w: 100, h: 20, isPassword: true }],
  };

  // 第一道：快照里 walker 已经判过它是密码框。这一道拦在**碰页面之前**。
  it('快照说它是密码框 → password_field，一条 CDP 都不发，文本一个字不回显', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    const p = svc.dispatch(id, { kind: 'type', index: 1, snapshotId: 's1', text: 'hunter2' }, pwSnapshot);
    await expect(p).rejects.toMatchObject({ code: 'browser.password_field' });
    await expect(p).rejects.toThrow(/browser_login/);
    expect(inputCmds(wc)).toEqual([]);
    expect(wc.isolated).toEqual([]);
    expect(JSON.stringify(H.logs)).not.toContain('hunter2');
  });

  // 第二道：selector 定位时快照那层压根看不出来。interact 在活元素上按 walker 的
  // 四条判据再判一次 —— 而且是在 focus 之前。
  it('selector 定位的密码框 → 第二道闸在页面里拦住，insertText 一次都不发', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = (code) => Promise.resolve(
      opOf(code) === 'measure' ? okMeasure({ isPassword: true, tag: 'input', label: '密码' })
        : { ok: false, reason: 'password' },
    );
    const p = svc.dispatch(id, { kind: 'type', selector: '#pwd', text: 'hunter2' }, null);
    await expect(p).rejects.toMatchObject({ code: 'browser.password_field' });
    // **一条输入事件都不许发**，不只是 insertText：这道闸排在「点一下聚焦」**之前**，
    // 所以连点都不许点。只断言 insertText 没发的话，把这道闸删掉照样绿 ——
    // interact.js 里 focusSelect 那一道会兜住，而那时密码框已经被点过一次了
    // （站点在 focus 上挂的脚本已经跑了）。
    expect(inputCmds(wc)).toEqual([]);
    expect(JSON.stringify(H.logs)).not.toContain('hunter2');
  });

  it('正常输入：click 聚焦 → 全选 → insertText → 把框里现在是什么读回来', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    const seen: string[] = [];
    wc.isolatedImpl = (code) => {
      const op = opOf(code)!;
      seen.push(op);
      if (op === 'measure') return Promise.resolve(okMeasure({ tag: 'input', label: '检索词' }));
      if (op === 'focusSelect') return Promise.resolve({ ok: true, focused: true, selected: true });
      return Promise.resolve({ ok: true, value: '石墨烯' });
    };
    const line = await svc.dispatch(id, { kind: 'type', selector: '#q', text: '石墨烯' }, null);
    expect(seen).toEqual(['measure', 'focusSelect', 'readValue']);
    expect(inputCmds(wc).map((c) => c.method)).toEqual([
      'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.insertText',
    ]);
    expect(inputCmds(wc)[2].params.text).toBe('石墨烯');
    expect(line).toContain('石墨烯');
    expect(line).toContain('检索词');
  });

  // insertText 打到非可编辑元素上实测是 **ack 0ms 而什么都不做**（body / button /
  // readonly / disabled 四种都是）。不拦的话回报的是一次没发生的输入。
  // 「能不能打字」必须在**点下去之前**问：`type {selector:'#submit'}` 的那一下
  // 点的是提交按钮 —— 先点再报「不能打字」，等于替模型做了一次它没要求过的提交。
  it('目标不是能打字的控件 → 拒，而且一条输入事件都不发（连点都不点）', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = (code) => Promise.resolve(
      opOf(code) === 'measure' ? okMeasure({ tag: 'button', editable: false })
        : { ok: false, reason: 'not_editable', tag: 'button', type: '' },
    );
    await expect(svc.dispatch(id, { kind: 'type', selector: '#btn', text: 'x' }, null))
      .rejects.toMatchObject({ code: 'browser.target_unusable' });
    expect(inputCmds(wc)).toEqual([]);
  });

  // ── `focusSelect` 回的两个事实必须被读（评审 R01：两个字段一个都没人看）──
  //
  // 它们各自对应一种「以成功措辞返回一件没发生的事」：
  //  · focused 为假 → insertText 打进的是**当时真正持有焦点的那个元素**
  //    （上一个动作留下的框），返回值仍然说「已在「X」里输入」。
  //  · 既没选中也不是空框 → 「先清空」没有发生，insertText 是**追加**
  //    （实测：type=number 的框原有 2020、不全选就打 2024 → "20202024"）。
  it('focusSelect 说焦点没落在目标上 → 停手，insertText 一次都不发', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = (code) => Promise.resolve(
      opOf(code) === 'measure' ? okMeasure({ tag: 'input', label: '检索词' })
        : { ok: true, focused: false, selected: true, emptyBefore: false },
    );
    await expect(svc.dispatch(id, { kind: 'type', selector: '#q', text: '石墨烯' }, null))
      .rejects.toMatchObject({ code: 'browser.target_unusable' });
    expect(inputCmds(wc).map((c) => c.method)).not.toContain('Input.insertText');
  });

  it('focusSelect 说没选中、框也不是空的 → 停手（不许变成追加）', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = (code) => Promise.resolve(
      opOf(code) === 'measure' ? okMeasure({ tag: 'input', label: '年份' })
        : { ok: true, focused: true, selected: false, emptyBefore: false },
    );
    const p = svc.dispatch(id, { kind: 'type', selector: '#year', text: '2024' }, null);
    await expect(p).rejects.toMatchObject({ code: 'browser.target_unusable' });
    await expect(p).rejects.toThrow(/清空|追加/);
    expect(inputCmds(wc).map((c) => c.method)).not.toContain('Input.insertText');
  });

  // 空框本来就不需要清 —— 上一条拦的是「该清没清」，不是「所有 selected=false」。
  it('本来就是空框（selected 假、emptyBefore 真）→ 照常打', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = (code) => {
      const op = opOf(code);
      if (op === 'measure') return Promise.resolve(okMeasure({ tag: 'input', label: '检索词' }));
      if (op === 'focusSelect') return Promise.resolve({ ok: true, focused: true, selected: false, emptyBefore: true });
      return Promise.resolve({ ok: true, value: '石墨烯' });
    };
    await expect(svc.dispatch(id, { kind: 'type', selector: '#q', text: '石墨烯' }, null))
      .resolves.toContain('石墨烯');
    expect(inputCmds(wc).map((c) => c.method)).toContain('Input.insertText');
  });

  // 分段选择器（date/time/month/week/datetime-local）：实测 insertText 对它们
  // **完全无效**，而「先清空再打」会把用户原本填好的年份抹掉。所以在点下去之前就拒。
  it('目标是 date 一类的分段选择器 → 拒，且连点都不点', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure({ tag: 'input', segmented: true, label: '起始年' }));
    const p = svc.dispatch(id, { kind: 'type', selector: '#from', text: '2024' }, null);
    await expect(p).rejects.toMatchObject({ code: 'browser.target_unusable' });
    await expect(p).rejects.toThrow(/分段|insertText/);
    expect(inputCmds(wc)).toEqual([]);
  });

  // 打完读回来是空的，而我们打的是非空文本 —— 那这一次 insertText 什么都没做。
  // （`text: ''` 在 validateBatch 就被拒了，所以「空」只可能是没打进去。）
  it('打完之后框里是空的 → 报失败，不许回报「已经输入」', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = (code) => {
      const op = opOf(code);
      if (op === 'measure') return Promise.resolve(okMeasure({ tag: 'input', label: '检索词' }));
      if (op === 'focusSelect') return Promise.resolve({ ok: true, focused: true, selected: true, emptyBefore: false });
      return Promise.resolve({ ok: true, value: '' });
    };
    await expect(svc.dispatch(id, { kind: 'type', selector: '#q', text: '石墨烯' }, null))
      .rejects.toMatchObject({ code: 'browser.target_unusable' });
  });

  // 反过来钉住上一条不是空绿：同一个目标换成 click 就该照常点。
  it('同一个按钮用 click 照常点 —— 上一条拦的是 type 不是所有动作', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure({ tag: 'button', editable: false }));
    await expect(svc.dispatch(id, { kind: 'click', selector: '#btn' }, null)).resolves.toContain('已点击');
    expect(inputCmds(wc).length).toBe(2);
  });
});

describe('dispatch · hover / select / scroll', () => {
  it('hover 发的是 mouseMoved，就一条', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(okMeasure({ x: 30, y: 40 }));
    await svc.dispatch(id, { kind: 'hover', selector: '#a' }, null);
    expect(inputCmds(wc).map((c) => `${c.method}:${String(c.params.type)}`)).toEqual(['Input.dispatchMouseEvent:mouseMoved']);
    expect(inputCmds(wc)[0].params.x).toBe(30);
  });

  it('select 走隔离世界赋值，不发任何输入事件', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({ ok: true, value: '2024', label: '2024 年', changed: true });
    const line = await svc.dispatch(id, { kind: 'select', selector: '#year', value: '2024' }, null);
    expect(inputCmds(wc)).toEqual([]);
    expect(line).toContain('2024 年');
  });

  // `el.value = '不存在'` 会把 select 变成「什么都没选」，下一步提交出去就是一次空筛选。
  it('select 的值不在选项里 → 拒，并把可选值列给模型', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({
      ok: false, reason: 'no_option', options: ['2024', '2023'],
      truncated: false, returned: 2, totalKnown: 2,
    });
    const p = svc.dispatch(id, { kind: 'select', selector: '#year', value: '1999' }, null);
    await expect(p).rejects.toMatchObject({ code: 'browser.target_unusable' });
    await expect(p).rejects.toThrow(/2024/);
    // 没截断的时候不许平白说「还有没列出来的」—— 那会让模型去猜一个不存在的余量。
    await expect(p).rejects.not.toThrow(/没有列出来/);
  });

  // spec §5.5：截断**必须显式说出口**。只把切过的数组丢给模型，它看完这几项都不
  // 匹配就会以为自己要的那个值不存在 —— 而它可能正在没列出来的那 380 项里。
  it('可选值被截断时，消息里明说「其余的没有列出来」并给出总数', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({
      ok: false, reason: 'no_option', options: ['2024', '2023'],
      truncated: true, returned: 2, totalKnown: 400,
    });
    const p = svc.dispatch(id, { kind: 'select', selector: '#j', value: 'x' }, null);
    await expect(p).rejects.toThrow(/没有列出来/);
    await expect(p).rejects.toThrow(/400/);
    await expect(p).rejects.toThrow(/前 2 项/);
  });

  // mouseWheel 实测永不 ack、一个像素都不滚（五种组合）。所以这条路必须走隔离世界。
  it('scroll 不发 mouseWheel —— 那条实测既不 ack 也不滚', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({
      ok: true, container: 'document', before: 0, after: 800, delta: 800, atStart: false, atEnd: false, step: 800,
    });
    const line = await svc.dispatch(id, { kind: 'scroll', direction: 'down' }, null);
    expect(inputCmds(wc)).toEqual([]);
    expect(wc.isolated.length).toBe(1);
    expect(line).toContain('800');
  });

  it('滚到底了要说出口 —— 与「滚了但页面没动」分得开', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve({
      ok: true, container: 'document', before: 4200, after: 4200, delta: 0, atStart: false, atEnd: true, step: 800,
    });
    expect(await svc.dispatch(id, { kind: 'scroll', direction: 'down' }, null)).toMatch(/到底/);
  });
});

// ── §H waitFor ─────────────────────────────────────────────────────────────
//
// spec §4.2：轮询在这里是**等待手段**不是判定依据 —— 判定的是「条件成立了没有」
// 这个页面事实。超时只表示条件未达成，不表示别的。

describe('waitFor：等的是显式条件，超时只表示条件未达成', () => {
  it('条件一开始就成立 → 立刻回 true，不空等一个轮询周期', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(true);
    const p = svc.waitFor(id, { selector: '.result', state: 'present' }, 8000);
    await flush();
    await expect(p).resolves.toBe(true);
    expect(wc.isolated.length).toBe(1);
  });

  it('第三次轮询才成立 → true', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    let n = 0;
    wc.isolatedImpl = () => Promise.resolve(++n >= 3);
    const p = svc.waitFor(id, { selector: '.result', state: 'present' }, 8000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(true);
    expect(n).toBe(3);
  });

  it('到时限仍未成立 → false', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve(false);
    const p = svc.waitFor(id, { selector: '.result', state: 'present' }, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    await expect(p).resolves.toBe(false);
  });

  it('state=absent 等的是「不见了」', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    let n = 0;
    wc.isolatedImpl = () => Promise.resolve(++n < 2);   // 头一次还在，之后不见了
    const p = svc.waitFor(id, { selector: '.loading', state: 'absent' }, 8000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(true);
  });

  // urlMatches 判的是主进程手里的那个 URL：`wait {urlMatches}` 的典型用法正是
  // 「等它跳到结果页」—— 那一刻页面正在换文档，隔离世界里的脚本要么跑在旧文档上、
  // 要么直接 reject。主进程的 getURL() 是同一个协议层事实，而且不挑时机。
  it('urlMatches 用主进程的 getURL，不往正在导航的页面里注脚本', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.url = 'https://a.example/home';
    const p = svc.waitFor(id, { urlMatches: '/search' }, 8000);
    await vi.advanceTimersByTimeAsync(300);
    wc.url = 'https://a.example/search?q=x';
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBe(true);
    expect(wc.isolated).toEqual([]);
  });

  // 页面在轮询中途导航走了，脚本就 reject。那不是「条件不成立」的反面，
  // 更不是一次失败 —— 接着等就是了。
  it('隔离世界求值失败当成「还没成立」，继续等，不当成失败', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    let n = 0;
    wc.isolatedImpl = () => (++n < 3 ? Promise.reject(new Error('页面导航中')) : Promise.resolve(true));
    const p = svc.waitFor(id, { selector: '.r', state: 'present' }, 8000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(true);
  });

  // 一次挂住的求值不许把时限拖死：wait 是 sequential 工具里的一步，挂住就是整轮 run 挂住。
  it('求值永不返回时，时限照样到点', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => new Promise(() => {});
    const p = svc.waitFor(id, { selector: '.r', state: 'present' }, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    await expect(p).resolves.toBe(false);
  });

  it('标签没了 → no_tab', async () => {
    const { svc } = make();
    await expect(svc.waitFor('nope', { selector: '.r', state: 'present' }, 100))
      .rejects.toMatchObject({ code: 'browser.no_tab' });
  });

  // ── 求值失败是「问不出来」，不是任何一个方向的答案（评审 R14 存活）────────
  //
  // 三态（yes / no / unknown）的**两个方向各有一条能红的用例**，缺一条就等于那一半
  // 零覆盖：
  //
  // · reject → 「条件不成立」：`state: 'absent'` 立刻取反成 true（「等到了：
  //   .loading 消失了」），而我们一次都没问出结果 —— 下面第一条守它。
  // · reject → 「条件成立」：`state: 'present'` 立刻回报 true（「等到了：.result
  //   出现了」），模型接着在一个从没验证过的页面上 extract —— 下面第二条守它。
  //   20 秒那道单次求值时限 reject 走的也是同一支。
  //
  // 两条都是「以成功措辞返回一件没发生的事」，只是方向相反。**只补一侧的话，
  // 另一侧的变异照样全绿**（这正是上一轮评审点名 R14 存活的原因）。
  it('等「消失」时求值一直失败 → 到时限报 false，绝不回报「等到了」', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.reject(new Error('页面正在导航'));
    const p = svc.waitFor(id, { selector: '.loading', state: 'absent' }, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    await expect(p).resolves.toBe(false);
  });

  it('等「出现」时求值一直失败 → 到时限报 false，绝不回报「等到了」', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.reject(new Error('页面正在换文档'));
    const p = svc.waitFor(id, { selector: '.result', state: 'present' }, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    await expect(p).resolves.toBe(false);
  });

  it('等「消失」时求值失败几次之后页面回话了 → 按页面说的算', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    let n = 0;
    wc.isolatedImpl = () => (++n < 3 ? Promise.reject(new Error('导航中')) : Promise.resolve(false));
    const p = svc.waitFor(id, { selector: '.loading', state: 'absent' }, 8000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(true);
    expect(n).toBe(3);
  });

  // 选择器语法错是**当场就判得出来**的事（querySelector 在页面里抛 DOMException），
  // 而现在它被当成「条件还没成立」，烧满 8–30 秒之后报 wait_timeout，
  // 附赠一句「要么条件写得不对，要么这一步没触发页面变化」—— 把一个确定的语法错
  // 说成了一件要猜的事。动作那一侧早就分开报了（bad_selector），wait 这侧也要。
  it('选择器语法错 → 立刻报 bad_action，不烧满时限', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.isolatedImpl = () => Promise.resolve('bad_selector');
    const p = svc.waitFor(id, { selector: 'a[[', state: 'present' }, 30_000);
    const settled = p.then(() => 'resolved', (e: Error & { code?: string }) => e.code);
    await vi.advanceTimersByTimeAsync(50);
    expect(await settled).toBe('browser.bad_action');
    expect(wc.isolated.length).toBe(1);
  });

  // 没有渲染进程时页内求值**永不 settle**（实测）。轮询会一次次注进去、
  // 一个都不回来，然后烧满时限报「条件未达成」—— 而真相是「这个标签压根问不了」。
  it('没有渲染进程 → 当场报 not_dispatchable，不注入也不空等', async () => {
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.osPid = 0;
    wc.isolated.length = 0;
    await expect(svc.waitFor(id, { selector: '.r', state: 'present' }, 8000))
      .rejects.toMatchObject({ code: 'browser.not_dispatchable' });
    expect(wc.isolated).toEqual([]);
  });

  // urlMatches 判的是主进程手里的 getURL()，不进页面 —— 那道闸不该拦它。
  it('urlMatches 不受渲染进程那道闸影响（它压根不进页面）', async () => {
    vi.useFakeTimers();
    const { svc } = make();
    const { id, wc } = await dispatchableTab(svc);
    wc.osPid = 0;
    wc.url = 'https://a.example/search?q=x';
    const p = svc.waitFor(id, { urlMatches: '/search' }, 8000);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBe(true);
  });
});
