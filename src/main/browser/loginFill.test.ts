import { describe, it, expect } from 'vitest';
import LOGIN_FILL_SOURCE from './injected/loginFill.js?raw';

/**
 * `injected/loginFill.js` 的单测。
 *
 * 照 walker / interact / pwRegistrar 那套办法：这段代码在**网页里**执行、类型系统
 * 管不到它、也没有第二处会因为它漂移而编译报错 —— 所以用 `new Function` 把源码
 * **真的跑起来**，配一套替身 DOM。
 *
 * 替身刻意做成「原型上有 value 访问器、实例上可以再盖一个」的形状：**React 受控
 * 组件那条路正是靠这个才考得住**（见下面「原型原生 setter」那一组）。
 */

// ── 替身 DOM ────────────────────────────────────────────────────────────────

class FakeInput {
  tagName = 'INPUT';
  type = 'text';
  disabled = false;
  form: FakeForm | null = null;
  shadowRoot: FakeRoot | null = null;
  attrs: Record<string, string> = {};
  /** 有没有布局盒。`getClientRects().length > 0` 就是从它来的。 */
  laidOut = true;
  focusCalls = 0;
  events: string[] = [];
  /** 真 DOM 里 `value` 是**原型上的访问器**，这份替身照做 —— 实例上还能再盖一个。 */
  private _v = '';
  /** 实例上那个「盖住的」setter 吃掉了几次写入（模拟 React 的 value tracker）。 */
  swallowed = 0;

  constructor(init: Partial<FakeInput> & { attrs?: Record<string, string> } = {}) {
    Object.assign(this, init);
  }

  get value(): string { return this._v; }
  set value(v: string) { this._v = v; }
  /** 绕过一切访问器直接看真实值 —— 只有用例用它。 */
  get raw(): string { return this._v; }
  set raw(v: string) { this._v = v; }

  getAttribute(n: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
  }

  /**
   * `name` / `id` 在真 DOM 里是**反射 content attribute 的 IDL 属性**（缺席时回空串），
   * 所以替身也必须有 —— 与 `attrs` 同源，不许是第二份事实。
   *
   * **少了它们，判据的一整个维度就没人守。** 评审 I5 实测：往密码框判据里加回
   * 「名字里带 pass/pwd 就算密码框」这种启发式（变异 R33），在补上这两个属性之前
   * **2884 条全绿** —— 因为 `el.name` / `el.id` 在替身里恒为 undefined，任何读 IDL
   * 属性的启发式都命不中。而「判据只有两条协议层事实」正是本批最要紧的设计决定。
   */
  get name(): string { return this.getAttribute('name') ?? ''; }
  get id(): string { return this.getAttribute('id') ?? ''; }
  getClientRects(): unknown[] { return this.laidOut ? [{}] : []; }
  focus(): void { this.focusCalls += 1; }
  dispatchEvent(e: { type: string }): void { this.events.push(e.type); }
}

/** 非 input 的普通元素（用来当 shadow host、或者只是占个文档序）。 */
class FakeEl {
  shadowRoot: FakeRoot | null = null;
  constructor(readonly tagName: string) {}
}

type AnyEl = FakeInput | FakeEl;

class FakeForm {
  submits: Array<unknown> = [];
  /** `typeof form.requestSubmit === 'function'` 那道探路查的就是它在不在。 */
  requestSubmit?: (btn?: unknown) => void;
  constructor(
    readonly submitBtn: { click: () => void; clicks: number } | null = null,
    opts: { hasRequestSubmit?: boolean; throwOnSubmit?: boolean } = {},
  ) {
    if (opts.hasRequestSubmit !== false) {
      this.requestSubmit = (btn?: unknown) => {
        if (opts.throwOnSubmit) throw new Error('表单校验没过');
        this.submits.push(btn ?? null);
      };
    }
  }
  querySelector(sel: string): unknown {
    if (sel !== 'button[type="submit"], input[type="submit"]') throw new Error(`替身不支持 ${sel}`);
    return this.submitBtn;
  }
}

class FakeRoot {
  constructor(readonly els: AnyEl[]) {}
  querySelectorAll(sel: string): AnyEl[] {
    if (sel !== '*') throw new Error(`替身只支持 '*'，收到 ${sel}`);
    return this.els.slice();
  }
}

