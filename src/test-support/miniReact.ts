/**
 * **一个只跑「组件自己那一层」的 React 替身。**
 *
 * ## 它存在的理由
 *
 * 这个仓库的 vitest 跑 node 环境，没有 jsdom、没有 React 测试库，而且**不许加新依赖**。
 * 代价是一整类缺陷今天没人守：把判据抠成纯函数（`rightPane.ts` / `institutionForm.ts` /
 * `browserBridge.ts`）之后，模块自己有用例了，但**「组件到底调不调它」变成了一条新的缝** ——
 * 评审在这条缝上做了 6 条变异，三条 gate **6/6 全绿**，其中一条（`InstitutionBlock`
 * 不调 `buildSaveArgs`）的后果是**每次保存都把用户存好的校园密码删掉**。
 *
 * 主进程那边同型的问题（`main.ts` 删掉接线全绿）是靠 `main.test.ts` **真装配一遍**
 * 堵上的。这个模块是渲染层这一侧的同一件事。
 *
 * ## 它是什么、不是什么
 *
 * **是**：一套 hook 实现 + 一个渲染循环。用 `vi.mock('react')` 把 `useState` /
 * `useRef` / `useEffect` / `useMemo` 换成下面这几个，然后**真的调用组件函数**，
 * 拿到它返回的那棵元素树，按 React 的次序**先挂 ref、再跑 effect**，
 * 事件回调就在树上的 props 里，可以真的触发。断言的是**装配之后可观测的副作用**
 * （发出去的 RPC、挂到哪个节点上、排版用了哪个宽度），不是「某个替身被调用过」。
 *
 * **不是**：一个 React。**子组件不会被调用** —— `<TabStrip …/>` 在树上只是一个
 * `{ type: TabStrip, props }`，它的内部一个字都没跑。这是刻意的（隔离被测组件，
 * 也免掉整棵子树的 hook 依赖），但也划定了守卫的边界：
 *
 * - **守得住**：这个组件调不调那个模块、把结果接到哪个节点／哪个 prop 上、
 *   effect 与它的清理函数发不发得出去、事件回调组装出什么参数。
 * - **守不住**：真实 DOM 的任何东西 —— 布局、像素、CSS、事件冒泡、
 *   子组件内部的行为、React 真正的调度（批处理、并发、StrictMode 双调用）。
 *   那些仍然只能靠 e2e。
 *
 * 所以：**别拿它当「这块 UI 没问题」的证据**，它证明的只有「接线还在」。
 */

/** `getBoundingClientRect()` 的返回值，字段与浏览器一致。 */
export type FakeRect = {
  x: number; y: number; left: number; top: number;
  width: number; height: number; right: number; bottom: number;
};

/** 挂到 `ref.current` 上的假元素。只实现被测代码真正用得到的那几样。 */
export type FakeElement = {
  tagName: string;
  testId: string | undefined;
  getBoundingClientRect: () => FakeRect;
};

/** 元素树上的一个节点。React 的元素对象，只列这里用得到的字段。 */
export type MiniElement = { type: unknown; key: unknown; props: Record<string, any> };

export function rect(r: { left: number; top: number; width: number; height: number }): FakeRect {
  return {
    x: r.left, y: r.top, left: r.left, top: r.top,
    width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height,
  };
}

const ZERO = rect({ left: 0, top: 0, width: 0, height: 0 });

type Inst = {
  fn: (props: any) => unknown;
  props: any;
  slots: any[];
  cursor: number;
  /** 本轮还没跑的 effect 槽号，按声明次序。 */
  pending: number[];
  runners: Map<number, () => (() => void) | void>;
  tree: unknown;
  alive: boolean;
  renders: number;
  /** ref 对象 → 挂上去的假元素。按 ref 记，重渲染时身份不变（真 React 也不换 DOM 节点）。 */
  refEls: Map<object, FakeElement>;
  rectOf: (testId: string | undefined, tagName: string) => FakeRect;
};

let cur: Inst | null = null;

function need(): Inst {
  if (cur === null) throw new Error('miniReact: 在组件函数之外调用了 hook');
  return cur;
}

