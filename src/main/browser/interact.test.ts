import { describe, it, expect } from 'vitest';
import INTERACT_SOURCE from './injected/interact.js?raw';

/**
 * `injected/interact.js` 的单测。
 *
 * 照 walker / pwRegistrar 那套办法：这段代码在**网页里**执行、类型系统管不到它，
 * 所以用 `new Function` 把源码**真的跑起来**，配一套替身 DOM。替身考得住的是判据本身
 * （滚不滚、量的是哪一刻的坐标、命中检查放不放行、密码闸拦不拦），
 * 「隔离世界真的骗不到页面覆写」那一条要靠 e2e。
 */

// ── 替身 DOM ────────────────────────────────────────────────────────────────

type Rect = { left: number; top: number; width: number; height: number; right: number; bottom: number };

const rect = (left: number, top: number, width: number, height: number): Rect =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

type ElInit = Partial<Omit<El, 'tagName'>>;

class El {
  /** 替身的选择器：`doc.querySelector(sel)` 按它精确匹配。 */
  sel = '';
  attrs: Record<string, string> = {};
  kids: El[] = [];
  parent: El | Root | null = null;
  shadowRoot: Root | null = null;
  style: Record<string, string> = { overflowY: 'visible' };
  rect: Rect = rect(0, 0, 100, 20);
  type?: string;
  value?: string;
  options?: Array<{ value: string; text: string }>;
  disabled?: boolean;
  readOnly?: boolean;
  isContentEditable?: boolean;
  className = '';
  /** 真 DOM 里元素恒为 1。滚动链往上走会经过 ShadowRoot(11) / document(9)，
   *  实现按这个数早退，替身不给就等于把那道早退测空了。 */
  nodeType = 1;
  /** 命中检查用：elementFromPoint 只在这些元素里挑（按数组顺序，后面的更靠上）。 */
  hittable = true;
  /** 真 DOM 会把写进来的值**夹到 [0, scrollHeight - clientHeight]**。
   *  不夹的话「已经到底」那条用例考的就不是实现，是替身的算术。 */
  private _scrollTop = 0;
  get scrollTop(): number { return this._scrollTop; }
  set scrollTop(v: number) {
    this._scrollTop = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - this.clientHeight)));
  }
  scrollHeight = 100;
  clientHeight = 100;
  // ── 观测点 ──
  scrollIntoViewCalls: unknown[] = [];
  focusCalls = 0;
  selectCalls = 0;
  dispatched: Array<{ type: string; bubbles: boolean }> = [];

  constructor(readonly tagName: string, init: ElInit = {}) {
    // scrollTop 最后设：它的 setter 要读 scrollHeight / clientHeight 才夹得对，
    // 而 Object.assign 按键顺序来 —— 先设 scrollTop 会被默认尺寸夹成 0。
    const { scrollTop, ...rest } = init;
    Object.assign(this, rest);
    if (scrollTop !== undefined) this.scrollTop = scrollTop;
    const t = tagName.toUpperCase();
    if (t === 'INPUT' || t === 'TEXTAREA') this.select = () => { this.selectCalls += 1; };
  }

  get parentNode(): El | Root | null { return this.parent; }
  getAttribute(name: string): string | null {
    const k = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  getBoundingClientRect(): Rect { return this.rect; }
  scrollIntoView(opts: unknown): void { this.scrollIntoViewCalls.push(opts); }
  focus(): void { this.focusCalls += 1; doc.activeElement = this; }
  /** **只有 input / textarea 有 select()**（构造时按 tag 装上）。真 DOM 如此，
   *  而 contenteditable 走的正是「没有 select() 就用 Range」那条分支 ——
   *  替身给每个元素都装上，那条分支就一条用例都覆盖不到。 */
  select?: () => void;
  dispatchEvent(e: { type: string; bubbles: boolean }): void { this.dispatched.push(e); }
  get innerText(): string { return this.attrs.__text ?? ''; }
  get textContent(): string { return this.attrs.__text ?? ''; }
}