const submitButton = () => {
  const b = { clicks: 0, click: () => { b.clicks += 1; } };
  return b;
};

type Req = Record<string, unknown>;
type Res = Record<string, unknown>;

const build = new Function('window', 'document', `return (${LOGIN_FILL_SOURCE});`) as
  (w: unknown, d: unknown) => (req: Req) => Res;

const ORIGIN = 'https://iaaa.pku.edu.cn';

/** 建一个场景。`world` 给 false 就是「隔离世界还没建起来」。 */
function stage(els: AnyEl[], opts: {
  origin?: string;
  world?: boolean;
  pw?: FakeInput[];
  ids?: Array<[FakeInput, number]>;
} = {}) {
  const root = new FakeRoot(els);
  const doc = {
    querySelectorAll: (s: string) => root.querySelectorAll(s),
  };
  const events: Array<{ type: string; bubbles: boolean }> = [];
  class Ev {
    constructor(readonly type: string, init: { bubbles?: boolean } = {}) {
      events.push({ type, bubbles: init.bubbles === true });
    }
  }
  const win: Record<string, unknown> = {
    location: { origin: opts.origin ?? ORIGIN },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class { },
    Event: Ev,
  };
  if (opts.world !== false) {
    const ids = new WeakMap<object, number>();
    for (const [el, id] of opts.ids ?? []) ids.set(el, id);
    const pw = new WeakSet<object>();
    for (const el of opts.pw ?? []) pw.add(el);
    win.__kydogWorld = { gen: 'g1', next: 1, ids, pw };
  }
  return { run: build(win, doc), events };
}

const REQ = (over: Req = {}): Req => ({
  expectOrigin: ORIGIN, username: 'u2100011000', password: 'p@ss', submit: false, ...over,
});

// ── 两道自检 ────────────────────────────────────────────────────────────────

describe('两道自检都排在碰页面之前', () => {
  it('过期了就一个字都不写（与 interact.js 同一条判据）', () => {
    const user = new FakeInput({ attrs: { name: 'u' } });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm();
    user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    const r = run(REQ({ notAfter: Date.now() - 1 }));
    expect(r).toEqual({ ok: false, reason: 'expired', wrote: false });
    expect(user.raw).toBe('');
    expect(pw.raw).toBe('');
  });

  it('没到点就照常执行 —— 自检不许误杀慢页面', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    expect(run(REQ({ notAfter: Date.now() + 60_000 })).ok).toBe(true);
  });

  /**
   * **这是 TOCTOU 的第二层。** 主进程在排队之后、注入之前用 `wc.getURL()` 重判过
   * 一次，而那一判到这段代码真的在页面里跑起来，中间还隔着一次跨进程往返。
   */
  it('页面在这中间跳走了就一个字都不写，并回报现在在哪', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const { run } = stage([user, pw], { origin: 'https://evil.example' });
    expect(run(REQ())).toEqual({ ok: false, reason: 'origin_changed', wrote: false, origin: 'https://evil.example' });
    expect(user.raw).toBe('');
    expect(pw.raw).toBe('');
  });

  it('调用方没给 expectOrigin 也拒 —— 少一个字段不许退化成不设防', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    const r = run({ username: 'u', password: 'p', submit: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('origin_changed');
    expect(pw.raw).toBe('');
  });
});

// ── 密码框：恰好一个 ────────────────────────────────────────────────────────

