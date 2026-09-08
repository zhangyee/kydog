import { describe, it, expect } from 'vitest';
import {
  parseFieldSpec, compileExtractPlan, extractExpression, describeExtractResult,
  MAX_FIELDS, MAX_ROWS, MAX_FIELD_CHARS, FIELD_TRUNCATED_MARK,
  type ExtractPlan, type ExtractResult,
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

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
}

/** 替身里的 <input>。`type` 就是 HTMLInputElement 的 IDL 属性，与判据用的是同一个。 */
class FakeInput extends FakeEl {
  constructor(readonly type: string, attrs: Record<string, string> = {}, innerText = '') {
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

  it('普通 input 的 @value 正常 —— 这条守的是别把闸修成一刀切', () => {
    const plan = compileExtractPlan({ item: 'form', q: 'input.q@value' });
    const r = runExpression(plan, [row({ 'input.q': new FakeInput('text', { value: '量子计算' }) })]);
    expect(r.rows).toEqual([{ q: '量子计算' }]);
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
  it('超长文本被截断、打上记号，列名进 fieldTruncation.columns', () => {
    const plan = compileExtractPlan({ item: 'body', abs: 'div' });
    const r = runExpression(plan, [row({ div: new FakeEl({}, 'x'.repeat(1500)) })]);
    expect(r.rows[0].abs).toBe('x'.repeat(1000) + FIELD_TRUNCATED_MARK);
    expect(r.fieldTruncation).toEqual({ truncated: true, limit: 1000, columns: ['abs'] });
  });

  // 一个被截断的 href 就是一个打不开的链接 —— 那必须逐格看得见，不能只有汇总。
  it('属性值同样受限，截断后末尾带记号', () => {
    const plan = compileExtractPlan({ item: '.r', pdf: 'a@href' });
    const long = 'https://example.org/?q=' + 'y'.repeat(2000);
    const r = runExpression(plan, [row({ a: new FakeEl({ href: long }) })]);
    expect(r.rows[0].pdf).toBe(long.slice(0, 1000) + FIELD_TRUNCATED_MARK);
    expect(r.fieldTruncation.columns).toEqual(['pdf']);
  });

  it('没超上限的字段一个字符都不动', () => {
    const plan = compileExtractPlan({ item: '.r', title: 'h3' });
    const r = runExpression(plan, [row({ h3: new FakeEl({}, '一个正常长度的标题') })]);
    expect(r.rows[0].title).toBe('一个正常长度的标题');
    expect(r.fieldTruncation).toEqual({ truncated: false, limit: 1000, columns: [] });
  });

  it('MAX_FIELD_CHARS 就是 1000 —— 上面几条把这个数字硬写死了', () => {
    expect(MAX_FIELD_CHARS).toBe(1000);
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

  it('字段被截断时点名是哪一列', () => {
    const line = describeExtractResult({
      ...base,
      rows: [{}],
      rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
      fieldTruncation: { truncated: true, limit: MAX_FIELD_CHARS, columns: ['abs'] },
    });
    expect(line).toContain('abs');
    expect(line).toContain(FIELD_TRUNCATED_MARK);
  });
});