class Root {
  readonly nodeType = 11;
  constructor(public kids: El[], readonly host: El | null = null) {
    for (const k of flat(kids)) if (!k.parent) k.parent = this;
  }
  querySelectorAll(sel: string): El[] {
    if (sel !== '*') throw new Error(`替身只支持 '*'，收到 ${sel}`);
    return this.kids.slice();
  }
  querySelector(s: string): El | null { return this.kids.find((e) => e.sel === s) ?? null; }
  elementFromPoint(x: number, y: number): El | null { return topmost(this.kids, x, y); }
}

const flat = (els: El[]): El[] => els.flatMap((e) => [e, ...flat(e.kids)]);

const topmost = (els: El[], x: number, y: number): El | null => {
  let hit: El | null = null;
  for (const e of els) {
    if (!e.hittable) continue;
    const r = e.rect;
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) hit = e;
  }
  return hit;
};

type Doc = {
  activeElement: El | null;
  scrollingElement: El;
  documentElement: El;
  querySelector(s: string): El | null;
  querySelectorAll(s: string): El[];
  elementFromPoint(x: number, y: number): El | null;
  createRange(): { selectNodeContents(e: El): void };
};

let doc: Doc;

type Win = {
  innerWidth: number;
  innerHeight: number;
  scrollBy(x: number, y: number): void;
  getComputedStyle(e: El): Record<string, string>;
  getSelection(): { removeAllRanges(): void; addRange(r: unknown): void };
  __kydogWorld?: { ids: WeakMap<object, number>; pw: WeakSet<object> };
  __scrolledBy: number[];
  __rangeOn: El[];
};

type Req = Record<string, unknown>;
type Res = Record<string, unknown>;

const run = new Function('window', 'document', `return (${INTERACT_SOURCE});`) as
  (w: unknown, d: unknown) => (req: Req) => Res;

/** 建一个场景：元素列表 → window / document / 调用入口。 */
function stage(els: El[], opts: { world?: boolean; badSelector?: string } = {}) {
  const all = flat(els);
  const root = new Root(els);
  const scroller = new El('HTML', { scrollTop: 0, scrollHeight: 5000, clientHeight: 800 });
  doc = {
    activeElement: null,
    scrollingElement: scroller,
    documentElement: scroller,
    querySelector: (s: string) => {
      if (opts.badSelector !== undefined && s === opts.badSelector) throw new Error('SyntaxError');
      return all.find((e) => e.sel === s) ?? null;
    },
    querySelectorAll: (s: string) => {
      if (s !== '*') throw new Error(`替身只支持 '*'，收到 ${s}`);
      return els.slice();
    },
    elementFromPoint: (x: number, y: number) => topmost(all.filter((e) => e.parent === root || e.parent === null || flat(els).includes(e)), x, y),
    createRange: () => ({ selectNodeContents: (e: El) => { win.__rangeOn.push(e); } }),
  };
  const win: Win = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollBy: (_x: number, y: number) => { win.__scrolledBy.push(y); scroller.scrollTop += y; },
    getComputedStyle: (e: El) => e.style,
    getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    __scrolledBy: [],
    __rangeOn: [],
  };
  if (opts.world !== false) win.__kydogWorld = { ids: new WeakMap(), pw: new WeakSet() };
  const call = (req: Req): Res => run(win, doc)(req);
  return { win, doc, call, scroller, root };
}

const bySel = (sel: string) => ({ selector: sel });

// ── A · 目标解析 ────────────────────────────────────────────────────────────

