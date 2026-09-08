import { describe, it, expect } from 'vitest';
import {
  parseFieldSpec, compileExtractPlan, extractExpression, describeExtractResult,
  createBatchBudget, describeCollected, fieldTruncatedMark,
  MAX_FIELDS, MAX_ROWS, MAX_FIELD_CHARS, MAX_BATCH_CHARS,
  type ExtractPlan, type ExtractResult, type ExtractRow,
} from './extract';
import { KydogError } from '../../shared/errors';

describe('parseFieldSpec：@attr 后缀取属性而不是文本', () => {
  it('不带后缀取文本', () => {
    expect(parseFieldSpec('h3.gs_rt a')).toEqual({ selector: 'h3.gs_rt a', attr: null });
  });

  it('带 @href / @src 取属性', () => {
    expect(parseFieldSpec('div.gs_ggs .gs_or_ggsm a@href')).toEqual({ selector: 'div.gs_ggs .gs_or_ggsm a', attr: 'href' });
    expect(parseFieldSpec('img@src')).toEqual({ selector: 'img', attr: 'src' });
  });

  // 属性名必须长得像属性名，否则一个手滑的 "a@" 会静默变成「取一个空属性」。
  it('属性名为空或含非法字符 → 报错，不静默当成取文本', () => {
    for (const s of ['a@', 'a@ ', 'a@he f', 'a@2href']) {
      expect(() => parseFieldSpec(s), s).toThrow(KydogError);
    }
  });

  // 「CSS 选择器里不会出现 @」是错的：属性选择器的字符串字面量里 @ 完全合法。
  // 但按最后一个 @ 切依然 fail-closed —— 显式写出取属性后缀的切得对，
  // 没写后缀的当场报错，不会静默变成别的意思。
  it('选择器里含 @：写出取属性后缀切得对，不写后缀则报错而不是静默', () => {
    expect(parseFieldSpec('a[title="a@b"]@href')).toEqual({ selector: 'a[title="a@b"]', attr: 'href' });
    expect(() => parseFieldSpec('a[href*="@"]')).toThrow(KydogError);
  });

  // @ 两侧的空格容忍掉：CSS 选择器不可能以 @ 结尾，所以 "a@ href" 只可能是
  // 「在 a 上取 href」，意图无歧义。这里宽松没有风险，卡住它只是刁难。
  it('@ 两侧的空格被容忍', () => {
    expect(parseFieldSpec('a@ href')).toEqual({ selector: 'a', attr: 'href' });
    expect(parseFieldSpec('  a.pdf @href  ')).toEqual({ selector: 'a.pdf', attr: 'href' });
  });

  it('选择器为空 → 报错', () => {
    for (const s of ['', '   ', '@href']) expect(() => parseFieldSpec(s), s).toThrow(KydogError);
  });

  it('data-* 这类带连字符的属性名可用', () => {
    expect(parseFieldSpec('div@data-doi')).toEqual({ selector: 'div', attr: 'data-doi' });
  });
});

