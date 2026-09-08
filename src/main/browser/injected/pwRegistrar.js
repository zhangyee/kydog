// 这段代码在**网页里**执行，不是主进程。它不能 import 任何东西。
//
// 常驻密码登记。跑在 **walker 的同一个隔离世界**里（browserService 的 WALKER_WORLD_ID），
// 写的是 walker 的**同一份** `world.pw` —— 拆成两个世界或两份 WeakSet 就等于各写各的，
// walker 读不到这里记下的东西。
//
// 为什么单独有它：walker 只在取快照那一刻跑一次，而密码明文外泄发生在
// **这个文档的第一次快照之前**（walker.js 的「已知边界」a）——
// 用户在校园 IdP 上手输密码、点一下「显示密码」的眼睛图标，站点把 input 的
// type 从 password 改成 text；agent 随后才第一次取快照，那时协议层已经没有
// 「它是密码框」这个事实了，明文会进工具结果、模型上下文与 transcript。
//
// **登记不受任何遍历上限约束**（第四批交下来的验收标准，逐字）：这里不走 walker 的
// `scan()`，不经过它的 walked 计数，`MAX_WALKED`（以及将来任何新增的遍历/成本上限）
// 都不限制它能登记到的元素范围。所以查的是 `getElementsByTagName('input')` 而不是
// `querySelectorAll('*')`：只在表单控件上花钱，页面有几十万个元素也不必设闸。
//
// ── 已知边界，别写窄了 ──────────────────────────────────────────────────────
//
//  · **换掉整个元素**（新建 <input type=text> 再把值搬过去；老 IE 不能改 type，
//    一批 jQuery「显示密码」插件一律这么干）仍然堵不住：新元素从来没有过 password
//    态，MutationObserver 看到的只是「一个 text input 被插进来」。这条只剩 walker
//    判据 3/4（autocomplete / 名字）兜底，两样都没有就会漏。**这不是已经解决的**。
//  · **shadow 树里的密码框**：`getElementsByTagName` 与 MutationObserver 都不穿透
//    shadow root。走到那里的仍然只有 walker 的遍历（它递归 open shadow root），
//    也就仍然受 MAX_WALKED 约束。
//  · **document-start 的严格含义**：Electron 里真正的 document-start 注入要 preload
//    脚本，而 spec §5.1 的硬化契约明写「无 preload」。`dom-ready` 是不违反那条契约的
//    最早时机 —— 站点在 DOMContentLoaded 之前就把 type 改掉的话，这个文档里从来
//    没有过可观测的 password 态，任何一侧都记不到。
(() => {
  const W = window;

  // 世界对象的形状与初值必须与 walker.js 里那份**逐字一致**：谁先跑谁建，另一个
  // 原样接手。尤其是 `gen` —— walker 拿 `world.gen` 当快照的世代标识，这里建一个
  // 没有 gen 的世界，walker 就会报 `generation: undefined`，而 renderDiff 的判据是
  // `prev.generation !== next.generation`：两份都 undefined 就相等，跨文档的两批
  // nodeId 会被逐条配对，输出「页面没有变化。」而页面整个换了。
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

  const world = W.__kydogWorld || (W.__kydogWorld = {
    gen: randomId(),
    next: 1,
    ids: new WeakMap(),
    pw: new WeakSet(),
  });

  // 判据与 walker 的 `rememberIfPassword` 是**同一条**：此刻 IDL type 就是 password。
  // 它是四条判据里唯一**会消失**的那条，也就是唯一需要提前记住的那条；
  // autocomplete 与名字那两条是元素自己身上的属性，随便哪一次快照都还读得到。
  // 两边漂移由 browserService.test.ts 的差分用例守着（同一份替身 DOM 喂给两个脚本，
  // 登记结果必须逐个元素相等）。
  const remember = (el) => {
    if (!el) return;
    // 先用最便宜的那道挡：tagName 在 Chromium 里是驻留字符串，比对是指针比较。
    // HTML 文档给大写，XHTML 给小写，两个都比一次。
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'input') return;
    const ty = el.type;
    if (typeof ty === 'string' && ty.toLowerCase() === 'password') world.pw.add(el);
  };

  const rememberTree = (node) => {
    if (!node || node.nodeType !== 1) return;
    remember(node);
    if (typeof node.getElementsByTagName !== 'function') return;
    const nested = node.getElementsByTagName('input');
    for (let i = 0; i < nested.length; i++) remember(nested[i]);
  };

  // ① 当场全量登记一次。dom-ready 时页面上已经有的密码框在这一步全部记下，
  //    此后站点怎么改 type 都不影响这份记忆（WeakSet 在隔离世界里，页面读不到也改不了）。
  const now = document.getElementsByTagName('input');
  for (let i = 0; i < now.length; i++) remember(now[i]);

  // ② 常驻观察：后插入的（多步登录的第二屏、折叠面板）、以及 type 被改掉的。
  //    **一个文档只装一个**：dom-ready 在同一个文档里可能不止来一次
  //    （子 frame 的 dom-ready 也会把主进程那条监听器打起来），装重了每次改动
  //    都要多跑一遍回调。
  //
  //    **MutationObserver 从 `W` 上取，不读裸全局**：脚本注进的是页面的那个隔离世界，
  //    「有没有 MutationObserver」是那个 window 的事实。读裸全局在真浏览器里碰巧也对
  //    （作用域链兜到同一个 window），但它把这一整段变成测不到的：替身 window 里塞
  //    什么都看不见，观察器压根建不起来，改坏了一条用例都不会红。
  const MO = W.MutationObserver;
  if (!world.pwObserver && typeof MO === 'function') {
    world.pwObserver = new MO((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          // `oldValue === 'password'` 是**协议层事实**：这一刻我们亲眼看到它此前
          // 是密码框。站点把 type 从 password 改成 text 时，元素当下的 type 已经
          // 是 text 了 —— 只看当下的话，插入与改写发生在同一个任务里的那种
          // （MutationObserver 的回调是微任务批处理，两条记录一起到）就漏了。
          const old = typeof r.oldValue === 'string' ? r.oldValue.toLowerCase() : '';
          if (old === 'password' && r.target) world.pw.add(r.target);
          remember(r.target);
        } else if (r.type === 'childList' && r.addedNodes) {
          for (let i = 0; i < r.addedNodes.length; i++) rememberTree(r.addedNodes[i]);
        }
      }
    });
    world.pwObserver.observe(document.documentElement || document, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['type'], attributeOldValue: true,
    });
  }

  // 返回值只为让主进程能把「登记跑起来了没有」记进日志；不含任何页面内容。
  return { registered: true, scanned: now.length, observing: !!world.pwObserver };
})();