describe('密码框的判据只有两条协议事实，且必须恰好一个', () => {
  it('此刻 type 就是 password → 认', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    expect(run(REQ()).ok).toBe(true);
    expect(pw.raw).toBe('p@ss');
  });

  /** 站点点了「显示密码」把 type 改成 text —— 常驻登记（pwRegistrar）见过它。 */
  it('这个文档里曾经是密码框（world.pw 记着）→ 照样认', () => {
    const user = new FakeInput(); const shown = new FakeInput({ type: 'text' });
    const form = new FakeForm(); user.form = form; shown.form = form;
    const { run } = stage([user, shown], { pw: [shown] });
    const r = run(REQ());
    expect(r.ok).toBe(true);
    expect(shown.raw).toBe('p@ss');
    expect(user.raw).toBe('u2100011000');
  });

  it('一个都没有 → no_password，一个字都不写', () => {
    const a = new FakeInput(); const b = new FakeInput();
    const { run } = stage([a, b]);
    expect(run(REQ())).toEqual({ ok: false, reason: 'no_password', wrote: false });
    expect(a.raw).toBe('');
  });

  /**
   * **多于一个直接拒，不猜。** 猜错就是把校园密码写进一个说不清用途的框
   * （「修改密码」页上的「新密码 / 确认新密码」正是这个形状）。
   */
  it('多于一个 → many_passwords，报出数目，一个字都不写', () => {
    const user = new FakeInput();
    const p1 = new FakeInput({ type: 'password' });
    const p2 = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; p1.form = form; p2.form = form;
    const { run } = stage([user, p1, p2]);
    expect(run(REQ())).toEqual({ ok: false, reason: 'many_passwords', wrote: false, count: 2 });
    expect(p1.raw).toBe('');
    expect(p2.raw).toBe('');
  });

  /**
   * 这里**刻意不用** walker / interact 那份四条判据（autocomplete / name 正则）。
   * 那三份守的是「不许往它里面打字」，宽一点只多拒几个框；这里回答的是「把密码放
   * 进**哪一个**框」，宽一点就会把一个只是名字里带 pwd 的框数进来，于是整条被
   * many_passwords 拒掉 —— 而页面上其实只有一个真密码框。
   */
  it('即使 name 就叫 password、id 就叫 pwd、autocomplete 写着 current-password，也不算密码框', () => {
    const user = new FakeInput({ attrs: { name: 'userName' } });
    const hint = new FakeInput({
      type: 'text',
      attrs: { name: 'password', id: 'pwd', autocomplete: 'current-password' },
    });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm();
    user.form = form; hint.form = form; pw.form = form;
    // **替身真的有这两个 IDL 属性**才考得住读 IDL 属性的启发式（评审 I5 / 变异 R33）。
    expect(hint.name).toBe('password');
    expect(hint.id).toBe('pwd');
    const { run } = stage([user, hint, pw]);
    const r = run(REQ());
    // 判据放宽的话它会被数成第二个密码框 → many_passwords，整条拒掉。
    expect(r.ok).toBe(true);
    expect(pw.raw).toBe('p@ss');
    // 账号进的是排在密码框之前**最近的**那个可填文本框。
    expect(hint.raw).toBe('u2100011000');
    expect(user.raw).toBe('');
  });
});

// ── 账号框：模型指的 ────────────────────────────────────────────────────────

describe('账号框由模型指（usernameIndex → nodeId）', () => {
  const withIds = () => {
    const first = new FakeInput({ attrs: { name: 'realm' } });
    const user = new FakeInput({ attrs: { name: 'userName', id: 'un' } });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm();
    first.form = form; user.form = form; pw.form = form;
    return { first, user, pw, form };
  };

  it('指了哪个就填哪个，并回显选中的是哪个框（且回显里没有它的值）', () => {
    const { first, user, pw } = withIds();
    const { run } = stage([first, user, pw], { ids: [[first, 11], [user, 22]] });
    const r = run(REQ({ usernameNodeId: 11 }));
    expect(r.ok).toBe(true);
    expect(r.source).toBe('model');
    expect(first.raw).toBe('u2100011000');
    expect(user.raw).toBe('');
    expect(String(r.field)).toContain('[name=realm]');
    expect(String(r.field)).not.toContain('u2100011000');
  });

  /** interact.js 那条 fail-closed 同款：号不是数字时不许退化成「随便找一个」。 */
  it('号不是数字 → stale_username_index，绝不掉进结构规则', () => {
    const { first, user, pw } = withIds();
    const { run } = stage([first, user, pw], { ids: [[user, 22]] });
    expect(run(REQ({ usernameNodeId: 'abc' }))).toEqual({ ok: false, reason: 'stale_username_index', wrote: false });
    expect(first.raw).toBe('');
    expect(user.raw).toBe('');
    expect(pw.raw).toBe('');
  });

  it('隔离世界还没建起来（文档换过）→ stale_username_index', () => {
    const { first, user, pw } = withIds();
    const { run } = stage([first, user, pw], { world: false });
    expect(run(REQ({ usernameNodeId: 22 })).reason).toBe('stale_username_index');
  });

  it('号在这个文档里查不到 → stale_username_index', () => {
    const { first, user, pw } = withIds();
    const { run } = stage([first, user, pw], { ids: [[user, 22]] });
    expect(run(REQ({ usernameNodeId: 99 })).reason).toBe('stale_username_index');
  });

  it('与密码框不在同一个 form → 拒（spec §4.6 的两条校验之一）', () => {
    const { user, pw } = withIds();
    const other = new FakeInput({ attrs: { name: 'search' } });
    other.form = new FakeForm();
    const { run } = stage([other, user, pw], { ids: [[other, 33]] });
    expect(run(REQ({ usernameNodeId: 33 }))).toEqual({ ok: false, reason: 'username_not_same_form', wrote: false });
    expect(other.raw).toBe('');
  });

  it('不是文本类 input → 拒，并说清它是什么（spec §4.6 的另一条）', () => {
    const { user, pw, form } = withIds();
    const box = new FakeInput({ type: 'checkbox' });
    box.form = form;
    const { run } = stage([box, user, pw], { ids: [[box, 44]] });
    const r = run(REQ({ usernameNodeId: 44 }));
    expect(r.reason).toBe('username_not_text');
    expect(r.type).toBe('checkbox');
    expect(r.wrote).toBe(false);
  });

  it('指到密码框自己 → 也走 username_not_text（它不是文本类）', () => {
    const { user, pw } = withIds();
    const { run } = stage([user, pw], { ids: [[pw, 55]] });
    expect(run(REQ({ usernameNodeId: 55 })).reason).toBe('username_not_text');
    expect(pw.raw).toBe('');
  });

  it('disabled 的账号框 → 拒（填进去也提交不了）', () => {
    const { user, pw, form } = withIds();
    const dead = new FakeInput({ disabled: true });
    dead.form = form;
    const { run } = stage([dead, user, pw], { ids: [[dead, 66]] });
    expect(run(REQ({ usernameNodeId: 66 })).reason).toBe('username_disabled');
  });
});