describe('compileExtractPlan', () => {
  it('item 是条目容器，其余字段在条目内相对查找', () => {
    const plan = compileExtractPlan({
      item: 'div.paper-wrap.result',
      title: 'h3.paper-title a',
      detail: 'h3.paper-title a@href',
    });
    expect(plan.item).toBe('div.paper-wrap.result');
    expect(plan.fields).toEqual([
      { name: 'title', selector: 'h3.paper-title a', attr: null },
      { name: 'detail', selector: 'h3.paper-title a', attr: 'href' },
    ]);
  });

  // 没有 item 就没有「一条」的概念，抽出来的东西没法对齐成行。
  it('缺 item → 报错', () => {
    expect(() => compileExtractPlan({ title: 'h3' })).toThrow(KydogError);
  });

  it('只有 item 也成立 —— 只数条数 / 取整条文本', () => {
    expect(compileExtractPlan({ item: '.r' }).fields).toEqual([]);
  });

  it('字段数超上限被拒', () => {
    const many: Record<string, string> = { item: '.r' };
    for (let i = 0; i < MAX_FIELDS + 1; i++) many[`f${i}`] = `.f${i}`;
    expect(() => compileExtractPlan(many)).toThrow(KydogError);
  });

  it('非字符串的选择器被拒，而不是被 String() 掉', () => {
    expect(() => compileExtractPlan({ item: '.r', bad: 42 as never })).toThrow(KydogError);
  });

  // item 不过形状检查的话，"div.result@href" 会一路走到页面里，
  // 模型收到的是一句 DOMException，于是它去怀疑页面结构而不是自己的写法。
  it('item 带 @ 后缀 → 当场报错，而不是丢给 querySelectorAll 抛 DOMException', () => {
    expect(() => compileExtractPlan({ item: 'div.result@href' })).toThrow(KydogError);
    expect(() => compileExtractPlan({ item: 'div.result@href' })).toThrow(/item/);
  });

  // row["__proto__"] = "https://…" 对字符串值是 no-op：整整一列静默消失，
  // 而模型据此得出「这个页面没有链接」。
  it('与对象原型冲突的字段名被拒，而不是让那一列静默消失', () => {
    const spec = JSON.parse('{"item":".r","__proto__":"a@href"}') as Record<string, string>;
    expect(() => compileExtractPlan(spec)).toThrow(KydogError);
  });

  // 补充判据，不是主防线（主防线在页面表达式里，见下一个 describe）。
  // 它只负责把明写的那种写法挡出一句说得清的错。
  it('选择器里明写 [type=password] → 当场报错', () => {
    expect(() => compileExtractPlan({ item: 'form', p: 'input[type=password]@value' })).toThrow(KydogError);
    expect(() => compileExtractPlan({ item: 'form', p: "input[ type = 'password' ]@value" })).toThrow(KydogError);
  });

  // CSS 的大小写标志（`i` / `s`）写在 `]` 前面。漏了它只是少一句说得清的错
  // （页面层判据照样把值变成 null），但既然这层的职责就是「话说清楚」，就别留半句。
  it('带 CSS 大小写标志的 [type="password" i] / [type=password s] 也当场报错', () => {
    for (const s of ['input[type="password" i]@value', "input[type='password' i]@value",
      'input[type=password i]@value', 'input[type=password s]@value']) {
      expect(() => compileExtractPlan({ item: 'form', p: s }), s).toThrow(KydogError);
    }
  });
});

// ── 页面表达式：用一份最小 DOM 替身把生成的代码真的跑一遍 ────────────────────
//
// extractExpression 产出的是一段在页面里执行的源码。断言它的**行为**，不是它长什么样。
// 替身不做真正的 CSS 匹配（那是浏览器的事）：每个元素按「选择器字符串 → 元素」登记。
// 这正好对应本批的判据 —— 要考的是**拿到元素之后**怎么处置，与选择器怎么写无关。

class FakeEl {
  constructor(
    readonly attrs: Record<string, string> = {},
    readonly innerText = '',
    readonly kids: Record<string, FakeEl> = {},
  ) {}

  querySelector(sel: string): FakeEl | null {
    return Object.prototype.hasOwnProperty.call(this.kids, sel) ? this.kids[sel] : null;
  }

  // HTML 文档里 getAttribute 会把 qualifiedName ASCII 小写化（DOM §4.9）——
  // 替身照这个语义来，否则 `@VALUE` 这类大小写变形在替身里会「碰巧」读不到，
  // 用例就成了摆设（它要考的正是判据有没有跟着归一）。
  getAttribute(name: string): string | null {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }
}

/**
 * 替身里的 <input>。`type` 与 `hidden` 都是 IDL 属性，与判据用的是同一个：
 * `type` 已经被浏览器归一（`TYPE="HIDDEN"` → `'hidden'`、未知 type → `'text'`），
 * `hidden` 是全局 `hidden` 内容属性的 IDL 映射（`<input hidden>` → true）。
 */
class FakeInput extends FakeEl {
  constructor(
    readonly type: string,
    attrs: Record<string, string> = {},
    innerText = '',
    readonly hidden: boolean | string = false,
  ) {
    super(attrs, innerText);
  }
}

function runExpression(plan: ExtractPlan, items: FakeEl[]): ExtractResult {
  const doc = { querySelectorAll: () => items };
  const build = new Function(
    'document', 'HTMLInputElement', `return (${extractExpression(plan)});`,
  ) as (d: unknown, i: unknown) => ExtractResult;
  return build(doc, FakeInput);
}

