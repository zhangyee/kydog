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
  // ── 过期自检：撞了主进程那道单次求值时限就自己不做 ─────────────────────────
  //
  // **主进程取消不了已经注进去的求值**（Electron 41.2.1 没有这个入口，见
  // browserService 的 `evalOn`）。页面被自己的脚本占住主线程时，这段代码排在忙循环
  // 后面 —— 主进程那边早已按时限放弃并报错，而这里稍后照常执行。实测（真页面、
  // 真 `window.scrollBy`，3/3 复现）：忙循环 8 秒 / 时限 3 秒，主进程 3.00 秒说
  // 「没等到」，页面 7.2–7.8 秒**真的滚了 800 像素**。模型据此重试就是两次落地，
  // `select` 那一下还会把 change 派发两遍（学术站点上 change 就是重新检索一次）。
  //
  // 所以到点了就在碰页面之前退出来。判据是 `Date.now()` 与主进程算出的**同一个**
  // 到点时刻：隔离世界里的 `Date.now` 页面覆写不到（与 nodeId 发号表同一条依据）。
  // 缺这个字段不等于过期 —— 不带 notAfter 的调用方照常执行。
  //
  // 这不是「取消」：卡在到点那一刻的窗口里，自检过了之后写照样会落地。
  // 所以主进程那条消息说的是「结果未知」，不是「没有发生」。
  if (typeof req.notAfter === 'number' && Date.now() > req.notAfter) {
    return { ok: false, reason: 'expired' };
  }

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
    // **号必须是数字，这一条要 fail-closed。** 不查的话：`world.ids.get(el)` 未命中
    // 回 undefined，而 `undefined === undefined` 对**第一个没发过号的元素**恒成立 ——
    // 于是 `{}` 或 `{nodeId: undefined}` 这种目标会 ok:true 地指向一个**任意的错元素**
    // 并报成功（实测：发号表里只有 #b 有号时，target={} 回 `{ok:true,tag:'button'}`）。
    // 那正是 spec §4.2 点名最危险的那个形状：不报错，只是点错东西。
    // 这一层是纵深 —— `resolveTarget` 保证号取自快照节点，但 `isWalkerOutput` 只查
    // `Array.isArray(o.nodes)`、不查每个节点的形状，缺号的节点一路放行。
    if (typeof t.nodeId !== 'number') return { ok: false, reason: 'stale_node' };
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

  /**
   * 分段选择器。**装得下用户输入，但 `Input.insertText` 对它们完全无效** ——
   * 2026-09-09 实测（Electron 41.2.1，真页面，先点一下再发命令）：
   *
   * | 做法 | date 框（原值 2020-01-01） |
   * | --- | --- |
   * | 点 → `insertText('2024-02-03')` | 仍是 `2020-01-01`（一个字都没进去） |
   * | 点 → `value=''` → `insertText(…)` | 变成 `''`（**把原值抹了，还是没打进去**） |
   * | 点 → 逐个 `keyDown` '2','0','2','4' | `2024-01-01`（只改到当前那个分段） |
   *
   * 所以 `type` 对它们**在碰之前就拒**：静默无效已经是「以成功措辞返回一件没发生
   * 的事」，而「先清空再打空」更糟 —— 它把用户原本填好的年份抹掉了，网页不可回滚。
   * 按键那条路能改分段，但分段顺序与本地化格式我们没有依据去拼，这一期不做。
   */
  const SEGMENTED_TYPES = ['date', 'time', 'month', 'week', 'datetime-local'];
  const typeOf = (el) => (typeof el.type === 'string' ? el.type.toLowerCase() : '');
  const segmentedOf = (el) => tagOf(el) === 'input' && SEGMENTED_TYPES.indexOf(typeOf(el)) !== -1;

  /**
   * 当前 frame 的默认链接导航意图。沿 parentNode / shadow host 精确找 `<a href>`；
   * `_blank` 等新 browsing context 不算当前主 frame，javascript/mailto 也不是浏览器
   * 工具允许的页面导航。HTMLAnchorElement.href 给的是已经按 document.baseURI 解析后的绝对 URL。
   */
  const navigationUrlOf = (el) => {
    let node = el;
    while (node) {
      if (tagOf(node) === 'a') {
        const target = typeof node.getAttribute === 'function'
          ? String(node.getAttribute('target') || '').toLowerCase() : '';
        if (target !== '' && target !== '_self') return null;
        const href = typeof node.href === 'string' ? node.href : '';
        if (/^https?:\/\//i.test(href)) return href;
        return null;
      }
      node = node.parentNode || node.host || null;
    }
    return null;
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
   *
   * **第一件事「真的滚」是一条 e2e 判据的地基 —— 要改它先看这里。**
   * `e2e/61-browser.spec.ts` 那条「走真的 type：…整批在碰页面之前就被挡下」靠
   * 「页面一个像素都没滚」区分密码框上那**两道措辞逐字相同**的闸：第一道
   * （`actions.ts` 的 `assertTypeAllowed`）在 dispatch 调 interact **之前**，
   * 第二道（`browserService.ts` 里 `m.isPassword`）在这个 measure 回来**之后**。
   * 下面这行改成「算滚动偏移而不真滚」之类的做法，那条判据会**静默失效**
   * （永远绿、不报错，只是不再区分两道闸）。同一条用例里有一个非密码输入框的
   * 对照动作断言 `scrollY > 0`，真改了它会先红 —— 别把那条对照当成多余的删掉。
   *
   * **`behavior: 'instant'` 不能去掉。** 不写它时用的是 `scroll-behavior` 的计算值，
   * 也就是**站点说了算**：站点写 `scroll-behavior: smooth`（html 上或内层滚动容器上）
   * 时这一下是动画，而 `scrollIntoView` **不等动画结束就返回**，紧接着那行
   * `getBoundingClientRect()` 量到的是动画还没开始的坐标 —— 于是下面那道视口判据
   * 报 `offscreen`，`click` / `type` / `hover` 在任何平滑滚动的站点上都碰不到需要
   * 滚动才够得着的目标。**重试不自愈**：每次量到的都是另一个中间态。
   *
   * 实测（Electron 41.2.1，example.com 上注入夹具，2026-09-10）：
   *  · 站点 `html{scroll-behavior:smooth}`、目标在文档 y=3000 —— 不带 `behavior`：
   *    `scrollY` 0 → **0**，rect.top 3120，判成 `offscreen`；连调两次结果逐字相同。
   *  · 同一页、带 `behavior:'instant'`：`scrollY` 0 → **2738**，rect.top 382，进视口。
   *  · 内层 `overflow:auto` 且自己也 `scroll-behavior:smooth` 的容器：不带 `behavior`
   *    容器 `scrollTop` 0 → **0**（rect.top 4100，视口外）；带 `instant` → **3818**
   *    （rect.top 282，进视口）。**整条滚动链都被压成瞬时**，不只是最外层。
   *
   * 用 `instant` 而不是等 `scrollend`（Electron 41 上 `'onscrollend' in window` 为
   * **true**，确实有这个事件）是因为：等事件要把这个同步函数改成异步，而「等多久」
   * 除了事件本身没有别的协议层信号 —— 一旦滚动压根没发生（元素已在位）就没有
   * `scrollend`，只能补一个超时兜底，那就是 CLAUDE.md 开篇禁的时间窗。
   * `instant` 反过来把「会不会平滑」从站点手里拿回来，不需要等任何东西。
   *
   * **它没有换掉 `scrollIntoView` 这个调用**，所以那条 e2e 判据（数隔离世界里
   * `Element.prototype.scrollIntoView` 被调了几次）照旧成立。
   */
  const measure = (el) => {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch { /* 有的替身没有它 */ }
    let r;
    try { r = el.getBoundingClientRect(); } catch { return { ok: false, reason: 'not_found' }; }
    // 与 walker 的 visible() 第一条同一个判据：折叠到看不见的元素点不到。
    // **那个 2 是经验值、没有推导过**（出处与取舍写在 walker.js 那一处），
    // 两边必须一起改 —— 差分用例守的是「两边相等」，不是「这个数对不对」。
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
      // 分段选择器要在**点下去之前**就问得到（见 SEGMENTED_TYPES 那段实测）：
      // 放到 focusSelect 才判就晚了 —— 那时这一下已经点出去了。
      segmented: segmentedOf(el),
      disabled: el.disabled === true,
      tag: tagOf(el),
      // 只是控件的类型名（text / date / …），报错时说得出「是哪一类控件」。
      // 它不是值，也不受密码判据影响 —— 密码框在上面几道闸就退了。
      type: typeOf(el),
      label: labelOf(el),
      navigationUrl: navigationUrlOf(el),
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
    // **方向也 fail-closed。** 这份代码是独立注入的一份，`validateBatch` 与
    // TypeBox 那两道拦不到直接调它的路；而 `=== 'up' ? -1 : 1` 会把任何写错的方向
    // 都当成「往下」——「我说往左，它往下滚了还报成功」正是这个文件其余每一处
    // 都在避免的形状。
    if (req.direction !== 'up' && req.direction !== 'down') {
      return { ok: false, reason: 'bad_direction', direction: String(req.direction) };
    }
    const dir = req.direction === 'up' ? -1 : 1;
    // 落点取视口中心，与「用户把光标放在页面中间滚」一致。
    const cx = Math.round((W.innerWidth || 0) / 2);
    const cy = Math.round((W.innerHeight || 0) / 2);
    // **滚的是滚动链上的那个容器**，不是永远滚 document：学术站点的结果区大量是
    // 内层 overflow:auto，滚 document 是一像素都不动而返回值说「滚过了」。
    // 判据是 CSS 的 overflow + 有没有可滚余量，都是页面事实。
    //
    // ── 余量为什么是 `> 1` 而不是 `> 0`（这个 1 的出处）───────────────────────
    // `scrollTop` 是 double，而 `scrollHeight` / `clientHeight` 是**四舍五入的整数**。
    // 2026-09-09 实测（Electron 41.2.1，1280×800，deviceScaleFactor 0，
    // scale ∈ {1, 0.6266, 0.35} 三种结果一致）：
    //   内容 200.6px / 视口 200px  → scrollHeight−clientHeight 报 **1**，滚到底 scrollTop=0.5
    //   内容 200.5px / 视口 200.5px（真滚不动）→ 报 0
    // 也就是「报出来的 1px 余量」可能只是 0.5px 的真余量 —— 那是舍入噪声，不是
    // 可以滚的东西。挑中它当滚动目标，delta 恒 0，而真正该滚的 document 一动不动。
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
      // ── `max - 1` 里那个 1 的出处（与上面 `> 1` 同源）─────────────────────
      // 同一批实测：内容 1000.6px / 视口 200.4px 的容器，`scrollHeight−clientHeight`
      // 报 **801**，而真的滚到底时 `scrollTop` 停在 **800** —— 差 1。没有这 1px 容差，
      // 「已经到底了」永远报不出来，模型只会收到「滚了 0 像素、这个容器滚不动」，
      // 而这两句话的处置正好相反（停止翻页 vs 换一个滚动目标）。
      // **顶端不留容差**：往上滚会被夹到正好 0（实测 6 种容器都是），所以 `<= 0`
      // 是判据本身，不是近似 —— 两头不对称是因为事实不对称。
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
    // 分段选择器（date / time / …）：insertText 对它们完全无效，见 SEGMENTED_TYPES
    // 那段实测。**在 focus 之前就退**，一个字都不许改。
    if (segmentedOf(el)) {
      return { ok: false, reason: 'no_text_input', tag: tagOf(el), type: typeOf(el) };
    }
    try { el.focus(); } catch { /* 有的替身没有它 */ }

    // ── 「先清空」这一步要么真的发生，要么当场说没发生 ──────────────────────
    //
    // 实测：点在一个有内容的输入框中间之后，insertText 是**插入**不是替换
    // （"旧内容" + "石墨烯" → "旧内容石墨烯"；`type=number` 的 "2020" + "2024"
    // → "20202024"），插在哪取决于点到了哪个像素 —— 同一个动作在同一个页面上
    // 能产出不同的串，而且不报错。全选之后 insertText 替换整个选区。
    //
    // **判据是选区这个页面事实，不是「select() 有没有抛」**（实测：它在 7 种类型上
    // 都不抛）。选区在真 DOM 上有三种形态，逐个量过：
    //
    // | 类型 | selectionStart/End | `String(getSelection())` | insertText 之后 |
    // | --- | --- | --- | --- |
    // | ''/text/search/tel/url/password + textarea | `[0, len]` | = len | 替换 |
    // | email / number | **恒 null** | **= len** | **替换**（真的选中了） |
    // | date/time/month/week/datetime-local | 恒 null | 0 | 原样不动（上面已拒） |
    //
    // 所以只认 `selectionStart !== selectionEnd` 是不够的：它会把 email / number
    // 这两种**本来能用**的框误判成没清空。第二支只取选区的**长度**，从不读它的
    // 内容 —— 密码框在上面那道闸就退了，这里也不给自己开读明文的口子。
    let selected = false;
    const len = typeof el.value === 'string' ? el.value.length : null;
    if (typeof el.select === 'function') {
      try { el.select(); } catch { /* 不抛也不选的那些，下面按事实判 */ }
      if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number' && len !== null) {
        selected = el.selectionStart === 0 && el.selectionEnd === len && len > 0;
      } else if (len !== null) {
        let n = 0;
        try { n = String(W.getSelection() || '').length; } catch { n = 0; }
        selected = n === len && len > 0;
      }
    } else {
      // contenteditable 没有 select()：用 Range 选中它的全部内容（实测同样是替换，
      // 而且 Range 装上之后选区**不再是折叠的** —— 那就是这一支的事实判据）。
      try {
        const range = D.createRange();
        range.selectNodeContents(el);
        const sel = W.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        selected = sel.isCollapsed === false;
      } catch { selected = false; }
    }
    // 本来就是空的框不需要清 —— 「下一次 insertText 会替换掉整份内容」照样成立。
    // 与 selected 分开报：两者的依据不同，混成一个字段就分不出「没选中」与「没内容」，
    // 而调用方对这两件事的处置是一样的、对「都不成立」的处置才是停手。
    const emptyBefore = len === 0
      || (len === null && String(el.innerText || el.textContent || '') === '');
    const active = D.activeElement;
    return { ok: true, focused: active === el || containsDeep(el, active), selected, emptyBefore };
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
      // **截断必须显式回报**（spec §5.5 + 前几批立的 `{truncated, returned, totalKnown}`）。
      // 只给一个已经切过的数组 + total，等于让模型自己做减法才知道被截了 ——
      // 一个 35 项的下拉框，它看到 20 个候选值都不匹配，就会以为要的那项不存在。
      //
      // 按**字符**收而不是按项数：下拉框的 value 是年份 / 学科代码这类短串。
      // 1000 字符的依据与 extract 的 `MAX_FIELD_CHARS` 是同一个数、同一件事
      // （一格给模型看的文本预算）：1950–2026 这类整段年份表（77 项 × 5 字符
      // ≈ 385 字符）一项都不会少，而上千项的省市 / 期刊表也撑不爆一条错误消息。
      // 这里数得出总数，所以 `totalKnown` 给得出来 —— 数不出来时才不给这个键。
      const MAX_OPT_CHARS = 1000;
      const shown = [];
      let used = 0;
      for (let i = 0; i < opts.length; i++) {
        used += opts[i].length + 3;      // JSON 里每项的固定开销：两个引号 + 一个逗号
        if (used > MAX_OPT_CHARS) break;
        shown.push(opts[i]);
      }
      return {
        ok: false, reason: 'no_option',
        options: shown,
        truncated: shown.length < opts.length,
        returned: shown.length,
        totalKnown: opts.length,
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
