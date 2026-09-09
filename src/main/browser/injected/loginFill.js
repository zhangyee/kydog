// 这段代码在**网页里**执行，不是主进程。它不能 import 任何东西。
//
// 写成 .js 而不是 .ts：整份源码会被 ?raw 原样注入浏览器，而浏览器跑不了 TS 语法。
// 它跑在 walker 的**同一个隔离世界**里（browserService 的 WALKER_WORLD_ID）——
// 必须是同一个：发号表 (`__kydogWorld.ids`) 与常驻密码登记 (`__kydogWorld.pw`)
// 都在那里，换一个世界就等于两边各说各的。
//
// 整份源码是**一个箭头函数表达式**，调用方拼成 `(<这份源码>)(<请求 JSON>)`，
// 与 interact.js 同一个形态（不走 `window.__kydogX` 这类全局：那要两次注入，
// 两次之间页面可以导航走）。
//
// ── 这一份为什么必须「一次求值里原子完成」──────────────────────────────────
//
// 它填的是用户的**校园统一身份认证密码**。走 CDP（focus + insertText + focus +
// insertText …）的话，主进程与页面之间至少四个来回，每个来回之间页面都可以
// `location = 'https://evil.example/'` —— 而 TOCTOU 窗口正是这一批的全部风险所在。
// 一次求值里做完，窗口就只剩「主进程重判完 → 这段代码开始跑」那一瞬，而这一瞬
// 由下面 `expectOrigin` 那道自检自己再关一次。
//
// 代价是 `.value` 这条路不产生真实的用户输入事件序列（没有 keydown/keypress/keyup）。
// **它的失败形态是「站点没收到输入」，响亮、当场看得见**，不是「密码去了别处」——
// 两种失败的代价不对称，所以取这一侧。
//
// ── 写值必须走原型上的原生 setter，别直接写 `.value` ────────────────────────
//
// React 受控组件在**实例上**用 `Object.defineProperty` 覆盖了 `value`
// （它的 value tracker），直接写 `.value` 会被它吃掉。实测（2026-09-09，
// Chromium / React 18.3.1 UMD，受控 `<input>` + `onChange` 回写 state，
// 页面主世界）：
//
// | 写法 | onChange 触发 | React state | DOM value | 原生表单提交拿到 |
// | --- | --- | --- | --- | --- |
// | `el.value = v` | **0 次** | **""（没变）** | v | v |
// | 原型原生 setter + dispatch input | 1 次 | v | v | v |
//
// 也就是说：直接写 `.value` 在「站点用 React state 去发请求」（SPA 登录页的常态）
// 时**发出去的是空账号**，而在「站点走原生 form 提交」时又碰巧是对的 —— 一半对
// 一半错正是最难认出来的那种。原生 setter 两种都对，所以无条件走它。
//
// 改了这里的返回结构，要同步 loginFlow.ts 的 `LoginFillReply` 与 `describeFillFailure`
// 的判据，并跑 `npm test -- loginFill loginFlow`：这份代码在网页里执行、类型系统
// 管不到它，两边漂移不会编译报错，只会让判据静默失效。
(req) => {
  // ── 过期自检：撞了主进程那道单次求值时限就自己不做 ─────────────────────────
  // 判据与做法同 interact.js 那一处（那里有实测数据）：主进程取消不了已经注进去的
  // 求值，页面回魂之后照常执行 —— 而这一份**会把密码写进页面**，比滚一次视口重得多。
  // 缺 notAfter 不等于过期，不带它的调用方照常执行。
  if (typeof req.notAfter === 'number' && Date.now() > req.notAfter) {
    return { ok: false, reason: 'expired', wrote: false };
  }

  const W = window;
  const D = document;

  const fail = (reason, extra) => {
    const r = { ok: false, reason, wrote: false };
    if (extra) for (const k in extra) r[k] = extra[k];
    return r;
  };

  // ── origin 自检：主进程重判与这一刻之间页面又跳走了吗 ───────────────────────
  //
  // 主进程在**排队之后、注入之前**用 `wc.getURL()` 重判过一次（loginFlow 的 TOCTOU
  // 重判）。那一判到这段代码真的在页面里跑起来，中间仍隔着一次跨进程往返 ——
  // 页面完全可以在这中间自己 `location = …`。这道自检是同一件事的第二层，
  // 判据是**这个文档自己的 origin**，页面伪造不了（隔离世界读的是真的 location）。
  //
  // 不比较完整 URL：query / hash 在登录页上会被站点自己改（回跳参数、锚点），
  // 比 URL 会把好的填充误拒。origin 才是「凭据交给谁」这件事的判据。
  let here = '';
  try { here = String(W.location.origin); } catch { here = ''; }
  if (typeof req.expectOrigin !== 'string' || req.expectOrigin === '' || here !== req.expectOrigin) {
    return fail('origin_changed', { origin: here });
  }

  // ── 收集这个文档里的全部 input（含 open shadow root），按文档序 ────────────
  //
  // 走 `querySelectorAll('*')` 再挑 input，而不是 `querySelectorAll('input')`：
  // 后者不穿透 shadow root，组件库包出来的登录框会整片看不见（walker 的发号表
  // 递归进去发过号，这里查不到就成了「这个编号在页面上找不到了」，而它就在页面上）。
  // 成本与 interact.js 的 findByNodeId 同级（实测 8 万元素 4ms）。
  const inputs = [];
  const collect = (root, depth) => {
    // 深度上界只挡病态嵌套（shadow root 套 shadow root），正常页面到不了。
    if (depth > 20) return;
    let els;
    try { els = root.querySelectorAll('*'); } catch { return; }
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const tag = el.tagName ? String(el.tagName).toLowerCase() : '';
      if (tag === 'input') inputs.push(el);
      let sr = null;
      try { sr = el.shadowRoot; } catch { sr = null; }
      if (sr) collect(sr, depth + 1);
    }
  };
  collect(D, 0);

  // ── 哪些是密码框 ──────────────────────────────────────────────────────────
  //
  // **判据只有两条协议层事实**：此刻 IDL type 就是 password，或者
  // 常驻登记（pwRegistrar）在这个文档里**亲眼见过**它是 password
  // （站点点了「显示密码」把 type 改成 text 的那种）。
  //
  // 这里**刻意不用** walker / interact 那份四条判据（autocomplete、name/id 正则）：
  // 那三份守的是「不许往它里面打字」，宽一点只会多拒几个框，代价是零；而这里
  // 回答的是「把密码放进**哪一个**框」，宽一点的代价是把密码放进一个只是名字里
  // 带 pwd 的框（比如「忘记密码」那一栏的提示输入框），或者把本来唯一的密码框
  // 数成两个而整条拒掉。两个问题的失败方向相反，不能共用一份判据。
  const world = W.__kydogWorld;
  const seenAsPassword = (el) => !!(world && world.pw && world.pw.has(el));
  const isPassword = (el) => {
    const t = typeof el.type === 'string' ? el.type.toLowerCase() : '';
    return t === 'password' || seenAsPassword(el);
  };

  const pws = [];
  for (let i = 0; i < inputs.length; i++) if (isPassword(inputs[i])) pws.push(inputs[i]);
  if (pws.length === 0) return fail('no_password');
  // 多于一个就整条拒。**不猜哪个是「真的那个」**：猜错就是把校园密码写进一个
  // 我们说不清用途的框，而拒掉的代价只是让模型换一页或交给用户。
  if (pws.length > 1) return fail('many_passwords', { count: pws.length });
  const pw = pws[0];
  const form = pw.form || null;

  // ── 账号框 ────────────────────────────────────────────────────────────────

  const tagOf = (el) => (el.tagName ? String(el.tagName).toLowerCase() : '');
  const typeOf = (el) => (typeof el.type === 'string' ? el.type.toLowerCase() : '');
  /** 装得下一个账号的文本类 input。列表是白名单：没列的（hidden / checkbox /
   *  date 一族 / file / submit …）一律不算，宁可让模型显式指一个。 */
  const TEXTY = ['', 'text', 'email', 'tel', 'number'];
  const isTexty = (el) => TEXTY.indexOf(typeOf(el)) !== -1 && !isPassword(el);
  const visible = (el) => {
    try { return el.getClientRects().length > 0; } catch { return false; }
  };

  let user = null;
  let source = 'structure';

  if (req.usernameNodeId !== undefined && req.usernameNodeId !== null) {
    // **号必须是数字**（与 interact.js 的 resolve 同一条依据）：那边不查的话
    // `world.ids.get(el) === undefined` 对第一个没发过号的元素恒成立，一个畸形的
    // 请求会静默指向一个**任意的错框**并报成功。
    //
    // **在这里它是等价变异**，如实登记：进这一支的前提已经是「给了、且不是 null」，
    // 而发号表里的值一律是数字，所以任何非数字都只会「查不到」→ 同一条
    // stale_username_index。删掉它一条用例都不会红（变异自查 N9 实测存活）。
    // 留着是防御纵深 + 把契约写明白，与 browserService `enqueue` 里那句
    // 「去掉它是等价变异」同一个性质 —— 别把它当成有用例守着的东西。
    if (typeof req.usernameNodeId !== 'number') return fail('stale_username_index');
    if (!world || !world.ids) return fail('stale_username_index');
    for (let i = 0; i < inputs.length; i++) {
      if (world.ids.get(inputs[i]) === req.usernameNodeId) { user = inputs[i]; break; }
    }
    // 找不到号：可能是文档换过（号整批作废），也可能模型指的根本不是 input。
    // 两种的下一步一样 —— 重新取一份快照。
    if (!user) return fail('stale_username_index');
    source = 'model';
    // 主进程只校验两件事（spec §4.6 的原话）：与密码框同一个 form、且是文本类 input。
    // **`form` 都为 null 也算「同一个」** —— 页面把登录框放在 <form> 外面（fetch 提交）
    // 是常见写法，那时没有任何 form 事实可比，这一条就退化成不设防；真正兜住它的是
    // 上一层的 origin 判据与用户那次确认，**加上「这个框是模型自己指的」**。
    // 这是刻意留的边界，不是漏判 —— 但它**只在这一支**成立：下面结构规则那一支没有
    // 「模型自己指的」这一条兜底，所以那里整页无 form 时直接拒（见 else 里那段）。
    if ((user.form || null) !== form) return fail('username_not_same_form');
    if (!isTexty(user)) return fail('username_not_text', { tag: tagOf(user), type: typeOf(user) });
    if (user.disabled === true) return fail('username_disabled');
  } else {
    // 结构规则：同一个 form 里、**排在密码框之前**、可见、没禁用的最后一个文本框。
    //
    // 「之前」是硬条件不是偏好：登录表单里账号在密码之前是 HTML 表单的通行写法，
    // 而放宽成「取最近的一个」就会在「密码 + 验证码」这种版式上选中验证码框 ——
    // 那是把账号写进验证码栏，站点收到的是一次必然失败的登录，而高校 IdP 会为
    // 连续失败锁账号。选不出来就明确报错，让模型用 usernameIndex 指一个。
    //
    // **密码框不在任何 <form> 里时，这一支整条 fail-closed。** 那时
    // `(el.form || null) !== form` 两边都是 null，「同一个 form」不再是任何约束 ——
    // 页面顶部的站内搜索框与登录框在这条判据下一样合格。评审实测（2026-09-09）：
    // 这种页上结构规则会挑中 `#search`、`ok: true` 返回，账号写进搜索框，随后
    // 提交出去的是一次**账号为空**的登录 —— 而「一轮只有一次机会」意味着那是本轮
    // 唯一的机会。**不猜**：让模型取一份快照、用 usernameIndex 指一个。
    // 模型指的那一支保留这条边界（那里有模型的显式选择兜底，见上面
    // `username_not_same_form` 那一句上面那段）。
    if (!form) return fail('username_needs_index');
    const at = inputs.indexOf(pw);
    for (let i = at - 1; i >= 0; i--) {
      const el = inputs[i];
      if ((el.form || null) !== form) continue;
      if (!isTexty(el) || el.disabled === true) continue;
      if (!visible(el)) continue;
      user = el;
      break;
    }
    if (!user) return fail('no_username');
  }

  // ── 回显「实际选中了哪个字段」（spec §4.6）：**在写之前算** ────────────────
  //
  // **只回属性，绝不回 value。** 模型要能看出我们填的是不是它以为的那个框，
  // 而框里此刻装的就是账号 —— 回值等于把它送进模型上下文。
  //
  // **算在 put() 之前，不是之后**，这一条是硬的：`put()` 里的 `fire(el, 'input')`
  // **同步**跑页面自己的监听器，而那一刻密码已经在页面的 DOM 里了。一个被 XSS 或
  // 本身敌意的登录页只要在密码框的 input 监听器里
  // `user.setAttribute('placeholder', this.value)`，写完之后再读 `desc()` 就把密码
  // 原样抄进回执 → 工具结果 → 模型上下文 → transcript（评审 2026-09-09 实测拿到了
  // 哨兵密码）。`id` / `name` / `placeholder` 全是页面随时改得动的属性，所以唯一
  // 说得清的时刻是**页面还没跑过任何一行代码**的此刻。顺带这也更正确：回执要说的是
  // 「我挑中了哪个框」，不是「页面事后把它改成了什么」。
  //
  // 每个属性再套一道长度上界：它们是页面文本，进的是模型上下文，与 walker 的
  // `MAX_TEXT` 同一件事，所以用同一个数；截断带记号，不静默（spec §5.5）。
  const MAX_ATTR = 160;
  const desc = (el) => {
    const bits = [tagOf(el)];
    const g = (n) => {
      let v = '';
      try { v = typeof el.getAttribute === 'function' ? (el.getAttribute(n) || '') : ''; } catch { v = ''; }
      return v.length > MAX_ATTR ? `${v.slice(0, MAX_ATTR)}…[截断，原长 ${v.length} 字符]` : v;
    };
    const id = g('id');
    const name = g('name');
    const ph = g('placeholder');
    if (id) bits.push('#' + id);
    if (name) bits.push('[name=' + name + ']');
    if (ph) bits.push('（提示文字：' + ph + '）');
    return bits.join('');
  };
  const fieldDesc = desc(user);

  // ── 提交路径要在**写之前**探明 ───────────────────────────────────────────
  //
  // 写完再发现提交不了的话，页面上就留下一份填好的凭据而这一步报的是失败 ——
  // 那正是「已经生效之后再报错」（网页不可回滚）。所以先探，探不到就一个字都不写。
  let submitPlan = null;
  if (req.submit === true) {
    if (!form) return fail('no_form');
    let btn = null;
    try { btn = form.querySelector('button[type="submit"], input[type="submit"]'); } catch { btn = null; }
    const canRequest = typeof form.requestSubmit === 'function';
    // 两者都没有就**明确报错、不猜**（不去按回车、不去点看起来像提交的 div）。
    if (!canRequest && !btn) return fail('no_submit');
    // `requestSubmit(btn)` 而不是 `requestSubmit()`：带上 submitter 才会把提交按钮
    // 自己的 name/value 放进表单数据。Shibboleth 一族的 IdP 正是靠它传
    // `_eventId_proceed` 这类字段 —— 漏了它，表单发出去了而 IdP 认为什么都没提交。
    submitPlan = canRequest ? { how: 'requestSubmit', btn: btn || null } : { how: 'click', btn: btn };
  }

  // ── 写值 ─────────────────────────────────────────────────────────────────

  const nativeSetter = (el) => {
    const proto = tagOf(el) === 'textarea'
      ? (W.HTMLTextAreaElement && W.HTMLTextAreaElement.prototype)
      : (W.HTMLInputElement && W.HTMLInputElement.prototype);
    let d = null;
    try { d = proto && Object.getOwnPropertyDescriptor(proto, 'value'); } catch { d = null; }
    return d && typeof d.set === 'function' ? d.set : null;
  };

  const fire = (el, type) => {
    try {
      const Ev = W.Event;
      if (typeof Ev === 'function') { el.dispatchEvent(new Ev(type, { bubbles: true })); return; }
    } catch { /* 下面那条兜底 */ }
    try { el.dispatchEvent({ type, bubbles: true }); } catch { /* 派发不了就算了，值已经写进去了 */ }
  };

  const put = (el, v) => {
    try { if (typeof el.focus === 'function') el.focus(); } catch { /* 焦点拿不到不影响写值 */ }
    const set = nativeSetter(el);
    // 拿不到原生 setter（页面把整个原型都换了这种病态情形）才退回直接写 —— 那时
    // React 受控组件会吃掉这次写入（见文件头的实测表），但「什么都不做」更糟。
    if (set) set.call(el, v); else el.value = v;
    // input 给现代框架（React / Vue / Angular 都听它），change 给老式 jQuery 校验。
    fire(el, 'input');
    fire(el, 'change');
  };

  put(user, String(req.username));
  put(pw, String(req.password));

  // 回读**只查账号框**：站点把它设成 readonly / 或者有脚本当场改回去时，这一步
  // 是唯一看得出来的地方。密码框不回读 —— 读出来的值没有任何地方能安全地放。
  // 这一条之后 wrote 恒为 true：页面已经被写过了，回滚不了。
  if (String(user.value) !== String(req.username)) {
    return { ok: false, reason: 'write_rejected', wrote: true };
  }

  let submitted = false;
  if (submitPlan) {
    try {
      if (submitPlan.how === 'requestSubmit') form.requestSubmit(submitPlan.btn || undefined);
      else submitPlan.btn.click();
      submitted = true;
    } catch {
      // 值已经填进去了，提交这一下没成 —— 必须与「什么都没做」分开报。
      //
      // **不把那个错误的文本带回去。** 这是「写值之后才读页面」的第二处（第一处是
      // 上面的 `desc()`）：此刻密码已经在页面的 DOM 里，而 err 的 message 是页面
      // 影响得到的字符串，带回去就是又开一条「页面 → 回执 → 模型上下文」的路。
      // 模型的下一步与错误文本无关（取快照、自己点提交），所以它没有存在的理由。
      return { ok: false, reason: 'submit_failed', wrote: true };
    }
  }

  return {
    ok: true,
    wrote: true,
    // 写之前算好的那一份（见上面那段：写之后再读就是一条把密码送进模型上下文的路）。
    field: fieldDesc,
    source: source,
    submitted: submitted,
    submitHow: submitPlan ? submitPlan.how : null,
  };
}