/** 一条结果：容器里挂着若干按选择器登记的子元素。 */
const row = (kids: Record<string, FakeEl>) => new FakeEl({}, '', kids);

describe('页面表达式 · 密码卫生：判据落在拿到真实元素的那一刻', () => {
  // 这条是本批的核心：选择器里没有半个 password 字样，编译层无从判断，
  // 而页面层照样拒绝。反过来说 —— 只要判据还留在选择器文本上，这条必红。
  it('密码框的 @value 取不到，哪怕选择器完全看不出它是密码框', () => {
    const pw = new FakeInput('password', { value: 'hunter2', name: 'j_password' });
    const plan = compileExtractPlan({ item: 'form', p: 'form > *:nth-child(3)@value' });
    const r = runExpression(plan, [row({ 'form > *:nth-child(3)': pw })]);
    expect(r.rows).toEqual([{ p: null }]);
  });

  // SAML HTTP-POST 绑定那一步，IdP 渲染的就是一个 hidden input，
  // getAttribute('value') 一字不差拿得到这份 bearer 断言。
  it('hidden input 的 @value 取不到 —— SAML 断言与 CSRF token 走的正是这条', () => {
    const plan = compileExtractPlan({
      item: 'form',
      saml: 'input[name=SAMLResponse]@value',
      rs: 'input[name=RelayState]@value',
      csrf: 'input[name=csrf_token]@value',
    });
    const r = runExpression(plan, [row({
      'input[name=SAMLResponse]': new FakeInput('hidden', { value: '<签名断言>' }),
      'input[name=RelayState]': new FakeInput('hidden', { value: 'ss:mem:abc' }),
      'input[name=csrf_token]': new FakeInput('hidden', { value: 'tok-123' }),
    })]);
    expect(r.rows).toEqual([{ saml: null, rs: null, csrf: null }]);
  });

  // 属性名大小写：HTML 文档里 `getAttribute` 会把名字 ASCII 小写化（DOM §4.9），
  // 所以 `@VALUE` 与 `@value` 在页面上是同一件事 —— 判据必须跟着归一，
  // 否则末尾多按一次 Shift 就把整条闸绕过去了，SAML 断言原样进模型上下文。
  it('hidden input 的 @VALUE / @Value（大小写变形）同样取不到', () => {
    const plan = compileExtractPlan({
      item: 'form',
      saml: 'input[name=SAMLResponse]@VALUE',
      rs: 'input[name=RelayState]@Value',
      csrf: 'input[name=csrf_token]@vAlUe',
    });
    const r = runExpression(plan, [row({
      'input[name=SAMLResponse]': new FakeInput('hidden', { value: '<签名断言>' }),
      'input[name=RelayState]': new FakeInput('hidden', { value: 'ss:mem:abc' }),
      'input[name=csrf_token]': new FakeInput('hidden', { value: 'tok-123' }),
    })]);
    expect(r.rows).toEqual([{ saml: null, rs: null, csrf: null }]);
  });

  // `<input hidden name=csrf_token value=…>` 的 IDL `type` 是 'text'，看 type 看不出来。
  // 判据要看 `hidden` 这个 IDL 属性本身 —— 同样是协议层事实，不是「名字像 token」。
  it('带全局 hidden 属性的 input（type 仍是 text）的 @value 也取不到', () => {
    const plan = compileExtractPlan({ item: 'form', t: 'input[name=csrf_token]@value' });
    const el = new FakeInput('text', { value: 'S3', name: 'csrf_token' }, '', true);
    const r = runExpression(plan, [row({ 'input[name=csrf_token]': el })]);
    expect(r.rows).toEqual([{ t: null }]);
  });

  it('普通 input 的 @value 正常 —— 这条守的是别把闸修成一刀切', () => {
    const plan = compileExtractPlan({ item: 'form', q: 'input.q@value' });
    const r = runExpression(plan, [row({ 'input.q': new FakeInput('text', { value: '量子计算' }) })]);
    expect(r.rows).toEqual([{ q: '量子计算' }]);
  });

  // 归一大小写只该放宽拦截，不该顺手把正常读法也拦了。
  it('普通 input 的 @VALUE（大写）照样读得到 —— 归一只收紧 hidden，不误伤', () => {
    const plan = compileExtractPlan({ item: 'form', q: 'input.q@VALUE' });
    const r = runExpression(plan, [row({ 'input.q': new FakeInput('text', { value: '量子计算' }) })]);
    expect(r.rows).toEqual([{ q: '量子计算' }]);
  });

  it('七种常见 input type 的 @value 全部正常，未知 type 归一成 text 也正常', () => {
    for (const t of ['text', 'search', 'email', 'number', 'url', 'date', '']) {
      const plan = compileExtractPlan({ item: 'form', q: 'input.q@value' });
      const r = runExpression(plan, [row({ 'input.q': new FakeInput(t, { value: `v-${t}` }) })]);
      expect(r.rows, `type=${JSON.stringify(t)}`).toEqual([{ q: `v-${t}` }]);
    }
  });

  it('非 input 元素的 @value 正常（<option value> 这类）', () => {
    const plan = compileExtractPlan({ item: 'select', y: 'option[selected]@value' });
    const r = runExpression(plan, [row({ 'option[selected]': new FakeEl({ value: '2024' }) })]);
    expect(r.rows).toEqual([{ y: '2024' }]);
  });

  // 决策：密码框上**一个属性都不读**（fail-closed），理由写在实现的注释里。
  it('密码框上取别的属性（@name）也一律 null', () => {
    const plan = compileExtractPlan({ item: 'form', n: 'input.pw@name' });
    const r = runExpression(plan, [row({ 'input.pw': new FakeInput('password', { name: 'j_password' }) })]);
    expect(r.rows).toEqual([{ n: null }]);
  });

  it('密码框取文本也是 null，不是空串', () => {
    const plan = compileExtractPlan({ item: 'form', t: 'input.pw' });
    const r = runExpression(plan, [row({ 'input.pw': new FakeInput('password', { value: 'x' }, '不该出现') })]);
    expect(r.rows).toEqual([{ t: null }]);
  });

  it('拿不到元素时是 null，不是整条抛', () => {
    const plan = compileExtractPlan({ item: '.r', a: '.missing', b: '.missing@href' });
    const r = runExpression(plan, [row({})]);
    expect(r.rows).toEqual([{ a: null, b: null }]);
  });
});