describe('目标解析', () => {
  it('selector 命中就用它', () => {
    const q = new El('INPUT', { sel: '#q', rect: rect(10, 10, 200, 30) });
    const { call } = stage([q]);
    expect(call({ op: 'measure', target: bySel('#q') }).ok).toBe(true);
  });

  it('selector 无匹配 → not_found', () => {
    const { call } = stage([new El('INPUT', { sel: '#q' })]);
    expect(call({ op: 'measure', target: bySel('#nope') })).toMatchObject({ ok: false, reason: 'not_found' });
  });

  // 语法错的选择器在页面里抛 DOMException。让它冒出去的话模型收到一句 SyntaxError，
  // 于是去怀疑页面结构而不是自己的写法。
  it('selector 语法错 → bad_selector，不把 DOMException 冒出去', () => {
    const { call } = stage([new El('INPUT', { sel: '#q' })], { badSelector: 'a[[' });
    expect(call({ op: 'measure', target: bySel('a[[') })).toMatchObject({ ok: false, reason: 'bad_selector' });
  });

  it('nodeId 反查得到发号表里的那个元素', () => {
    const a = new El('A', { sel: '#a', rect: rect(0, 0, 50, 20) });
    const b = new El('BUTTON', { sel: '#b', rect: rect(0, 40, 50, 20) });
    const { call, win } = stage([a, b]);
    win.__kydogWorld!.ids.set(a, 7);
    win.__kydogWorld!.ids.set(b, 9);
    expect(call({ op: 'measure', target: { nodeId: 9 } })).toMatchObject({ ok: true, tag: 'button' });
  });

  // walker 的 scan 递归进 open shadow root 发号。反查只查 document.querySelectorAll('*')
  // 的话，组件库里真正的控件一律反查不到 —— 报出来是「这个编号找不到了」，而它就在页面上。
  it('nodeId 反查要穿透 open shadow root —— walker 在那里也发号', () => {
    const inner = new El('INPUT', { rect: rect(0, 0, 100, 30) });
    const host = new El('SEARCH-BOX', { sel: '#host' });
    host.shadowRoot = new Root([inner], host);
    inner.parent = host.shadowRoot;
    const { call, win } = stage([host]);
    win.__kydogWorld!.ids.set(inner, 42);
    expect(call({ op: 'measure', target: { nodeId: 42 } })).toMatchObject({ ok: true, tag: 'input' });
  });

  it('nodeId 反查不到 → stale_node（与 not_found 分开：这条要重新取快照）', () => {
    const { call } = stage([new El('A', { sel: '#a' })]);
    expect(call({ op: 'measure', target: { nodeId: 5 } })).toMatchObject({ ok: false, reason: 'stale_node' });
  });

  it('隔离世界的发号表整个不在（文档换过）→ stale_node', () => {
    const { call } = stage([new El('A', { sel: '#a' })], { world: false });
    expect(call({ op: 'measure', target: { nodeId: 1 } })).toMatchObject({ ok: false, reason: 'stale_node' });
  });
});

// ── B · spec §4.2 的三件事 ─────────────────────────────────────────────────