function sameDeps(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

// ── hooks ───────────────────────────────────────────────────────────────────

export function miniUseState<S>(init?: S | (() => S)): [S, (v: S | ((p: S) => S)) => void] {
  const inst = need();
  const i = inst.cursor++;
  if (inst.slots[i] === undefined) {
    inst.slots[i] = { v: typeof init === 'function' ? (init as () => S)() : init };
  }
  const slot = inst.slots[i] as { v: S };
  const set = (v: S | ((p: S) => S)) => {
    const next = typeof v === 'function' ? (v as (p: S) => S)(slot.v) : v;
    if (Object.is(next, slot.v)) return;
    slot.v = next;
    // **同步重渲染**，不做批处理。真 React 会把一次事件里的多次 setState 合成一帧，
    // 这里每次都重跑一遍组件函数 —— 对「接线还在不在」这类断言没有区别，
    // 而任何依赖批处理次数的断言本来就不该写在这一层。
    if (inst.alive) renderInst(inst);
  };
  return [slot.v, set];
}

export function miniUseRef<T>(init: T): { current: T } {
  const inst = need();
  const i = inst.cursor++;
  if (inst.slots[i] === undefined) inst.slots[i] = { current: init };
  return inst.slots[i] as { current: T };
}

export function miniUseEffect(run: () => (() => void) | void, deps?: unknown[]): void {
  const inst = need();
  const i = inst.cursor++;
  const slot = (inst.slots[i] ??= { first: true, deps: undefined, cleanup: undefined });
  const changed = slot.first || deps === undefined || !sameDeps(slot.deps, deps);
  slot.first = false;
  slot.deps = deps;
  if (!changed) return;
  inst.runners.set(i, run);
  inst.pending.push(i);
}

export function miniUseMemo<T>(factory: () => T, deps?: unknown[]): T {
  const inst = need();
  const i = inst.cursor++;
  const slot = (inst.slots[i] ??= { first: true, deps: undefined, v: undefined });
  if (slot.first || deps === undefined || !sameDeps(slot.deps, deps)) {
    slot.v = factory();
    slot.deps = deps;
    slot.first = false;
  }
  return slot.v as T;
}

export function miniUseCallback<T>(fn: T, deps?: unknown[]): T {
  return miniUseMemo(() => fn, deps);
}

/** 订阅那一层在这里没有意义（没有调度器），直接读当前快照。 */
export function miniUseSyncExternalStore<T>(_sub: unknown, get: () => T): T {
  return get();
}

export function miniUseId(): string {
  const inst = need();
  const i = inst.cursor++;
  if (inst.slots[i] === undefined) inst.slots[i] = { id: `mini-${String(i)}` };
  return (inst.slots[i] as { id: string }).id;
}

/**
 * 丢给 `vi.mock('react')` 的那一份覆盖。**只覆盖 hook**，
 * `createElement` / `Fragment` / `forwardRef` / `memo` 一律用真的
 * （元素还是真元素，`react/jsx-runtime` 那条路没被动过）。
 */
export const reactHooks = {
  useState: miniUseState,
  useRef: miniUseRef,
  useEffect: miniUseEffect,
  useLayoutEffect: miniUseEffect,
  useInsertionEffect: miniUseEffect,
  useMemo: miniUseMemo,
  useCallback: miniUseCallback,
  useSyncExternalStore: miniUseSyncExternalStore,
  useId: miniUseId,
};

// ── 树 ──────────────────────────────────────────────────────────────────────

export function isElement(n: unknown): n is MiniElement {
  return typeof n === 'object' && n !== null && '$$typeof' in n && 'type' in n && 'props' in n;
}

/** 深度优先走一遍元素树。**子组件不展开** —— 它们只是树上的一个节点。 */
export function walk(node: unknown, visit: (el: MiniElement) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (!isElement(node)) return;
  visit(node);
  walk(node.props?.children, visit);
}

/**
 * 按 testId 找一个节点。
 *
 * 宿主元素用 `data-testid`，而这个仓库自己的 `IconButton` / `Btn` 收的是 `testId`
 * prop —— 两种都认，否则一半的按钮在这棵树上是找不到的。
 */
export function queryByTestId(node: unknown, id: string): MiniElement | null {
  let hit: MiniElement | null = null;
  walk(node, (el) => {
    if (hit !== null) return;
    if (el.props['data-testid'] === id || el.props.testId === id) hit = el;
  });
  return hit;
}

export function findByTestId(node: unknown, id: string): MiniElement {
  const hit = queryByTestId(node, id);
  if (hit === null) throw new Error(`miniReact: 这棵树上没有 testId="${id}"`);
  return hit;
}

/** 按任意 prop 找全部命中的节点（`data-pane` 这类）。 */
export function findAllByProp(node: unknown, key: string, value: unknown): MiniElement[] {
  return findAllWhere(node, (el) => el.props[key] === value);
}

/** 自己判。**找子组件节点用 `el.type === TabStrip`** —— 比字符串靠得住。 */
export function findAllWhere(node: unknown, pred: (el: MiniElement) => boolean): MiniElement[] {
  const out: MiniElement[] = [];
  walk(node, (el) => { if (pred(el)) out.push(el); });
  return out;
}

/** 唯一命中，找不到或多于一个就抛。 */
export function findOneWhere(node: unknown, pred: (el: MiniElement) => boolean): MiniElement {
  const hits = findAllWhere(node, pred);
  if (hits.length !== 1) throw new Error(`miniReact: 期望恰好命中 1 个节点，实际 ${String(hits.length)} 个`);
  return hits[0];
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

function fakeElement(inst: Inst, tagName: string, testId: string | undefined): FakeElement {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    testId,
    getBoundingClientRect: () => inst.rectOf(testId, tagName),
  };
  return el;
}

/** 按 React 的次序：**渲染完先挂 ref，再跑 effect**（effect 里读 `ref.current` 要读得到）。 */
function attachRefs(inst: Inst): void {
  walk(inst.tree, (el) => {
    if (typeof el.type !== 'string') return;
    const ref: unknown = el.props.ref;
    if (typeof ref !== 'object' || ref === null || !('current' in ref)) return;
    let fake = inst.refEls.get(ref);
    if (fake === undefined) {
      fake = fakeElement(inst, el.type, el.props['data-testid']);
      inst.refEls.set(ref, fake);
    }
    (ref as { current: unknown }).current = fake;
  });
}

function flushEffects(inst: Inst): void {
  while (inst.pending.length > 0) {
    const i = inst.pending.shift() as number;
    const run = inst.runners.get(i);
    if (run === undefined) continue;
    const slot = inst.slots[i];
    if (typeof slot.cleanup === 'function') slot.cleanup();
    slot.cleanup = run();
  }
}

function renderInst(inst: Inst): void {
  inst.renders += 1;
  if (inst.renders > 200) throw new Error('miniReact: 渲染超过 200 次，多半是渲染期 setState 死循环');
  const prev = cur;
  cur = inst;
  inst.cursor = 0;
  try {
    inst.tree = inst.fn(inst.props);
  } finally {
    cur = prev;
  }
  attachRefs(inst);
  flushEffects(inst);
}

export type Mounted<P> = {
  /** 最近一次渲染出来的元素树。 */
  readonly tree: unknown;
  find(testId: string): MiniElement;
  query(testId: string): MiniElement | null;
  /** 换一份 props 再渲染一遍。 */
  rerender(props: P): void;
  /** 等一拍宏任务，让组件里 fire-and-forget 的 async effect 落地。 */
  settle(): Promise<void>;
  /** 卸载：按 React 的次序先跑清理函数，再把 ref 摘掉。 */
  unmount(): void;
  /** 渲染了几次。 */
  readonly renders: number;
};

export type MountOptions = {
  /** 某个 `data-testid` 的元素被量出来是多大。不给就是零矩形。 */
  rects?: Record<string, { left: number; top: number; width: number; height: number }>;
};

export function mount<P>(fn: (props: P) => unknown, props: P, opts: MountOptions = {}): Mounted<P> {
  const inst: Inst = {
    fn: fn as (p: any) => unknown,
    props,
    slots: [],
    cursor: 0,
    pending: [],
    runners: new Map(),
    tree: null,
    alive: true,
    renders: 0,
    refEls: new Map(),
    rectOf: (testId) => {
      const r = testId === undefined ? undefined : opts.rects?.[testId];
      return r === undefined ? ZERO : rect(r);
    },
  };
  renderInst(inst);
  return {
    get tree() { return inst.tree; },
    get renders() { return inst.renders; },
    find: (id) => findByTestId(inst.tree, id),
    query: (id) => queryByTestId(inst.tree, id),
    rerender: (next) => { inst.props = next; renderInst(inst); },
    settle: () => new Promise<void>((r) => { setTimeout(r, 0); }),
    unmount: () => {
      inst.alive = false;
      for (const slot of inst.slots) {
        if (slot && typeof slot.cleanup === 'function') {
          slot.cleanup();
          slot.cleanup = undefined;
        }
      }
      for (const ref of inst.refEls.keys()) (ref as { current: unknown }).current = null;
    },
  };
}