describe('页面表达式 · 行数上限只有一份，且截断显式回报', () => {
  const manyRows = (n: number) => Array.from({ length: n }, (_, i) => row({ h3: new FakeEl({}, `第 ${i} 条`) }));

  // 50 是硬写的，不是从 MAX_ROWS 算出来的 —— 常量改成别的值，这条必须跟着红。
  // 上一版那条「MAX_ROWS 是正整数」改成 1_000_000 都绿，正是这条要替掉的东西。
  it('页面 53 条、上限 50 → 返回 50 条，并回报 truncated / returned / totalKnown', () => {
    const plan = compileExtractPlan({ item: '.r', title: 'h3' });
    const r = runExpression(plan, manyRows(53));
    expect(r.rows).toHaveLength(50);
    expect(r.rows[49].title).toBe('第 49 条');
    expect(r.rowTruncation).toEqual({ truncated: true, returned: 50, totalKnown: 53 });
  });

  it('没超上限 → truncated 为假，returned 与 totalKnown 相等', () => {
    const plan = compileExtractPlan({ item: '.r', title: 'h3' });
    const r = runExpression(plan, manyRows(7));
    expect(r.rows).toHaveLength(7);
    expect(r.rowTruncation).toEqual({ truncated: false, returned: 7, totalKnown: 7 });
  });

  it('MAX_ROWS 就是 50 —— 上面那条用例把这个数字硬写死了，改常量要一起改', () => {
    expect(MAX_ROWS).toBe(50);
  });
});

