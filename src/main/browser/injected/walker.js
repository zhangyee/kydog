// 这段代码在**网页里**执行，不是主进程。它不能 import 任何东西。
//
// 写成 .js 而不是 .ts：整份源码会被 ?raw 原样注入浏览器，而浏览器跑不了 TS 语法。
// 它跑在**隔离世界**里（见 browserService 的 WORLD_ID）——
//   · 页面覆写 document.querySelectorAll 骗不到它（2026-09-08 spike 实测）
//   · 它挂在 window 上的东西页面看不见，所以发号表不会被读取或伪造
//   · 文档一换，隔离世界连同发号表一起重置，这正是「新文档 = 新身份」
//
// 改了这里的输出结构，要同步 snapshot.ts 的 AxNode 与 renderDiff 的判据，
// 并跑 snapshot.test.ts。两边漂移不会编译报错，只会让 diff 静默退化成全量。
(() => {
  const W = window;
  W.__kydogIds = W.__kydogIds || new WeakMap();
  W.__kydogNext = W.__kydogNext || 1;
  const idOf = (el) => {
    let n = W.__kydogIds.get(el);
    if (!n) { n = W.__kydogNext++; W.__kydogIds.set(el, n); }
    return n;
  };

  const MAX_NODES = 300;

  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,' +
    '[role],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const HEADINGS = 'h1,h2,h3';

  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'submit' || t === 'button' || t === 'reset') return t;
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  };

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 160);

  // 可读名字的取值顺序照无障碍那一套：aria-label → aria-labelledby → alt/title →
  // placeholder → 可见文本。不取 value —— 见下面 isPassword 那段。
  const nameOf = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute && el.getAttribute('aria-labelledby');
    if (by) {
      const parts = by.split(/\s+/).map((id) => {
        const t = document.getElementById(id);
        return t ? t.innerText || t.textContent : '';
      });
      const joined = clean(parts.join(' '));
      if (joined) return joined;
    }
    for (const attr of ['alt', 'title', 'placeholder', 'name']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) return clean(v);
    }
    return clean(el.innerText || el.textContent);
  };

  const visible = (el, r) => {
    // 折叠到看不见的元素点不到，列出来只会占位置并诱导模型去点。
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.right < 0) return false;
    const st = W.getComputedStyle(el);
    if (!st) return true;
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };

  const seen = new Set();
  const out = [];
  let index = 0;

  const collect = (el) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (out.length >= MAX_NODES) return;
    let r;
    try { r = el.getBoundingClientRect(); } catch { return; }
    if (!visible(el, r)) return;

    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    const isPassword = type === 'password';

    index += 1;
    const node = {
      index,
      nodeId: idOf(el),
      role: roleOf(el),
      name: nameOf(el),
      // 视口内的 CSS 像素。CDP 的 Input 事件就吃这个单位 ——
      // 按缩放换算过反而打不中（2026-09-08 spike 实测）。
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
    };
    // 密码框的 value 一个字都不出去：它会经工具结果进模型上下文、进 transcript。
    // 判据是元素类型这个协议层事实，不是「name 里像不像 password」。
    if (isPassword) node.isPassword = true;
    else if ('value' in el && typeof el.value === 'string' && el.value) node.value = clean(el.value);
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
    out.push(node);
  };

  const scan = (root) => {
    let els = [];
    try { els = Array.prototype.slice.call(root.querySelectorAll(INTERACTIVE + ',' + HEADINGS)); }
    catch { return; }
    for (const el of els) {
      collect(el);
      // open shadow root 里的控件在很多组件库里就是全部控件。closed 的看不见，
      // 那是这条路的已知边界（换 CDP 的 AX 树可解）。
      if (el.shadowRoot) scan(el.shadowRoot);
      if (out.length >= MAX_NODES) return;
    }
  };

  scan(document);

  return {
    url: location.href,
    title: document.title,
    nodes: out,
    total: out.length,
    truncated: out.length >= MAX_NODES,
  };
})();