describe('点击之前的三件事，一件都不能省', () => {
  it('① 滚进视野：用元素自己的 scrollIntoView，居中', () => {
    const q = new El('BUTTON', { sel: '#b', rect: rect(10, 10, 100, 40) });
    const { call } = stage([q]);
    call({ op: 'measure', target: bySel('#b') });
    expect(q.scrollIntoViewCalls).toEqual([{ block: 'center', inline: 'center' }]);
  });

  // 快照里的坐标是**快照当时**的。输入框展开一次、图片加载完一次就旧了，
  // 而快照本身没变、stale_index 不会响。
  it('② 坐标是这一刻量的 —— 元素动了就返回新坐标', () => {
    const q = new El('BUTTON', { sel: '#b', rect: rect(10, 10, 100, 40) });
    const { call } = stage([q]);
    expect(call({ op: 'measure', target: bySel('#b') })).toMatchObject({ x: 60, y: 30 });
    q.rect = rect(10, 500, 100, 40);
    expect(call({ op: 'measure', target: bySel('#b') })).toMatchObject({ x: 60, y: 520 });
  });

  // 百度学术那个授权对话框、各家的 cookie 横幅都会**静默吃掉**点击。
  it('③ 命中检查：浮层挡住 → intercepted，并说清是谁挡的', () => {
    const q = new El('BUTTON', { sel: '#b', rect: rect(10, 10, 100, 40) });
    const cover = new El('DIV', { rect: rect(0, 0, 1280, 400), className: 'cookie-banner' });
    const { call } = stage([q, cover]);
    const r = call({ op: 'measure', target: bySel('#b') });
    expect(r).toMatchObject({ ok: false, reason: 'intercepted' });
    expect(String(r.by)).toContain('cookie-banner');
  });

  it('目标的后代命中算放行 —— <button><span>搜索</span></button>', () => {
    const span = new El('SPAN', { rect: rect(20, 20, 60, 20) });
    const q = new El('BUTTON', { sel: '#b', rect: rect(10, 10, 100, 40), kids: [span] });
    span.parent = q;
    const { call } = stage([q, span]);
    expect(call({ op: 'measure', target: bySel('#b') }).ok).toBe(true);
  });

  // 不穿透的话 elementFromPoint 命中的是**宿主**，于是每个组件库控件都被报成
  // 「被浮层挡住」—— 把「点得到」误报成「点不到」，模型会去关一个不存在的浮层。
  it('shadow 里的控件不许被误报成 intercepted', () => {
    const inner = new El('INPUT', { rect: rect(10, 10, 100, 30) });
    const host = new El('SEARCH-BOX', { sel: '#host', rect: rect(10, 10, 100, 30) });
    host.shadowRoot = new Root([inner], host);
    inner.parent = host.shadowRoot;
    const { call, win } = stage([host]);
    win.__kydogWorld!.ids.set(inner, 3);
    // document.elementFromPoint 回的是宿主（替身里 host 才在文档树上）
    expect(call({ op: 'measure', target: { nodeId: 3 } })).toMatchObject({ ok: true, tag: 'input' });
  });

  // 判据与 walker 的 visible() 第一条**同一个数**（`< 2`）：1×1 的元素在两边都算
  // 看不见。写成 `<= 0` 的话，站点用 1×1 的透明 <a> 做埋点那种就会被判成可点。
  it.each([[0, 0], [1, 1], [1, 30], [30, 1]])('折叠到看不见（%i×%i）→ not_visible，不是 intercepted', (w, h) => {
    const q = new El('A', { sel: '#a', rect: rect(10, 10, w, h) });
    const { call } = stage([q]);
    expect(call({ op: 'measure', target: bySel('#a') })).toMatchObject({ ok: false, reason: 'not_visible' });
  });

  it('2×2 就算看得见 —— 上一条不是把所有小元素都拒了', () => {
    const q = new El('A', { sel: '#a', rect: rect(10, 10, 2, 2) });
    const { call } = stage([q]);
    expect(call({ op: 'measure', target: bySel('#a') })).toMatchObject({ ok: true });
  });

  // 滚过之后仍在视口外（position:fixed 的祖先、内层容器自己在视口外）。
  // 不单独判的话 elementFromPoint 回 null → 报成「被 null 挡住了」，说的是另一件事。
  it('滚过之后仍在视口外 → offscreen，不是「被 null 挡住」', () => {
    const q = new El('A', { sel: '#a', rect: rect(10, 5000, 100, 30) });
    const { call } = stage([q]);
    const r = call({ op: 'measure', target: bySel('#a') });
    expect(r).toMatchObject({ ok: false, reason: 'offscreen' });
    expect(String(r.reason)).not.toBe('intercepted');
  });
});

// ── C · type 之前的聚焦与全选 ───────────────────────────────────────────────