describe('页面表达式 · 单字段长度上限', () => {
  // 「丢了 5 个字符」和「丢了 50 万个」在模型眼里必须长得不一样，否则它没法判断
  // 该不该把选择器收窄再抽一次。原长在 clip 里就是 v.length，页面上真数得出来。
  it('超长文本被截断、记号里带上原长，列名进 fieldTruncation.columns', () => {
    const plan = compileExtractPlan({ item: 'body', abs: 'div' });
    const r = runExpression(plan, [row({ div: new FakeEl({}, 'x'.repeat(1500)) })]);
    expect(r.rows[0].abs).toBe('x'.repeat(1000) + fieldTruncatedMark(1500));
    expect(r.rows[0].abs).toContain('1500');
    expect(r.fieldTruncation).toEqual({ truncated: true, limit: 1000, columns: ['abs'], maxOriginal: 1500 });
  });

  // 一个被截断的 href 就是一个打不开的链接 —— 那必须逐格看得见，不能只有汇总。
  it('属性值同样受限，截断后末尾带记号与原长', () => {
    const plan = compileExtractPlan({ item: '.r', pdf: 'a@href' });
    const long = 'https://example.org/?q=' + 'y'.repeat(2000);
    const r = runExpression(plan, [row({ a: new FakeEl({ href: long }) })]);
    expect(r.rows[0].pdf).toBe(long.slice(0, 1000) + fieldTruncatedMark(long.length));
    expect(r.fieldTruncation.columns).toEqual(['pdf']);
    expect(r.fieldTruncation.maxOriginal).toBe(long.length);
  });

  it('多格被截时 maxOriginal 取最大的那一格原长', () => {
    const plan = compileExtractPlan({ item: '.r', a: 'p.a', b: 'p.b' });
    const r = runExpression(plan, [row({
      'p.a': new FakeEl({}, 'x'.repeat(1200)),
      'p.b': new FakeEl({}, 'y'.repeat(9000)),
    })]);
    expect(r.fieldTruncation.columns).toEqual(['a', 'b']);
    expect(r.fieldTruncation.maxOriginal).toBe(9000);
  });

  it('没超上限的字段一个字符都不动，也不编一个 maxOriginal 出来', () => {
    const plan = compileExtractPlan({ item: '.r', title: 'h3' });
    const r = runExpression(plan, [row({ h3: new FakeEl({}, '一个正常长度的标题') })]);
    expect(r.rows[0].title).toBe('一个正常长度的标题');
    expect(r.fieldTruncation).toEqual({ truncated: false, limit: 1000, columns: [] });
    expect(Object.prototype.hasOwnProperty.call(r.fieldTruncation, 'maxOriginal')).toBe(false);
  });

  it('MAX_FIELD_CHARS 就是 1000 —— 上面几条把这个数字硬写死了', () => {
    expect(MAX_FIELD_CHARS).toBe(1000);
  });
});

// ── 整批字符预算 ────────────────────────────────────────────────────────────
//
// 单字段上限管一格、行数上限管一次 extract，而 browser_act 一批允许 60 个动作
// （repeat 10 轮），`collected` 跨步骤累加后一把 JSON.stringify 进工具结果：
// 10 × 50 行 × 16 字段 × 1000 字符 = 800 万字符，平铺 60 步是 4800 万。
// 预算跨步骤累计，超了按行截断并如实回报 —— 已经抽到的仍然返回。