// ── 账号框：结构规则 ────────────────────────────────────────────────────────

describe('没给 usernameIndex 时的结构规则', () => {
  it('取同一个 form 里、排在密码框之前、最近的那个可见文本框', () => {
    const far = new FakeInput({ attrs: { name: 'far' } });
    const near = new FakeInput({ attrs: { name: 'near' } });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); far.form = form; near.form = form; pw.form = form;
    const { run } = stage([far, near, pw]);
    const r = run(REQ());
    expect(r.source).toBe('structure');
    expect(near.raw).toBe('u2100011000');
    expect(far.raw).toBe('');
  });

  /**
   * 「排在密码框之前」是硬条件不是偏好。放宽成「取最近的一个」，在
   * 「账号 / 密码 / 验证码」这种版式上会选中**验证码框** —— 那是把账号写进验证码栏，
   * 站点收到一次必然失败的登录，而高校 IdP 会为连续失败锁账号。
   */
  it('密码框之后的文本框（验证码栏）绝不选', () => {
    const pw = new FakeInput({ type: 'password' });
    const captcha = new FakeInput({ attrs: { name: 'captcha' } });
    const form = new FakeForm(); pw.form = form; captcha.form = form;
    const { run } = stage([pw, captcha]);
    expect(run(REQ())).toEqual({ ok: false, reason: 'no_username', wrote: false });
    expect(captcha.raw).toBe('');
    expect(pw.raw).toBe('');
  });

  it('看不见的（display:none 的蜜罐）跳过，接着往前找', () => {
    const real = new FakeInput({ attrs: { name: 'real' } });
    const honey = new FakeInput({ attrs: { name: 'honey' }, laidOut: false });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); real.form = form; honey.form = form; pw.form = form;
    const { run } = stage([real, honey, pw]);
    expect(run(REQ()).ok).toBe(true);
    expect(real.raw).toBe('u2100011000');
    expect(honey.raw).toBe('');
  });

  it('hidden / checkbox 这类不算文本框', () => {
    const hidden = new FakeInput({ type: 'hidden' });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); hidden.form = form; pw.form = form;
    const { run } = stage([hidden, pw]);
    expect(run(REQ()).reason).toBe('no_username');
  });

  it('不同 form 里的文本框不算', () => {
    const elsewhere = new FakeInput();
    elsewhere.form = new FakeForm();
    const pw = new FakeInput({ type: 'password' });
    pw.form = new FakeForm();
    const { run } = stage([elsewhere, pw]);
    expect(run(REQ()).reason).toBe('no_username');
  });

  /**
   * **密码框不在任何 `<form>` 里时，这一支整条 fail-closed。**
   *
   * 那时 `(el.form || null) !== form` 两边都是 null，「同一个 form」不再是任何约束
   * —— 页面顶部的站内搜索框与账号框一样合格。评审实测（2026-09-09，真 Chromium）：
   * 早先这里会挑中 `#search`、`ok: true` 返回，账号写进搜索框、提交出去的是一次
   * **账号为空**的登录，而「一轮只有一次机会」意味着那是本轮唯一的机会。
   * 注释当时写的是「选不出来就明确报错」—— 行为与注释相反，这里让行为跟上注释。
   */
  it('密码框不在任何 <form> 里 → username_needs_index，不猜，一个字都不写', () => {
    const search = new FakeInput({ attrs: { id: 'search', placeholder: '站内搜索' } });
    const acct = new FakeInput({ attrs: { id: 'acct', placeholder: '学号' } });
    const pw = new FakeInput({ type: 'password' });
    const { run } = stage([search, acct, pw]);
    expect(run(REQ())).toEqual({ ok: false, reason: 'username_needs_index', wrote: false });
    expect(search.raw).toBe('');
    expect(acct.raw).toBe('');
    expect(pw.raw).toBe('');
  });

  /** 评审构造的 weak2.html：搜索框排在密码框之前，真正的学号框排在它之后。 */
  it('无 form 页上无关框恰好排在密码框之前，也照样拒（这正是被实测选错的那张页）', () => {
    const search = new FakeInput({ attrs: { id: 'search', placeholder: '站内搜索' } });
    const pw = new FakeInput({ type: 'password' });
    const acct = new FakeInput({ attrs: { id: 'acct', placeholder: '学号' } });
    const { run } = stage([search, pw, acct]);
    expect(run(REQ()).reason).toBe('username_needs_index');
    expect(search.raw).toBe('');
    expect(pw.raw).toBe('');
  });

  /**
   * 模型指的那一支**保留**这条边界（`form` 都为 null 也算「同一个」）：那里有模型的
   * 显式选择兜底，而结构规则那一支是我们自己在猜。两支的判据不同是刻意的。
   */
  it('无 form 页上模型用 usernameIndex 指了就填得成', () => {
    const acct = new FakeInput({ attrs: { id: 'acct' } });
    const pw = new FakeInput({ type: 'password' });
    const { run } = stage([acct, pw], { ids: [[acct, 7]] });
    const r = run(REQ({ usernameNodeId: 7 }));
    expect(r.ok).toBe(true);
    expect(r.source).toBe('model');
    expect(acct.raw).toBe('u2100011000');
    expect(pw.raw).toBe('p@ss');
  });
});