describe('focusSelect：密码闸第二道 + 全选', () => {
  it('密码框：报 password，而且 focus 一次都不许调', () => {
    const p = new El('INPUT', { sel: '#p', type: 'password', value: 'hunter2' });
    const { call } = stage([p]);
    expect(call({ op: 'focusSelect', target: bySel('#p') })).toMatchObject({ ok: false, reason: 'password' });
    expect(p.focusCalls).toBe(0);
  });

  // 判据与 walker 一致（四条），不是「此刻 type 等于 password」这一条。
  it('曾经是密码框（world.pw 记着）：type 改成 text 也照样拦', () => {
    const p = new El('INPUT', { sel: '#p', type: 'text', value: 'hunter2' });
    const { call, win } = stage([p]);
    win.__kydogWorld!.pw.add(p);
    expect(call({ op: 'focusSelect', target: bySel('#p') })).toMatchObject({ ok: false, reason: 'password' });
  });

  // insertText 打到非可编辑元素上是**ack 0ms 而什么都不做**（实测：body / button /
  // readonly / disabled 四种）。不拦的话「打进去了」就是一句没有依据的话。
  const notEditable: Array<[string, El]> = [
    ['button', new El('BUTTON', { sel: '#x' })],
    ['readonly input', new El('INPUT', { sel: '#x', type: 'text', readOnly: true })],
    ['disabled input', new El('INPUT', { sel: '#x', type: 'text', disabled: true })],
    ['checkbox', new El('INPUT', { sel: '#x', type: 'checkbox' })],
    ['普通 div', new El('DIV', { sel: '#x' })],
  ];
  for (const [label, node] of notEditable) {
    it(`${label} 不是能打字的控件 → not_editable`, () => {
      const { call } = stage([node]);
      expect(call({ op: 'focusSelect', target: bySel('#x') })).toMatchObject({ ok: false, reason: 'not_editable' });
    });
  }

  // 实测：点在有内容的框中间之后 insertText 是**插入**（"旧内容" + "石墨烯" →
  // "旧内容石墨烯"），插在哪取决于点到了哪个像素。全选之后才是替换。
  it('可编辑：focus 之后要全选 —— 否则 insertText 插在光标处', () => {
    const q = new El('INPUT', { sel: '#q', type: 'text', value: '旧内容' });
    const { call } = stage([q]);
    expect(call({ op: 'focusSelect', target: bySel('#q') })).toMatchObject({ ok: true, selected: true });
    expect(q.focusCalls).toBe(1);
    expect(q.selectCalls).toBe(1);
  });

  it('contenteditable 没有 select()：用 Range 选中它的全部内容', () => {
    const ce = new El('DIV', { sel: '#ce', isContentEditable: true });
    const { call, win } = stage([ce]);
    expect(call({ op: 'focusSelect', target: bySel('#ce') })).toMatchObject({ ok: true, selected: true });
    expect(win.__rangeOn).toEqual([ce]);
  });
});

// ── D · 打完读回来 ──────────────────────────────────────────────────────────