describe('整批字符预算：跨步骤累计，超了按行截断并回报', () => {
  const cell = (n: number) => ({ a: 'x'.repeat(n) });
  const many = (count: number, n: number): ExtractRow[] => Array.from({ length: count }, () => cell(n));

  it('预算内的行全收，报告说没截断', () => {
    const budget = createBatchBudget(1000);
    const out: ExtractRow[] = [];
    expect(budget.admit(many(3, 10), out)).toBe(3);
    expect(out).toHaveLength(3);
    expect(budget.report()).toEqual({ truncated: false, returned: 3, totalKnown: 3, limit: 1000 });
  });

  it('跨步骤累计：前几步吃掉预算，后面的步骤一行都收不进来', () => {
    const budget = createBatchBudget(1000);
    const out: ExtractRow[] = [];
    // 每行 JSON 是 {"a":"<n 个 x>"}，长度 8+n，再加 1 个分隔符 → n=100 时 109。
    expect(budget.admit(many(5, 100), out)).toBe(5); // 545
    expect(budget.admit(many(10, 100), out)).toBe(4); // 到 981，第 5 行会到 1090 > 1000
    expect(budget.admit(many(3, 100), out)).toBe(0); // 预算已尽，后面的步骤全丢
    expect(out).toHaveLength(9);
    expect(budget.report()).toEqual({ truncated: true, returned: 9, totalKnown: 18, limit: 1000 });
  });

  it('已经抽到的数据仍然返回 —— 截断只砍尾巴，不砍前面的行', () => {
    const budget = createBatchBudget(1000);
    const out: ExtractRow[] = [];
    budget.admit([{ a: '第一条' }, ...many(20, 200)], out);
    expect(out[0]).toEqual({ a: '第一条' });
    expect(out.length).toBeGreaterThan(1);
  });

  // 5 万是硬写的：常量改大改小这条都得跟着红。
  // 每行 JSON 长 1006（8 + 998），加分隔符 1007 → 49×1007=49343 收得下，50×1007=50350 收不下。
  it('默认预算下：1006 字符一行的行，收到第 49 行为止', () => {
    const budget = createBatchBudget();
    const out: ExtractRow[] = [];
    expect(budget.admit(many(200, 998), out)).toBe(49);
    expect(budget.report()).toEqual({ truncated: true, returned: 49, totalKnown: 200, limit: MAX_BATCH_CHARS });
  });

  it('MAX_BATCH_CHARS 就是 50000 —— 上面那条把这个数字硬写死了', () => {
    expect(MAX_BATCH_CHARS).toBe(50_000);
  });

  it('describeCollected：没截断时和从前一模一样，一个字都不提预算', () => {
    expect(describeCollected({ truncated: false, returned: 7, totalKnown: 7, limit: MAX_BATCH_CHARS }))
      .toBe('抽到 7 条：');
  });

  it('describeCollected：截断时报出抽到多少、收进多少、预算是多少', () => {
    const line = describeCollected({ truncated: true, returned: 49, totalKnown: 200, limit: 50_000 });
    expect(line).toContain('49');
    expect(line).toContain('200');
    expect(line).toContain('50000');
    expect(line).toContain('截断');
  });
});

describe('describeExtractResult：截断说人话，不让模型把上限当成源的总量', () => {
  const base: ExtractResult = {
    rows: [],
    rowTruncation: { truncated: false, returned: 0, totalKnown: 0 },
    fieldTruncation: { truncated: false, limit: MAX_FIELD_CHARS, columns: [] },
  };

  it('截断时报出页面总数与实际返回数', () => {
    const line = describeExtractResult({
      ...base,
      rows: Array.from({ length: 50 }, () => ({})),
      rowTruncation: { truncated: true, returned: 50, totalKnown: 83 },
    });
    expect(line).toContain('83');
    expect(line).toContain('50');
    expect(line).toContain('截断');
  });

  it('没截断时一个字都不提截断', () => {
    const line = describeExtractResult({ ...base, rows: [{}, {}], rowTruncation: { truncated: false, returned: 2, totalKnown: 2 } });
    expect(line).toBe('抽到 2 条');
  });

  it('字段被截断时点名是哪一列，并说出最长那一格本应多长', () => {
    const line = describeExtractResult({
      ...base,
      rows: [{}],
      rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
      fieldTruncation: { truncated: true, limit: MAX_FIELD_CHARS, columns: ['abs'], maxOriginal: 523400 },
    });
    expect(line).toContain('abs');
    expect(line).toContain('523400');
  });

  // 这一步抽到了 50 条、但整批预算只收得下 12 条时，模型必须知道另外 38 条去哪了。
  it('被整批预算丢掉的行数说出口', () => {
    const line = describeExtractResult({
      ...base,
      rows: Array.from({ length: 50 }, () => ({})),
      rowTruncation: { truncated: false, returned: 50, totalKnown: 50 },
    }, 38);
    expect(line).toContain('38');
    expect(line).toContain('预算');
  });

  it('没被预算丢掉行时一个字都不提预算', () => {
    const line = describeExtractResult({ ...base, rows: [{}], rowTruncation: { truncated: false, returned: 1, totalKnown: 1 } }, 0);
    expect(line).toBe('抽到 1 条');
  });
});