// ── shadow DOM ──────────────────────────────────────────────────────────────

describe('穿透 open shadow root', () => {
  it('组件库把登录框包在 shadow 里也找得到', () => {
    const user = new FakeInput({ attrs: { name: 'u' } });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const host = new FakeEl('DIV');
    host.shadowRoot = new FakeRoot([user, pw]);
    const { run } = stage([host]);
    expect(run(REQ()).ok).toBe(true);
    expect(pw.raw).toBe('p@ss');
  });
});

// ── 写值：原型上的原生 setter ───────────────────────────────────────────────

/**
 * **这一组守的是 React 受控组件那条路。**
 *
 * 实测（2026-09-09，真 Chromium + React 18.3.1 UMD，受控 input）：直接写
 * `el.value` 时 `onChange` **一次都不触发**、React state 停在原值 —— 站点用
 * state 去发登录请求（SPA 登录页的常态）就等于发了一个空账号。走原型上的原生
 * setter 再派发 `input` 才两种提交方式都对。
 *
 * 替身把这件事做成结构性的：实例上盖一个**吃掉写入**的 setter，只有真的走了
 * 原型那个 setter，值才落得下去。把实现改回 `el.value = v` 这一组会红。
 */
describe('写值走原型上的原生 setter，不走实例上那个', () => {
  const reactified = (el: FakeInput) => {
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () => el.raw,
      set: () => { el.swallowed += 1; },
    });
    return el;
  };

  it('实例上盖了 setter 的（React 受控）也真的写进去了', () => {
    const user = reactified(new FakeInput({ attrs: { name: 'u' } }));
    const pw = reactified(new FakeInput({ type: 'password' }));
    const form = new FakeForm(); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    const r = run(REQ());
    expect(r.ok).toBe(true);
    expect(user.raw).toBe('u2100011000');
    expect(pw.raw).toBe('p@ss');
    // 一次都不该经过实例上那个「吃掉写入」的 setter。
    expect(user.swallowed).toBe(0);
    expect(pw.swallowed).toBe(0);
  });

  it('每个框都先对焦、再派发冒泡的 input 与 change', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const { run, events } = stage([user, pw]);
    run(REQ());
    expect(user.focusCalls).toBe(1);
    expect(pw.focusCalls).toBe(1);
    expect(user.events).toEqual(['input', 'change']);
    expect(pw.events).toEqual(['input', 'change']);
    // 冒泡是硬要求：React / Vue 的监听器挂在根容器上，不冒泡就一个都收不到。
    expect(events.every((e) => e.bubbles)).toBe(true);
  });

  /** 站点把账号框设成 readonly、或有脚本盯着改回去 —— 唯一看得出来的地方就是回读。 */
  it('账号回读对不上 → write_rejected，且 wrote 为 true（页面已经被写过，不可回滚）', () => {
    const user = new FakeInput();
    Object.defineProperty(user, 'value', { configurable: true, get: () => '', set: () => {} });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    // 原型 setter 照常写进 _v，但实例上的 getter 恒回空串 —— 演的是「站点当场改回去了」。
    const { run } = stage([user, pw]);
    expect(run(REQ())).toEqual({ ok: false, reason: 'write_rejected', wrote: true });
  });
});

