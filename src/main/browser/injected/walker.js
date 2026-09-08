// 这段代码在**网页里**执行，不是主进程。它不能 import 任何东西。
//
// 写成 .js 而不是 .ts：整份源码会被 ?raw 原样注入浏览器，而浏览器跑不了 TS 语法。
// 它跑在**隔离世界**里（见 browserService 的 WORLD_ID）——
//   · 页面覆写 document.querySelectorAll 骗不到它（2026-09-08 spike 实测）
//   · 它挂在 window 上的东西页面看不见，所以发号表不会被读取或伪造
//   · 文档一换，隔离世界连同发号表一起重置
//
// 改了这里的输出结构，要同步 snapshot.ts 的 AxNode / AxSnapshot 与 renderDiff 的判据，
// 并跑 snapshot.test.ts（那里用 new Function 把这份源码真的跑起来）。两边漂移不会
// 编译报错，只会让 diff 静默退化 —— 或者更糟：拿两个文档的号互相配对，
// 输出「页面没有变化。」而页面整个换了。
(() => {
  const W = window;

  // ── 世代标识 ──────────────────────────────────────────────────────────────
  //
  // 隔离世界跟着文档一起重置：新文档拿到一张空的发号表，号从 1 重新发。
  // **「重置成 1」给出的是号「碰撞」，不是号「不重复」** —— 两份跨文档的快照
  // 号段完全重叠，逐节点配对得到的每一条结论都是假的。所以把「这是哪一批号」
  // 这个事实本身报出来，让下游能判定「这两份快照的号根本不可比」。
  //
  // 为什么是随机 id 而不是「每次新文档 +1」：计数器得存在某个地方，而这一侧唯一
  // 能存的地方（隔离世界的 window）正是跟着文档一起被清掉的那个 —— 计数器自己
  // 也会被重置回同一个初值，那就是 nodeId 撞号那条 bug 换了个名字。随机值不需要
  // 记住上一次是多少，「每次重置必然不同」这条性质由熵保证。
  const randomId = () => {
    const c = W.crypto;
    // getRandomValues 在任何上下文里都有（不像 randomUUID 只在安全上下文里有，
    // 而校园网里的 http:// 登录页恰恰不是安全上下文）。
    if (c && typeof c.getRandomValues === 'function') {
      const a = new Uint32Array(4);
      c.getRandomValues(a);
      let s = '';
      for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(8, '0');
      return s;
    }
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  };

  // 世代、发号表、密码记忆放在同一个对象里：它们必须同生共死。拆成三个全局的话，
  // 将来任何一个被单独重置或清理，另外两个立刻开始说谎。
  const world = W.__kydogWorld || (W.__kydogWorld = {
    gen: randomId(),
    next: 1,
    ids: new WeakMap(),
    pw: new WeakSet(),
  });

  const idOf = (el) => {
    let n = world.ids.get(el);
    if (!n) { n = world.next++; world.ids.set(el, n); }
    return n;
  };

  // ── 两道上限 ──────────────────────────────────────────────────────────────
  // 一道管**写进快照的条数**，一道管**遍历**。撞到哪一道都要如实回报（spec §5.5）。
  //
  // 撞上限**不中止整轮扫描，只降级**：MAX_NODES 到了就不再往 nodes 里写，遍历照走。
  // 早先的实现是撞到就 `return` 整个 scan，而文档序意味着**页首的隐藏大菜单能饿死
  // 页尾的一切真控件** —— 真 Chromium 实测：display:none 的菜单 3000 条起，
  // 「检索框 + 搜索按钮在后」的那种页面直接返回 nodes: []（需求书 §F 点名的正是这类站点）。
  // 「如实地告诉模型我什么都没看见」不等于给遍历加了上界。降级还有两个副产品：
  // iframe 数得完（撞上限后停手的实现会报 iframes: 0），候选总数也数得完。

  /** 写进快照的条数上限。容量保护，不参与任何语义判断。 */
  const MAX_NODES = 300;

  /**
   * 遍历的上限（走过的元素数）。**这是唯一还会中止扫描的那道闸**，所以它同时是
   * 整个采集的成本天花板：可见性判断（getBoundingClientRect + getComputedStyle，
   * 两者都强制 layout）只发生在命中选择器的元素上，而那是走过的元素的子集；
   * nameOf 兜底到 innerText 的那次 reflow 只发生在**可见且要写进快照**的元素上，
   * 被 MAX_NODES 卡在 300 以内。所以只留这一道就够，不必再给 layout 单开一道
   * ——单开的那道正是把「隐藏元素多的页面」变成「交白卷」的东西。
   *
   * **这个数来自量过的成本，不是拍的。** 2026-09-08 在真 Chromium 的隔离世界里量
   * （CDP Page.createIsolatedWorld + Runtime.evaluate，与 Electron 的
   * executeJavaScriptInIsolatedWorld 同一条路；Chromium 141 / Apple silicon；
   * 建树后先结算一次 layout 再跑，取 4 次里的中位数）。
   *
   * 先把闸放开量单元素成本。最坏情况是**每个元素都命中选择器、且都是
   * visibility:hidden**（rect 早退那条路走不到，getComputedStyle 每个都真跑）：
   *
   *   候选数            2.5 万   5 万    10 万    15 万    20 万
   *   全是 <a>          17.9ms  35.9ms  77.0ms  116.3ms  155.0ms  → 0.72–0.78µs/元素
   *   全是 <input>      27.9ms  59.0ms  115.4ms                   → 1.12–1.18µs/元素
   *
   * 全 input 那行贵一截，是遍历里那次密码登记（见 rememberIfPassword）每个元素都
   * 要走到底。**取它当预算依据**：预算 = 阻塞渲染进程 0.1 秒，
   * 100ms / 1.18µs ≈ 8.5 万 → 取 8 万。
   *
   * 装上 8 万这道闸之后实测封顶（页面本身有 10 万 / 20 万个节点）：
   * 全 input 95.6ms / 105.6ms，全 <a> 61.6ms / 55.6ms。超出 100ms 的那一点是
   * `querySelectorAll('*')` 物化整棵树本身 —— 那一步没有上界（见 scan 上面那段
   * 取舍说明），但它是一次 C++ 侧遍历，20 万节点也就 ~10ms。
   *
   * 对照组：display:none 的菜单（rect 早退，getComputedStyle 根本不跑）2 万条
   * 只要 7.6ms、6 万条 26.3ms。而**早先那道 MAX_EXAMINED = 2000 挡下的是约 1.5ms**
   * （1500 条 0.6ms、3000 条 1.4ms），代价是 3000 条起整页返回 nodes: []。
   */
  const MAX_WALKED = 80000;

  /** 一次性的框计数选择器。不穿透（本期拍板），只数。 */
  const FRAME_SELECTOR = 'iframe,frame';

  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,' +
    '[role],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const HEADINGS = 'h1,h2,h3';
  const SELECTOR = INTERACTIVE + ',' + HEADINGS;

  const tagOf = (el) => (el.tagName ? el.tagName.toLowerCase() : '');

  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = tagOf(el);
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

  /**
   * 文本上限。超了要带记号，而且**记号里带原长** —— 照 extract 那批定的规矩
   * （少了这个数，模型看到一条带截断记号的值，无从判断丢了 5 个字符还是 5 万个）。
   *
   * 静默截断在本批之前无害（value 采了不用）；本批第一次让 value 进渲染与 diff 判据，
   * 从此它会说谎：agent 往高级检索框打一条 200 字的检索式，快照回显前 160 字、
   * 一个记号都没有，模型无从判断落进去的是全串还是被站点截了。
   */
  const MAX_TEXT = 160;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…[截断，原长 ${s.length} 字符]` : s);

  // 可读名字的取值顺序照无障碍那一套：aria-label → aria-labelledby → alt/title →
  // placeholder → 可见文本。不取 value —— 见下面密码判据那段。
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

  // ── 密码判据 ──────────────────────────────────────────────────────────────
  //
  // 判据必须基于「这个框是不是**用来收密码的**」这个持久事实，不能只看
  // 「此刻 type 属性等于什么」这个瞬时值：用户在校园 IdP 上手输密码后点一下
  // 「显示密码」的眼睛图标，站点就把 input 的 type 从 password 改成 text
  // （北大 iaaa 一类登录页常见）—— 只认瞬时 type 的话，下一次快照就把**明文密码**
  // 当普通 value 送进工具结果、模型上下文与 transcript，而 actions.ts 那条
  // 「不许往密码框打字」的硬闸也因为 isPassword=false 跟着放行。
  //
  // 四条判据，任一成立即算密码框（fail-closed）：
  //  1. 此刻 IDL type 就是 password —— 浏览器已归一大小写与未知 type，这里再
  //     toLowerCase 一次是为了替身/未来改动也别在大小写上翻车；
  //  2. 这个元素**曾经**是 password（记在隔离世界的 WeakSet 里，页面读不到也改不了）。
  //     type 被改回 text 之后，这条是唯一还站得住的事实；
  //  3. autocomplete 声明了 current-password / new-password —— 站点自己声明的用途，
  //     它不随「显示密码」变化。按空白切 token、归一大小写：写成
  //     "Section-Blue NEW-PASSWORD" 也照样认得出；
  //  4. **补充判据，不是主判据**：name / id 里出现 password / passwd / pwd。
  //     单靠名字就是启发式 proxy，所以它只当第 4 条兜底（管的是「页面一加载就是
  //     明文态、站点又没写 autocomplete」那种）。方向是 fail-closed：误判的代价只是
  //     这个框的值不显示、agent 不许往里打字，而 agent 本来就不填账密（spec §4.6）。
  //
  // ── 已知边界（写窄了会让后面几批以为这条路已经堵死）─────────────────────────
  //
  // 这份记忆只覆盖 **walker 至少走到过它一次、而那一次它还是 password 态** 的元素。
  // 漏在外面的是「这个文档从头到尾没有一次快照见过它是 password」，两种走法：
  //
  //  a. 站点在**任何一次快照之前**就把 type 改掉了 —— 需求书 B1 逐字写的正是这条：
  //     用户在校园 IdP 上手输密码后点「显示密码」，agent **随后**才第一次取快照。
  //     用户手动登录时（§4.6「其余登录场景交给人」），这个文档里可能压根没有过
  //     一次 password 态的快照；
  //  b. 站点**换掉整个元素**（新建 <input type=text> 再把值搬过去，老 IE 不能改 type，
  //     一批 jQuery「显示密码」插件一律这么干）—— WeakSet 的记忆跟着旧元素作废。
  //
  // 这两种只剩判据 3/4 兜底：写了 autocomplete=current-password 的不漏，
  // 名字里带 pwd 字样的不漏，**两样都没有就会漏**（实测：
  // `<input type=password name=j_pass id=input-42 autocomplete=off>` 被 replaceWith
  // 成 text 之后明文进快照）。换 CDP 的 AX 树也解不了 —— 新元素就是新元素。
  //
  // 真正堵死要在隔离世界里装一个 **document-start 的常驻登记**（每次 dom-ready
  // 先跑一遍只做登记的脚本，或一个只做登记的 MutationObserver），让「这个元素曾经是
  // password」这件事在**任何快照之前**就被记下来。那是注入时机的事，属于第六批
  // （browserService 的生命周期），walker 一次性执行解不了。
  //
  // 本批已经把这一侧能拿到的都拿了：登记从 collect() 挪到了**遍历**里 ——
  // collect 只处理「当次可见且采到」的元素，于是首次快照时 display:none 的密码框
  // （多步登录 / 折叠面板）在显形时已经是 text，明文照样进快照；排在 MAX_NODES
  // 之后的密码框同理。遍历见过就登记，这两条就堵住了。
  const PW_NAME_RE = /(password|passwd|pwd)/i;
  const PW_AUTOCOMPLETE = ['current-password', 'new-password'];
  /**
   * 判据 3/4 只对**装得下用户打进去的文本**的控件成立。
   * `<input type=submit name=passwordSubmit value=登录>` 这类的 value 是它按钮上
   * 印的字、也是它**唯一的可见标签**（nameOf 不取 value）—— 当密码值抹掉之后
   * 渲染成 `[N] submit "" (密码框，值不显示)`，模型看不见按钮上写的是什么。
   * 空串是「没有 type 属性」那种（IDL 上会归一成 'text'，替身里可能没设）。
   */
  const PW_VALUE_TYPES = ['', 'text', 'password', 'search', 'tel', 'url', 'email', 'number'];

  /**
   * 遍历这一层的登记：**只记「此刻 type 就是 password」这一条**。
   *
   * 它是四条判据里唯一**会消失**的那条 —— 站点把 type 改成 text，或者这个框在
   * 首次快照时还是 display:none（多步登录 / 折叠面板），信号就没了。判据 3/4
   * （autocomplete / 名字）是元素自己身上的属性，随便哪一次快照都还读得到，
   * 记它们只是白花钱：给每个表单控件多三次 getAttribute + 一次 split，实测
   * 10 万个 input 的页面从 81ms 涨到 144ms。
   */
  const rememberIfPassword = (el) => {
    // 这个判断落在**每个走到的元素**上，所以先用最便宜的那道挡：tagName 在
    // Chromium 里是驻留字符串，比对是指针比较；tagOf() 的 toLowerCase() 要为
    // 'SPAN' 这种分配一个新串，摊到十万个元素上就不便宜了。HTML 文档给大写，
    // XHTML 给小写，两个都比一次。
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'input') return;
    const ty = el.type;
    if (typeof ty === 'string' && ty.toLowerCase() === 'password') world.pw.add(el);
  };

  const isPasswordField = (el) => {
    if (world.pw.has(el)) return true;
    // 判据 1/3/4 只对表单控件成立：密码是往输入框里打的，而 value 外泄这条路
    // 也只在这些元素上有。放开到任意元素只会让 <a name="password-reset"> 这种
    // 被标成密码框，白白污染快照。
    const tag = tagOf(el);
    if (tag !== 'input' && tag !== 'textarea') return false;
    const type = typeof el.type === 'string' ? el.type.toLowerCase() : '';

    let hit = false;
    if (type === 'password') hit = true;
    // textarea 的 IDL type 恒为 'textarea'；input 走上面那张表。
    const holdsText = tag === 'textarea' || PW_VALUE_TYPES.indexOf(type) !== -1;
    if (!hit && holdsText && el.getAttribute) {
      const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
      for (const t of PW_AUTOCOMPLETE) if (tokens.indexOf(t) !== -1) hit = true;
    }
    if (!hit && holdsText && el.getAttribute) {
      hit = PW_NAME_RE.test(`${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''}`);
    }
    // 记住它。type 一旦被改成 text，下一次就靠这份记忆。
    if (hit) world.pw.add(el);
    return hit;
  };

  // ── 遍历 ──────────────────────────────────────────────────────────────────

  const out = [];
  let index = 0;
  let walked = 0;
  let matched = 0;    // 命中选择器的候选数（遍历走完了才等于「本页候选总数」）
  let iframes = 0;
  let nodesTruncated = false;   // 写满 MAX_NODES 了：**只是不再往 nodes 里写**，遍历照走
  let walkTruncated = false;    // 撞 MAX_WALKED 了：遍历真的停在半路，后面的一个都没看到

  const collect = (el) => {
    // 降级而不是中止：写满了就不再量 rect / style（layout 的成本就是在这里省下的），
    // 但**遍历继续** —— 页首的隐藏大菜单不许饿死页尾的真控件，iframe 与候选总数
    // 也不许停在半路。
    if (out.length >= MAX_NODES) { nodesTruncated = true; return; }

    let r;
    try { r = el.getBoundingClientRect(); } catch { return; }
    if (!visible(el, r)) return;

    index += 1;
    const name = nameOf(el);
    const node = {
      index,
      nodeId: idOf(el),
      role: roleOf(el),
      name: cut(name),
      // 视口内的 CSS 像素。CDP 的 Input 事件就吃这个单位 ——
      // 按缩放换算过反而打不中（2026-09-08 spike 实测）。
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
    };
    // 「被截过」是协议层事实，单独报出来：记号里的原长能让 diff 认出「200 字变 240 字」，
    // 但两条**只在第 160 字之后**不同、原长又恰好一样的检索式，比截断后的串是比不出来的。
    // 下游得知道自己什么时候只看到了前一段，否则「没有变化」会盖住「看不出来」。
    if (name.length > MAX_TEXT) node.nameTruncated = true;
    // 密码框的 value 一个字都不出去：它会经工具结果进模型上下文、进 transcript。
    if (isPasswordField(el)) node.isPassword = true;
    else if ('value' in el && typeof el.value === 'string') {
      const v = clean(el.value);
      if (v) {
        node.value = cut(v);
        if (v.length > MAX_TEXT) node.valueTruncated = true;
      }
    }
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
    out.push(node);
  };

  // 走 '*' 而不是直接查 SELECTOR：**shadow 宿主自己往往什么都不是**
  // （<search-box> 无 role、无 tabindex，真正的 input 在 shadow 里）。
  // 只在命中 SELECTOR 的元素上递归的话，整棵 shadow 树看不见，而快照里没有输入框
  // 这件事对模型来说跟「这个站点没有检索入口」长得一样。
  //
  // 代价与边界：'*' 会把整棵树物化成一份 NodeList，这一步本身没有上界 ——
  // 有上界的是**它后面每个元素要做的事**（MAX_WALKED 管 matches + shadowRoot，
  // MAX_EXAMINED 管强制 layout 的那两个调用）。一次 C++ 侧的树遍历比几万次
  // getComputedStyle 便宜几个量级，这是刻意的取舍，不是漏了一道闸。
  const scan = (root) => {
    // 本期不穿透 iframe（拍板），但「本页有几个 iframe」是协议层事实 —— 不报出来的话，
    // 「页面没渲染出来」「被拦截页挡住」「内容在 iframe 里」这三件事在模型眼里长得一样。
    //
    // 数框走**一次独立的便宜查询**，放在循环之前：早先是在循环里逐个 tag 比对，
    // 于是撞上限提前 return 时框只数到半路（实测：400 个链接在前、2 个 iframe 在后
    // → iframes: 0，渲染层的 iframe 附注挂在 iframes > 0 上，一个字都不提 ——
    // 需求书 §F 那条 CNKI 正是这个形状）。放在这里，MAX_NODES 就影响不到它了。
    try { iframes += root.querySelectorAll(FRAME_SELECTOR).length; } catch { /* 数不到就算了 */ }

    let els;
    try { els = root.querySelectorAll('*'); } catch { return; }
    for (let i = 0; i < els.length; i++) {
      if (walkTruncated) return;
      if (walked >= MAX_WALKED) { walkTruncated = true; return; }
      walked += 1;

      const el = els[i];

      // 密码记忆的登记在**遍历**这一层，不在 collect 里：collect 只处理「当次可见
      // 且采到」的元素，于是首次快照时 display:none 的密码框（多步登录 / 折叠面板）、
      // 以及排在 MAX_NODES 之后的密码框，都不会被记住 —— 等它们显形时站点已经把
      // type 改成 text，明文就进快照了。遍历见过它是 password，就该记下来。
      rememberIfPassword(el);

      let ok = false;
      try { ok = typeof el.matches === 'function' && el.matches(SELECTOR); } catch { ok = false; }
      if (ok) { matched += 1; collect(el); }

      // open shadow root 里的控件在很多组件库里就是全部控件。closed 的看不见，
      // 那是这条路的已知边界（换 CDP 的 AX 树可解）。
      let sr = null;
      try { sr = el.shadowRoot; } catch { sr = null; }
      if (sr) scan(sr);
    }
  };

  scan(document);

  // 截断必须显式回报，且**数不出来的数就不要编一个**（extract 那批定的规矩）。
  //
  // 两个事实分开报，互不冒充：
  //  · `limit` / `limitValue` 说的是**哪一道闸**、那道闸自己的数（不许拿另一层的数顶）。
  //    两道都撞到时报 walked：「走都没走完」蕴含「后面的元素连看都没看到」，是更严重的
  //    那一条；只报 nodes 会让模型以为整页都走过了。
  //  · `totalKnown` 说的是**本页候选总数**。降级不中止之后，撞 MAX_NODES 也能把候选
  //    走完，这个数就是真的 —— 只有遍历自己停在半路时才根本不给这个键（不填 0，
  //    也不拿 returned 冒充）。
  const collection = { truncated: nodesTruncated || walkTruncated, returned: out.length };
  if (walkTruncated) {
    collection.limit = 'walked';
    collection.limitValue = MAX_WALKED;
  } else {
    if (nodesTruncated) {
      collection.limit = 'nodes';
      collection.limitValue = MAX_NODES;
    }
    collection.totalKnown = matched;
  }

  return {
    generation: world.gen,
    url: location.href,
    title: document.title,
    nodes: out,
    collection,
    iframes,
  };
})();
