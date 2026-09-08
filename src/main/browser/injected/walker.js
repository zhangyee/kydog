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

  // ── 三道上限 ──────────────────────────────────────────────────────────────
  // 三个数管的是三种不同的成本，撞到哪一道都要如实回报（spec §5.5）。

  /** 写进快照的条数上限。容量保护，不参与任何语义判断。 */
  const MAX_NODES = 300;

  /**
   * 可见性判断的上限。每判一条都要 getBoundingClientRect + getComputedStyle，
   * 两者都**强制 layout**；nameOf 兜底到 innerText 时还要再来一次。
   * 只截「输出」不截「判断」的话，一个带巨型 display:none 菜单的站点会让采集脚本
   * 在凑够 300 条可见元素之前先把上万个不可见元素逐个量一遍，页面渲染进程卡死数秒
   * ——而执行侧没有超时，browser_open 只能干等。
   */
  const MAX_EXAMINED = 2000;

  /**
   * 遍历本身的上限（走过的元素数）。摊在这上面的是每个元素一次 matches() 与一次
   * shadowRoot 读取 —— 单次便宜，几万节点的大目录页乘起来就不便宜了。
   */
  const MAX_WALKED = 25000;

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

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 160);

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
  // 已知边界：站点如果**换掉整个元素**（新建一个 <input type=text> 再把值搬过去），
  // WeakSet 里的记忆跟着旧元素作废，这时只剩 3 / 4 两条。换 CDP 的 AX 树也解不了
  // 这一条 —— 新元素就是新元素。
  const PW_NAME_RE = /(password|passwd|pwd)/i;
  const PW_AUTOCOMPLETE = ['current-password', 'new-password'];

  const isPasswordField = (el) => {
    if (world.pw.has(el)) return true;
    // 判据 1/3/4 只对表单控件成立：密码是往输入框里打的，而 value 外泄这条路
    // 也只在这些元素上有。放开到任意元素只会让 <a name="password-reset"> 这种
    // 被标成密码框，白白污染快照。
    const tag = tagOf(el);
    if (tag !== 'input' && tag !== 'textarea') return false;

    let hit = false;
    if (typeof el.type === 'string' && el.type.toLowerCase() === 'password') hit = true;
    if (!hit && el.getAttribute) {
      const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
      for (const t of PW_AUTOCOMPLETE) if (tokens.indexOf(t) !== -1) hit = true;
    }
    if (!hit && el.getAttribute) {
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
  let examined = 0;   // 真的量过 rect / style 的候选数
  let matched = 0;    // 命中选择器的候选数（走完了才等于「本页候选总数」）
  let iframes = 0;
  /** 撞到的是哪一道上限。null = 一道都没撞到，这时候选总数才数得出来。 */
  let hitLimit = null;

  const collect = (el) => {
    if (out.length >= MAX_NODES) { hitLimit = hitLimit || 'nodes'; return; }
    if (examined >= MAX_EXAMINED) { hitLimit = hitLimit || 'examined'; return; }
    examined += 1;

    let r;
    try { r = el.getBoundingClientRect(); } catch { return; }
    if (!visible(el, r)) return;

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
    if (isPasswordField(el)) node.isPassword = true;
    else if ('value' in el && typeof el.value === 'string' && el.value) node.value = clean(el.value);
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
    let els;
    try { els = root.querySelectorAll('*'); } catch { return; }
    for (let i = 0; i < els.length; i++) {
      if (hitLimit) return;
      if (walked >= MAX_WALKED) { hitLimit = 'walked'; return; }
      walked += 1;

      const el = els[i];
      const tag = tagOf(el);
      // 本期不穿透 iframe（拍板）。但「本页有几个 iframe」是采集时顺手就数得出的
      // 协议层事实 —— 不报出来的话，「页面没渲染出来」「被拦截页挡住」
      // 「内容在 iframe 里」这三件事在模型眼里长得一模一样。
      if (tag === 'iframe' || tag === 'frame') iframes += 1;

      let ok = false;
      try { ok = typeof el.matches === 'function' && el.matches(SELECTOR); } catch { ok = false; }
      if (ok) { matched += 1; collect(el); }
      if (hitLimit) return;

      // open shadow root 里的控件在很多组件库里就是全部控件。closed 的看不见，
      // 那是这条路的已知边界（换 CDP 的 AX 树可解）。
      let sr = null;
      try { sr = el.shadowRoot; } catch { sr = null; }
      if (sr) scan(sr);
    }
  };

  scan(document);

  // 截断必须显式回报，且**数不出来的数就不要编一个**（extract 那批定的规矩）：
  // 撞上限提前停手时，「本页一共有多少个候选元素」这个数根本没数完 ——
  // 那就不给 totalKnown 这个键，不填 0，也不拿 returned 冒充。
  const collection = { truncated: hitLimit !== null, returned: out.length };
  if (hitLimit) {
    collection.limit = hitLimit;
    collection.limitValue =
      hitLimit === 'nodes' ? MAX_NODES : hitLimit === 'examined' ? MAX_EXAMINED : MAX_WALKED;
  } else {
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