// ── 提交 ────────────────────────────────────────────────────────────────────

describe('提交：探路排在写值之前，两者都没有就明确报错', () => {
  it('submit 不给就只填不提交', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(submitButton()); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    const r = run(REQ({ submit: false }));
    expect(r.submitted).toBe(false);
    expect(r.submitHow).toBe(null);
    expect(form.submits).toEqual([]);
    expect(pw.raw).toBe('p@ss');
  });

  /**
   * `requestSubmit(btn)` 而不是 `requestSubmit()`：带上 submitter 才会把提交按钮
   * 自己的 name/value 放进表单数据。Shibboleth 一族的 IdP 靠它传 `_eventId_proceed`
   * 这类字段 —— 漏了它，表单发出去了而 IdP 认为什么都没提交。
   */
  it('有提交按钮时把它当 submitter 传给 requestSubmit', () => {
    const btn = submitButton();
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(btn); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    const r = run(REQ({ submit: true }));
    expect(r.submitted).toBe(true);
    expect(r.submitHow).toBe('requestSubmit');
    expect(form.submits).toEqual([btn]);
    expect(btn.clicks).toBe(0);
  });

  it('没有提交按钮时也照样 requestSubmit（不带 submitter）', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(null); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    expect(run(REQ({ submit: true })).submitted).toBe(true);
    expect(form.submits).toEqual([null]);
  });

  it('没有 requestSubmit 时退回点提交按钮', () => {
    const btn = submitButton();
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(btn, { hasRequestSubmit: false }); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    const r = run(REQ({ submit: true }));
    expect(r.submitHow).toBe('click');
    expect(btn.clicks).toBe(1);
  });

  /**
   * **探路必须排在写值之前。** 排在后面的话，页面上会留下一份填好的凭据而这一步
   * 报的是失败 —— 那正是「已经生效之后再报错」（网页不可回滚）。
   */
  it('两者都没有 → no_submit，且一个字都没写', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(null, { hasRequestSubmit: false }); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    expect(run(REQ({ submit: true }))).toEqual({ ok: false, reason: 'no_submit', wrote: false });
    expect(user.raw).toBe('');
    expect(pw.raw).toBe('');
  });

  /**
   * 用模型指的那一支来考它：无 form 页上结构规则更早就拒了
   * （`username_needs_index`，见上面那组），到不了这道提交探路。
   */
  it('密码框不在任何 form 里而又要提交 → no_form，且一个字都没写', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const { run } = stage([user, pw], { ids: [[user, 9]] });
    expect(run(REQ({ submit: true, usernameNodeId: 9 })))
      .toEqual({ ok: false, reason: 'no_form', wrote: false });
    expect(user.raw).toBe('');
    expect(pw.raw).toBe('');
  });

  it('提交这一下抛了 → submit_failed，且 wrote 为 true（凭据已经在页面上了）', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(null, { throwOnSubmit: true }); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    const r = run(REQ({ submit: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('submit_failed');
    expect(r.wrote).toBe(true);
    expect(pw.raw).toBe('p@ss');
    // **页面抛的那句话不进回执。** 这是「写值之后才读页面」的第二处（第一处是
    // `field`）：此刻密码已经在页面的 DOM 里，err.message 是页面影响得到的字符串。
    expect(r.detail).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('表单校验没过');
  });
});

