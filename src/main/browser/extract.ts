import { KydogError } from '../../shared/errors';

/**
 * 结构化抽取：规格解析，以及生成那段**在页面里执行**的取值代码。
 *
 * 规格由 skill 的 reference 给出，形如：
 * ```jsonc
 * { "item": "div.paper-wrap.result",
 *   "title": "h3.paper-title a",
 *   "pdf":   "div.paper-source a@href" }
 * ```
 * `item` 是条目容器，其余字段**在条目内部**相对查找。
 *
 * AX 快照是 role/name 的列表，天然表达不了 href —— 而结果页的 PDF 直链与详情页
 * 链接恰恰是 href。所以 `@attr` 这个后缀不是语法糖，它是那些字段唯一的出口。
 *
 * `extractExpression` 生成的代码由 browserTools 送进 **walker 那个隔离世界**执行，
 * 不是主世界：页面覆写 `document.querySelectorAll` 骗得到主世界、骗不到隔离世界
 * （2026-09-08 spike 实测）。密码卫生与两处容量上限也都落在那段代码里 ——
 * 一个选择器到底选中了什么元素，只有拿到真实元素的那一刻才知道。
 */

export type FieldSpec = { selector: string; attr: string | null };
export type CompiledField = FieldSpec & { name: string };
export type ExtractPlan = { item: string; fields: CompiledField[] };

export type ExtractRow = Record<string, string | null>;

/**
 * 抽取结果。**截断一律显式回报**（spec §5.5）—— 静默截断会让「这个源只有 50 条」
 * 和「我只给你看了 50 条」在模型眼里长得一样。
 */
export type ExtractResult = {
  rows: ExtractRow[];
  /**
   * 行数的截断回报，字段名照 spec §5.5 的 `{ truncated, returned, totalKnown? }`。
   * `totalKnown` 是 `document.querySelectorAll(item)` 的 length —— 页面上真的数得出来，
   * 不是估的，所以这里恒有。
   */
  rowTruncation: { truncated: boolean; returned: number; totalKnown: number };
  /**
   * 单字段长度的截断回报。**这里没有 `totalKnown`**：「本应多长」只逐格存在，
   * 凑不出一个能对应它的总量，spec 也写明数不出来就不要编一个。
   * `columns` 是被截过的列名（去重）；具体是哪一格，看值末尾的 `FIELD_TRUNCATED_MARK`。
   */
  fieldTruncation: { truncated: boolean; limit: number; columns: string[] };
};

/** 容量保护，不参与语义判断。 */
export const MAX_FIELDS = 16;

/**
 * 一次 extract 最多返回多少行。**只有这一份** —— 页面表达式里的那个数由它生成，
 * 别在 browserTools 里再硬写一个（曾经有过两份，改这里零效果）。
 */
export const MAX_ROWS = 50;

/**
 * 单个字段的字符上限。
 *
 * 依据：一条检索结果的标题 / 作者 / 出处 / DOI / 摘要片段都在几百字符内，1000 留了
 * 一倍余量；而最坏情况 —— 选择器写宽成 `item: "body"` + 字段 `"div"`，每格取到整页
 * 正文 —— 也被压到 50×1000 = 5 万字符，与 `browser_read` 的 2 万字符同一个量级，
 * 不至于一次调用打爆上下文窗口。
 *
 * 注意它管的是**一格**：16 个字段全写宽仍能拼出 80 万字符。真要防那一头得再加一个
 * 总量预算，本期没做（见 task-2c 报告的顾虑一节）。
 */
export const MAX_FIELD_CHARS = 1000;

/**
 * 被截断的格子末尾带这个记号。列一级的 `fieldTruncation` 说不出「哪一格」，
 * 而一个被截断的 href 就是一个打不开的链接 —— 那必须逐格看得见。
 */
export const FIELD_TRUNCATED_MARK = '…[截断]';

const bad = (msg: string) => new KydogError('browser.bad_action', msg);

/** 属性名按 HTML 的常见形态收紧：字母开头，允许 - _ : 与数字。 */
const ATTR_RE = /^[A-Za-z][A-Za-z0-9_:-]*$/;