describe('readValue：打完之后框里到底是什么', () => {
  it('把当前值读回来', () => {
    const q = new El('INPUT', { sel: '#q', type: 'text', value: '石墨烯' });
    const { call } = stage([q]);
    expect(call({ op: 'readValue', target: bySel('#q') })).toMatchObject({ ok: true, value: '石墨烯' });
  });

  it('密码框一个字都不回', () => {
    const p = new El('INPUT', { sel: '#p', type: 'password', value: 'hunter2' });
    const { call } = stage([p]);
    const r = call({ op: 'readValue', target: bySel('#p') });
    expect(r).toMatchObject({ ok: false, reason: 'password' });
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('超长的值截断并带原长', () => {
    const q = new El('INPUT', { sel: '#q', type: 'text', value: 'x'.repeat(500) });
    const { call } = stage([q]);
    const r = call({ op: 'readValue', target: bySel('#q') });
    expect(r.truncated).toBe(true);
    expect(r.length).toBe(500);
    expect(String(r.value).length).toBeLessThan(500);
  });
});

// ── E · select ──────────────────────────────────────────────────────────────

describe('select：值必须真的在选项里', () => {
  const mk = () => new El('SELECT', {
    sel: '#year', value: '',
    options: [{ value: '2024', text: '2024 年' }, { value: '2023', text: '2023 年' }],
  });

  it('不是 <select> → not_select', () => {
    const { call } = stage([new El('INPUT', { sel: '#year' })]);
    expect(call({ op: 'select', target: bySel('#year'), value: '2024' })).toMatchObject({ ok: false, reason: 'not_select' });
  });

  // `el.value = '不存在'` 会把 select 变成「什么都没选」（value 变空串），
  // 下一步提交出去就是一次空筛选 —— 不报错，只是结果是错的。
  it('值不在选项里 → no_option，并列出可选值，且一个字都不写进去', () => {
    const s = mk();
    const { call } = stage([s]);
    const r = call({ op: 'select', target: bySel('#year'), value: '1999' });
    expect(r).toMatchObject({ ok: false, reason: 'no_option', total: 2 });
    expect(r.options).toEqual(['2024', '2023']);
    expect(s.value).toBe('');
  });

  it('值在选项里：赋值，并派发会冒泡的 input + change', () => {
    const s = mk();
    const { call } = stage([s]);
    expect(call({ op: 'select', target: bySel('#year'), value: '2023' }))
      .toMatchObject({ ok: true, value: '2023', label: '2023 年', changed: true });
    expect(s.value).toBe('2023');
    expect(s.dispatched.map((e) => `${e.type}:${e.bubbles}`)).toEqual(['input:true', 'change:true']);
  });
});

// ── F · scroll ──────────────────────────────────────────────────────────────

describe('scroll：滚的是滚动链上的那个容器', () => {
  it('没有内层容器就滚 document，默认一屏（视口高度）', () => {
    const { call, win, scroller } = stage([]);
    const r = call({ op: 'scroll', direction: 'down' });
    expect(win.__scrolledBy).toEqual([800]);
    expect(r).toMatchObject({ ok: true, container: 'document', before: 0, after: 800, delta: 800, step: 800 });
    expect(scroller.scrollTop).toBe(800);
  });

  it('up 是负方向', () => {
    const { call, win } = stage([]);
    call({ op: 'scroll', direction: 'up' });
    expect(win.__scrolledBy).toEqual([-800]);
  });

  it('给了 amount 就按 amount 滚', () => {
    const { call, win } = stage([]);
    call({ op: 'scroll', direction: 'down', amount: 120 });
    expect(win.__scrolledBy).toEqual([120]);
  });

  // 学术站点的结果区大量是内层 overflow:auto。滚 document 是一像素都不动，
  // 而返回值会说「滚过了」。
  it('光标下有内层滚动容器就滚它，document 一动不动', () => {
    const pane = new El('DIV', {
      rect: rect(0, 0, 1280, 800), className: 'result-pane',
      style: { overflowY: 'auto' }, scrollTop: 0, scrollHeight: 3000, clientHeight: 600,
    });
    const { call, win, scroller } = stage([pane]);
    const r = call({ op: 'scroll', direction: 'down' });
    expect(pane.scrollTop).toBe(600);
    expect(win.__scrolledBy).toEqual([]);
    expect(scroller.scrollTop).toBe(0);
    expect(r).toMatchObject({ container: 'div.result-pane', delta: 600, step: 600 });
  });

  it('overflow 不是 auto/scroll 的祖先不算滚动容器', () => {
    const pane = new El('DIV', {
      rect: rect(0, 0, 1280, 800), className: 'plain',
      style: { overflowY: 'visible' }, scrollTop: 0, scrollHeight: 3000, clientHeight: 600,
    });
    const { call, win } = stage([pane]);
    expect(call({ op: 'scroll', direction: 'down' })).toMatchObject({ container: 'document' });
    expect(win.__scrolledBy).toEqual([800]);
  });

  // 「已经到底了」与「这次滚动没生效」在返回值里必须分得开。
  it('已经到底：delta 是 0，并且说得出 atEnd', () => {
    const pane = new El('DIV', {
      rect: rect(0, 0, 1280, 800), className: 'pane',
      style: { overflowY: 'auto' }, scrollTop: 400, scrollHeight: 1000, clientHeight: 600,
    });
    const { call } = stage([pane]);
    const r = call({ op: 'scroll', direction: 'down' });
    expect(r).toMatchObject({ atEnd: true, delta: 0, before: 400, after: 400 });
  });
});

describe('不认识的 op', () => {
  it('明确报出来，不当成成功', () => {
    const { call } = stage([new El('A', { sel: '#a' })]);
    expect(call({ op: 'teleport', target: bySel('#a') })).toMatchObject({ ok: false, reason: 'unknown_op' });
  });
});
