/**
 * 把一份 TS/JS 源码里的注释去掉，其余原样保留。**只给用例里的源码扫描器用。**
 *
 * 为什么必须有这一步：仓里到处是形如「Task 8 要补
 * `broadcaster.emit('browser.agentFocus', …)`」的说明性注释，也到处是
 * 「不许自己去挂 `session.webRequest`」这种把被禁的写法**原样引在注释里**的约定。
 * 不去掉注释的话，一句注释就能把「零调用点」伪装成「已经有人调了」，或者反过来
 * 把「只有一处」数成两处 —— 两个方向都是假的结论。
 *
 * 逐字符走一遍，认得字符串 / 模板串以外的 `//` 与 `/* *\/`。
 * **宁可少认，不可多认**：把代码当注释吃掉只会让扫描器少扫到东西（调用方的断言
 * 那时会红，是安全方向）；多认才是假绿。
 *
 * 已知边界，如实登记：正则字面量里的 `/` 不认（`/a\/\/b/` 会被当成注释开头）。
 * 现有的两个调用方扫的都是不含正则字面量的源码，且失败方向是「少扫到 → 红」。
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
