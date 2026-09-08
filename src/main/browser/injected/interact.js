// 这段代码在**网页里**执行，不是主进程。它不能 import 任何东西。
//
// 写成 .js 而不是 .ts：整份源码会被 ?raw 原样注入浏览器，而浏览器跑不了 TS 语法。
// 它跑在 walker 的**同一个隔离世界**里（browserService 的 WALKER_WORLD_ID）——
// 必须是同一个，因为 nodeId 的发号表 (`__kydogWorld.ids`) 与密码记忆
// (`__kydogWorld.pw`) 都在那里，换一个世界就等于两边各说各的。
//
// 整份源码是**一个箭头函数表达式**，调用方拼成 `(<这份源码>)(<请求 JSON>)`。
// 不走 `window.__kydogTarget` 这类全局：那要两次注入（先设全局再执行），两次之间
// 页面可以导航走，第二次跑在新文档里读到的是上一次留下的目标 —— 而且两个并发的
// 派发会互相覆盖。参数直接传进来就没有这个中间状态。
//
// ── 这里做的正是 spec §4.2「点击之前有三件事，一件都不能省」──────────────────
//  1. 滚进视野：**隔离世界里的 `element.scrollIntoView()`**，不是 CDP 的
//     `DOM.scrollIntoViewIfNeeded` —— 后者要 CDP 的节点身份，而我们的 nodeId 是
//     隔离世界 WeakMap 发的号，两者对不上。
//  2. 在派发那一刻从活节点重新量坐标（`resolveTarget` 给的那份是**快照当时**的）。
//  3. 命中检查：`elementFromPoint` 命中的必须是目标或其后代。
//
// 改了这里的返回结构，要同步 browserService.ts 的 `InteractResult` 与 `dispatch`
// 的判据，并跑 `npm test -- browserService`：这份代码在网页里执行、类型系统管不到它，
// 两边漂移不会编译报错，只会让判据静默失效。
(req) => {
  const W = window;
  const D = document;

  // 发号表与密码记忆。walker / pwRegistrar 建，这里**只读**。
  const world = W.__kydogWorld;

  // ── 密码判据：与 walker 的 isPasswordField、extract 生成的那份**逐条一致** ──
  // 四条，任一成立即算（fail-closed）。三份的漂移由 browserService.test.ts 的
  // 三方差分用例守着（同一个元素喂给三边，裁决必须相等）。
  // 常量取值也照抄，改了一处不改另两处会被那条用例抓住。
  const PW_NAME_RE = /(password|passwd|pwd)/i;
  const PW_AUTOCOMPLETE = ['current-password', 'new-password'];
  const PW_VALUE_TYPES = ['', 'text', 'password', 'search', 'tel', 'url', 'email', 'number'];
  const isPasswordField = (t) => {
    if (world && world.pw && world.pw.has(t)) return true;
    const tag = t.tagName ? String(t.tagName).toLowerCase() : '';
    if (tag !== 'input' && tag !== 'textarea') return false;
    const type = typeof t.type === 'string' ? t.type.toLowerCase() : '';
    if (type === 'password') return true;
    const holdsText = tag === 'textarea' || PW_VALUE_TYPES.indexOf(type) !== -1;
    if (!holdsText || typeof t.getAttribute !== 'function') return false;
    const tokens = (t.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    for (const a of PW_AUTOCOMPLETE) if (tokens.indexOf(a) !== -1) return true;
    return PW_NAME_RE.test(`${t.getAttribute('name') || ''} ${t.getAttribute('id') || ''}`);
  };

  // ── 目标解析 ──────────────────────────────────────────────────────────────

  /**
   * 反查发号表。**要走 open shadow root** —— walker 的 scan 递归进去发号，
   * 只查 `document.querySelectorAll('*')` 的话，组件库里那些真正的控件（号是发过的）
   * 一律反查不到，报出来是「这个编号在页面上找不到了」，而它就在页面上。
   *
   * 成本实测（Electron 41.2.1，2026-09-08）：8 万个元素的页面，物化整棵树 + 逐个
   * WeakMap.get 走到最后一个是 **4ms**。所以这里不设任何上限 —— 它不是 walker 那种
   * 每个元素都要 getComputedStyle 的活。
   */
  const findByNodeId = (root, id) => {
    let els;
    try { els = root.querySelectorAll('*'); } catch { return null; }
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (world.ids.get(el) === id) return el;
      let sr = null;
      try { sr = el.shadowRoot; } catch { sr = null; }
      if (sr) {
        const inner = findByNodeId(sr, id);
        if (inner) return inner;
      }
    }
    return null;
  };

  /** 返回 `{ el }` 或一条 `{ ok:false, reason }`。 */
  const resolve = (t) => {
    if (!t || typeof t !== 'object') return { ok: false, reason: 'not_found' };
    if (typeof t.selector === 'string') {
      let el;
      // 选择器是模型给的字符串，语法错在页面里抛 DOMException ——
      // 让它冒出去的话模型收到一句 SyntaxError，于是去怀疑页面结构而不是自己的写法。
      try { el = D.querySelector(t.selector); } catch { return { ok: false, reason: 'bad_selector' }; }
      return el ? { el } : { ok: false, reason: 'not_found' };
    }
    // 号只在**本文档**内有效。世界没了（文档换过）就是「这批号已经作废」，
    // 与「页面上没有这个元素」不是一回事：前者要重新取快照，后者要换目标。
    if (!world || !world.ids) return { ok: false, reason: 'stale_node' };
    const el = findByNodeId(D, t.nodeId);
    return el ? { el } : { ok: false, reason: 'stale_node' };
  };

  // ── 命中检查 ──────────────────────────────────────────────────────────────

  /**
   * 穿透 open shadow root 的 `elementFromPoint`。
   *
   * 不穿透的话：shadow 里的控件命中的是**宿主**，`hit !== el && !el.contains(hit)`
   * 一律成立 → 每个组件库控件都被报成「被浮层挡住」。那是把「点得到」误报成
   * 「点不到」，模型会去关一个根本不存在的浮层。
   */
  const deepHit = (x, y) => {
    let node = null;
    try { node = D.elementFromPoint(x, y); } catch { return null; }
    for (;;) {
      let sr = null;
      try { sr = node && node.shadowRoot; } catch { sr = null; }
      if (!sr || typeof sr.elementFromPoint !== 'function') return node;
      let inner = null;
      try { inner = sr.elementFromPoint(x, y); } catch { inner = null; }
      if (!inner || inner === node) return node;
      node = inner;
    }
  };

  /** `el.contains` 不跨 shadow 边界，所以自己顺着 parentNode / host 往上走。 */
  const containsDeep = (host, node) => {
    let cur = node;
    while (cur) {
      if (cur === host) return true;
      cur = cur.parentNode || cur.host || null;
    }
    return false;
  };

  /** 只给人看的短标签，**不参与任何判定** —— 所以与 walker 的 nameOf 漂了也无害。 */
  const MAX_LABEL = 80;
  const labelOf = (el) => {
    let s = '';
    if (typeof el.getAttribute === 'function') {
      s = el.getAttribute('aria-label') || el.getAttribute('placeholder')
        || el.getAttribute('title') || el.getAttribute('name') || '';
    }
    if (!s) s = el.innerText || el.textContent || '';
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL)}…` : s;
  };

  const tagOf = (el) => (el.tagName ? String(el.tagName).toLowerCase() : '');
  const describe = (el) => {
    if (!el) return 'null';
    const tag = tagOf(el);
    const cls = el.className ? String(el.className).split(/\s+/)[0] : '';
    const id = typeof el.getAttribute === 'function' ? el.getAttribute('id') : null;
    return tag + (id ? `#${id}` : '') + (!id && cls ? `.${cls}` : '');
  };

  /** 能不能往里打字。协议层事实（元素类型 + disabled / readOnly），不是「看起来像」。 */
  const editableOf = (el) => {
    const tag = tagOf(el);
    if (el.disabled === true) return false;
    if (tag === 'textarea') return el.readOnly !== true;
    if (tag === 'input') {
      // 只有装得下用户打进去的文本的那些。checkbox / radio / submit 之类
      // insertText 进去是**静默无效**（实测 ack 0ms、value 一个字都不变）。
      const type = typeof el.type === 'string' ? el.type.toLowerCase() : 'text';
      const typed = ['', 'text', 'search', 'tel', 'url', 'email', 'number', 'password', 'date', 'time', 'month', 'week', 'datetime-local'];
      return typed.indexOf(type) !== -1 && el.readOnly !== true;
    }
    return el.isContentEditable === true;
  };

  /**
   * 三件事：滚进视野 → 重新量 → 命中检查。四种失败各有各的名字，
   * 因为模型的下一步完全不同（换目标 / 先关浮层 / 重新取快照）。
   */
  const measure = (el) => {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* 有的替身没有它 */ }
    let r;
    try { r = el.getBoundingClientRect(); } catch { return { ok: false, reason: 'not_found' }; }
    // 与 walker 的 visible() 第一条同一个判据：折叠到看不见的元素点不到。
    if (r.width < 2 || r.height < 2) return { ok: false, reason: 'not_visible', w: Math.round(r.width), h: Math.round(r.height) };
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    // 滚过之后**仍然**在视口外：position:fixed 的祖先、或者内层容器自己就在视口外。
    // 不查这一条的话 elementFromPoint 回 null，报出来是「被 null 挡住了」——
    // 说的是另一件事。
    const vw = W.innerWidth || 0;
    const vh = W.innerHeight || 0;
    if (x < 0 || y < 0 || x >= vw || y >= vh) {
      return { ok: false, reason: 'offscreen', x, y, vw, vh };
    }
    const hit = deepHit(x, y);
    if (!hit || !(hit === el || containsDeep(el, hit))) {
      return { ok: false, reason: 'intercepted', by: describe(hit), x, y };
    }
    return {
      ok: true, x, y,
      isPassword: isPasswordField(el),
      editable: editableOf(el),
      disabled: el.disabled === true,
      tag: tagOf(el),
      label: labelOf(el),
    };
  };

  // ── 各个 op ───────────────────────────────────────────────────────────────

  const op = req && req.op;

  if (op === 'scroll') {
    // **不用 CDP 的 `Input.dispatchMouseEvent` mouseWheel。** 2026-09-08 在 Electron
    // 41.2.1 上实测：那条命令**永不 ack、也一个像素都不滚**，五种组合逐一试过
    // （view 隐藏 / view 可见但窗口隐藏 / 窗口也显示 × 禁不禁用硬件加速）；
    // `Input.synthesizeScrollGesture` 会 ack（约 1030ms）但同样不滚。
    // 隔离世界里的 scrollBy 是同步的、当场量得到，而且不挑可见性。
    const dir = req.direction === 'up' ? -1 : 1;
    // 落点取视口中心，与「用户把光标放在页面中间滚」一致。
    const cx = Math.round((W.innerWidth || 0) / 2);
    const cy = Math.round((W.innerHeight || 0) / 2);
    // **滚的是滚动链上的那个容器**，不是永远滚 document：学术站点的结果区大量是
    // 内层 overflow:auto，滚 document 是一像素都不动而返回值说「滚过了」。
    // 判据是 CSS 的 overflow + 有没有可滚余量，都是页面事实。
    const scrollable = (e) => {
      if (!e || e.nodeType !== 1) return false;
      let st = null;
      try { st = W.getComputedStyle(e); } catch { st = null; }
      if (!st) return false;
      const oy = st.overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
      return e.scrollHeight - e.clientHeight > 1;
    };
    let node = deepHit(cx, cy);
    let box = null;
    while (node) {
      if (scrollable(node)) { box = node; break; }
      node = node.parentNode || node.host || null;
    }
    const doc = D.scrollingElement || D.documentElement;
    const target = box || doc;
    const viewport = box ? box.clientHeight : (W.innerHeight || 0);
    // 不给 amount 就滚一屏 —— 这个数来自页面自己的视口高度，不是拍的阈值。
    const step = typeof req.amount === 'number' ? req.amount : viewport;
    const before = target ? target.scrollTop : 0;
    if (box) box.scrollTop = before + dir * step;
    else W.scrollBy(0, dir * step);
    const after = target ? target.scrollTop : 0;
    const max = target ? target.scrollHeight - target.clientHeight : 0;
    return {
      ok: true, container: box ? describe(box) : 'document',
      before: Math.round(before), after: Math.round(after),
      delta: Math.round(after - before),
      atStart: after <= 0, atEnd: after >= max - 1,
      step: Math.round(step),
    };
  }

  const found = resolve(req && req.target);
  if (found.ok === false) return found;
  const el = found.el;

  if (op === 'measure') return measure(el);

  if (op === 'focusSelect') {
    // 密码闸的第二道（第一道在快照那层）。**先判再动**：连 focus 都不许发生。
    if (isPasswordField(el)) return { ok: false, reason: 'password' };
    if (!editableOf(el)) {
      return { ok: false, reason: 'not_editable', tag: tagOf(el), type: typeof el.type === 'string' ? el.type : '' };
    }
    try { el.focus(); } catch { /* 有的替身没有它 */ }
    // **全选之后再 insertText 才是「把检索词打进去」。** 实测：点在一个有内容的
    // 输入框中间之后 selectionStart/End 落在光标处，insertText 是**插入**不是替换
    // （"旧内容" + "石墨烯" → "旧内容石墨烯"）。插在哪取决于点到了哪个像素 ——
    // 同一个动作在同一个页面上能产出不同的串，而且不报错。全选之后 insertText
    // 替换选区（实测 "旧内容" → "量子计算"）。
    let selected = false;
    if (typeof el.select === 'function') {
      try { el.select(); selected = true; } catch { selected = false; }
    } else {
      // contenteditable 没有 select()：用 Range 选中它的全部内容（实测同样是替换）。
      try {
        const range = D.createRange();
        range.selectNodeContents(el);
        const sel = W.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        selected = true;
      } catch { selected = false; }
    }
    const active = D.activeElement;
    return { ok: true, focused: active === el || containsDeep(el, active), selected };
  }

  if (op === 'readValue') {
    // 打完之后把框里**真正**变成什么读回来。`Input.insertText` 在焦点不是可编辑元素时
    // **ack 0ms 而什么都不做**（实测：body / button / readonly / disabled 四种都是），
    // 不读回来的话「打进去了」就是一句没有依据的话。
    if (isPasswordField(el)) return { ok: false, reason: 'password' };
    const raw = typeof el.value === 'string' ? el.value
      : (el.isContentEditable === true ? (el.innerText || el.textContent || '') : null);
    if (raw === null) return { ok: true, value: null };
    const s = String(raw);
    const MAX = 200;
    return s.length > MAX
      ? { ok: true, value: `${s.slice(0, MAX)}…`, truncated: true, length: s.length }
      : { ok: true, value: s };
  }

  if (op === 'select') {
    if (tagOf(el) !== 'select') return { ok: false, reason: 'not_select', tag: tagOf(el) };
    const opts = [];
    const list = el.options || [];
    for (let i = 0; i < list.length; i++) opts.push(String(list[i].value));
    // **值不在选项里就当场报出来**，不许静默：`el.value = '不存在'` 会把 select
    // 变成「什么都没选」（value 变空串），而下一步提交出去的就是一次空筛选 ——
    // 不报错，只是结果是错的。
    if (opts.indexOf(String(req.value)) === -1) {
      const MAX_OPTS = 20;
      return {
        ok: false, reason: 'no_option',
        options: opts.slice(0, MAX_OPTS),
        total: opts.length,
      };
    }
    const before = String(el.value);
    el.value = String(req.value);
    // 站点的筛选几乎都挂在这两个事件上。只赋值不派发 = 值变了、页面不知道。
    // `bubbles: true` 是必须的：委托到容器上的监听器（jQuery 的 .on(sel, …)）
    // 只收得到冒泡上来的那些。
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch { /* 替身里可能没有 Event */ }
    let label = '';
    for (let i = 0; i < list.length; i++) {
      if (String(list[i].value) === String(req.value)) { label = String(list[i].text || ''); break; }
    }
    return { ok: true, value: String(el.value), label, changed: before !== String(el.value) };
  }

  return { ok: false, reason: 'unknown_op' };
}