/**
 * 补充判据，**不是主防线**：主防线在 `extractExpression` 生成的页面代码里，
 * 那里拿得到真实元素。这里只把「明写 [type=password]」这一种挡在前面，为的是给
 * 一句说得清的错，而不是让模型收到一列 null 再去猜页面结构。
 * 绕过它太容易（`form > *:nth-child(3)@value` 一样选中密码框），所以它只管话说清楚。
 */
const PASSWORD_LITERAL_RE = /\[\s*type\s*=\s*["']?password["']?\s*\]/i;

export function parseFieldSpec(raw: string): FieldSpec {
  if (typeof raw !== 'string' || raw.trim() === '') throw bad('选择器不能为空');
  const at = raw.lastIndexOf('@');
  // 按**最后一个** @ 切。（旧注释说「CSS 选择器里不会出现 @」是错的：属性选择器的
  // 字符串字面量里 @ 完全合法，`a[title="a@b"]` 就是。）按最后一个切依然 fail-closed：
  // `a[title="a@b"]@href` 切得对；而 `a[href*="@"]` 这种不取属性的写法会因为属性名
  // 不合法当场报错，不会静默变成别的意思。
  if (at === -1) return { selector: raw.trim(), attr: null };

  const selector = raw.slice(0, at).trim();
  const attr = raw.slice(at + 1).trim();
  if (selector === '') throw bad(`选择器不能为空：${JSON.stringify(raw)}`);
  // 一个手滑的 "a@" 如果被当成「取文本」，抽出来的东西看着正常、其实少了一列，
  // 而且不报错。宁可在这里红。
  if (!ATTR_RE.test(attr)) {
    throw bad(`@ 后面要跟属性名（如 @href / @src / @data-doi），收到 ${JSON.stringify(raw)}`
      + '；选择器里如果要用 @（如 [title="a@b"]），末尾必须显式写出取属性后缀（如 …@href）');
  }
  return { selector, attr };
}

/**
 * 与 `Object.prototype` 上的 setter 撞名的字段名会被静默吞掉：
 * `row["__proto__"] = "https://…"` 对字符串值是 no-op，结果是**整整一列**消失、
 * 且没有任何错误 —— 模型据此得出「这个页面没有链接」。
 *
 * 判据取的是语言语义本身（原型上是不是一个 setter），不是维护一张名字黑名单。
 */
function assertUsableFieldName(name: string): void {
  const desc = Object.getOwnPropertyDescriptor(Object.prototype, name);
  if (desc && typeof desc.set === 'function') {
    throw bad(`字段名 ${JSON.stringify(name)} 与对象原型冲突，赋值会被静默吞掉、整列消失 —— 换一个名字`);
  }
}

function assertNoPasswordLiteral(where: string, selector: string): void {
  if (PASSWORD_LITERAL_RE.test(selector)) {
    throw new KydogError('browser.password_field',
      `${where} 指向密码框，extract 不读密码框的任何属性（spec §4.6 密码卫生）`);
  }
}

export function compileExtractPlan(selectors: Record<string, string>): ExtractPlan {
  if (!selectors || typeof selectors !== 'object') throw bad('selectors 必须是一个对象');
  const item = selectors.item;
  if (typeof item !== 'string' || item.trim() === '') {
    throw bad('selectors 必须有 item —— 它是条目容器，没有它抽出来的字段无法对齐成行');
  }
  // item 也走一次形状检查。不然 "div.result@href" 会一路走到页面里抛 DOMException，
  // 模型看到的是一句 SyntaxError，于是它去怀疑页面结构而不是自己的写法。
  const itemSpec = parseFieldSpec(item);
  if (itemSpec.attr !== null) {
    throw bad(`item 是条目容器，不能带 @ 后缀（收到 ${JSON.stringify(item)}）—— 取属性写在字段上`);
  }
  assertNoPasswordLiteral('item', itemSpec.selector);

  const entries = Object.entries(selectors).filter(([k]) => k !== 'item');
  if (entries.length > MAX_FIELDS) throw bad(`字段数 ${entries.length} 超过上限 ${MAX_FIELDS}`);

  const fields = entries.map(([name, raw]) => {
    if (typeof raw !== 'string') throw bad(`字段 ${name} 的选择器必须是字符串`);
    assertUsableFieldName(name);
    const spec = parseFieldSpec(raw);
    assertNoPasswordLiteral(`字段 ${name}`, spec.selector);
    return { name, ...spec };
  });
  return { item: itemSpec.selector, fields };
}

/**
 * 生成在页面里执行的取值代码。
 *
 * 三件事落在这里而不是解析层，理由是同一条：**选择器是模型给的字符串，它到底选中
 * 什么元素只有页面知道**。按选择器文本猜就是启发式 proxy，而且绕过方法一大把。
 *
 * 1. 密码框：`t instanceof HTMLInputElement && t.type === 'password'` → 这个字段返回
 *    null。与 walker（`injected/walker.js`）用的是同一个协议层判据。
 *    **密码框上一个属性都不读**，不只是 `@value`：`@name` / `@placeholder` 这类确实
 *    不含密码，但一期 agent 本来就不许碰密码框（`actions.ts` 挡住往里打字），放开
 *    它换不来任何用处，却要逐个属性论证「这个不会漏」。fail-closed 更便宜。
 * 2. `@value`：只在**非 hidden**的 input 上读。SAML HTTP-POST 绑定那一步 IdP 渲染的
 *    就是 `<input type="hidden" name="SAMLResponse" value="<签名断言>">`，
 *    `getAttribute('value')` 一字不差拿得到这份 bearer 断言；CSRF token 同理。
 *    非 input 元素（`<option value>` 这类）不受这条限制。
 * 3. 两处容量上限（行数、单字段长度）与它们的截断回报。
 *
 * 插值一律走 `JSON.stringify`：selector / attr / 字段名三处都是字符串字面量，
 * 字段名走 `row[<字面量>]` 计算成员访问，构造不出标识符逃逸。
 */
export function extractExpression(plan: ExtractPlan): string {
  const lit = (v: unknown) => JSON.stringify(v);
  const read = (f: CompiledField) =>
    (f.attr ? `t.getAttribute(${lit(f.attr)})` : "(t.innerText || '').trim()");

  const fields = plan.fields.map((f) => `    {
      const t = el.querySelector(${lit(f.selector)});
      row[${lit(f.name)}] = t && readable(t, ${lit(f.attr)}) ? clip(${read(f)}, ${lit(f.name)}) : null;
    }`).join('\n');

  return `(() => {
  const MAX_ROWS = ${MAX_ROWS};
  const MAX_CHARS = ${MAX_FIELD_CHARS};
  const MARK = ${lit(FIELD_TRUNCATED_MARK)};
  const columns = [];
  const readable = (t, attr) => {
    if (t instanceof HTMLInputElement && t.type === 'password') return false;
    if (attr === 'value' && t instanceof HTMLInputElement && t.type === 'hidden') return false;
    return true;
  };
  const clip = (v, name) => {
    if (typeof v !== 'string' || v.length <= MAX_CHARS) return v;
    if (columns.indexOf(name) === -1) columns.push(name);
    return v.slice(0, MAX_CHARS) + MARK;
  };
  const all = document.querySelectorAll(${lit(plan.item)});
  const rows = [];
  for (const el of all) {
    if (rows.length >= MAX_ROWS) break;
    const row = {};
${fields}
    rows.push(row);
  }
  return {
    rows: rows,
    rowTruncation: { truncated: all.length > rows.length, returned: rows.length, totalKnown: all.length },
    fieldTruncation: { truncated: columns.length > 0, limit: MAX_CHARS, columns: columns },
  };
})()`;
}

/** 给模型看的一句话。截断必须说出口 —— 不说的话「上限」和「这个源的总量」长得一样。 */
export function describeExtractResult(r: ExtractResult): string {
  let line = `抽到 ${r.rows.length} 条`;
  if (r.rowTruncation.truncated) {
    line += `（页面上共 ${r.rowTruncation.totalKnown} 条，按上限只返回前 ${r.rowTruncation.returned} 条`
      + ' —— 这是截断，不是「这个源只有这么多」）';
  }
  if (r.fieldTruncation.truncated) {
    line += `；字段 ${r.fieldTruncation.columns.join(' / ')} 超过 ${r.fieldTruncation.limit} 字符已截断`
      + `，被截的格子末尾带 ${FIELD_TRUNCATED_MARK}`;
  }
  return line;
}