// ── 回显 ────────────────────────────────────────────────────────────────────

describe('回显只回属性，绝不回值', () => {
  it('field 里有 tag / id / name / placeholder，没有账号本身', () => {
    const user = new FakeInput({ attrs: { id: 'un', name: 'userName', placeholder: '学号' } });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    const field = String(run(REQ()).field);
    expect(field).toContain('input');
    expect(field).toContain('#un');
    expect(field).toContain('[name=userName]');
    expect(field).toContain('学号');
    expect(field).not.toContain('u2100011000');
  });

  it('整份返回值里一个字都没有密码', () => {
    const user = new FakeInput(); const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    expect(JSON.stringify(run(REQ({ password: 'SECRET-PW' })))).not.toContain('SECRET-PW');
  });

  /**
   * **回显必须在写值之前算出来。**
   *
   * `put()` 里的 `fire(el, 'input')` 会**同步**跑页面自己的监听器，而那一刻密码已经
   * 在页面的 DOM 里。一个被 XSS 或本身敌意的登录页只要在密码框的 input 监听器里把
   * `this.value` 抄进账号框的 `placeholder` / `name`，写完再读 `desc()` 就把密码原样
   * 抄进回执 → 工具结果 → 模型上下文 → transcript。评审 2026-09-09 用真 Chromium
   * 实测拿到了哨兵密码（3/3），这是本批第一条硬约束「密码永不进模型上下文」上的
   * 一条真实的路。
   */
  it('页面在密码框的 input 事件里把密码抄进账号框的属性 —— 回执里也不许出现它', () => {
    const user = new FakeInput({ attrs: { id: 'u', name: 'user', placeholder: '学号' } });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const record = pw.dispatchEvent.bind(pw);
    pw.dispatchEvent = (e: { type: string }): void => {
      record(e);
      // 页面的监听器（同步跑在 fire() 里）：把刚拿到的密码抄进账号框的属性。
      if (e.type === 'input') { user.attrs.placeholder = pw.raw; user.attrs.name = `X${pw.raw}`; }
    };
    const { run } = stage([user, pw]);
    const r = run(REQ({ password: 'SENTINEL-PW-9f3a7c' }));
    expect(r.ok).toBe(true);
    // 这一条守的是「这个场景真的发生了」—— 页面确实改到了那两个属性。
    expect(user.getAttribute('placeholder')).toBe('SENTINEL-PW-9f3a7c');
    expect(user.getAttribute('name')).toBe('XSENTINEL-PW-9f3a7c');
    // 而回执说的是**写之前**挑中的那个框：页面事后改成什么与它无关。
    expect(r.field).toBe('input#u[name=user]（提示文字：学号）');
    expect(JSON.stringify(r)).not.toContain('SENTINEL-PW-9f3a7c');
  });

  /**
   * 属性是页面文本，进的是模型上下文 —— 与 walker 的 `MAX_TEXT` 同一件事，
   * 所以同一个上限（160）、同一个截断记号，不静默（spec §5.5）。
   */
  it('超长属性截断并带记号（原长写出来）', () => {
    const long = 'n'.repeat(400);
    const user = new FakeInput({ attrs: { name: long } });
    const pw = new FakeInput({ type: 'password' });
    const form = new FakeForm(); user.form = form; pw.form = form;
    const { run } = stage([user, pw]);
    const field = String(run(REQ()).field);
    expect(field).toContain('…[截断，原长 400 字符]');
    expect(field).not.toContain(long);
    expect(field.length).toBeLessThan(long.length);
  });
});
