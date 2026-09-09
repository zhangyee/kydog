# 百度学术

中英文混合检索的发现层，中文覆盖好、结果质量参差，对接文献传递。**没有官方 API**。

---

## 侦察状态

**2026-09-08 侦察，结果页结构已采到。** 仍有一处缺口：**从首页交互提交搜索这一步没跑通**
（Enter 不触发提交，`.send-btn` 点击也没生效），下面的检索剧本因此是未验证的。结果页本身
是打开的真实页面，选择器都从它的 DOM 上读下来。

一处修正：我最初打的是 `/s?wd=...`（旧版路径），返回 403 + 人机验证；**新版结果页在
`/ndscholar/browse/search?wd=...`**。走页面交互不会走错端点，拼 URL 才会 —— 这正是「一切走
交互」这条规矩的由来。

---

## 操作方式：交互式

**一切操作都在页面上做。** 对这个源尤其如此 —— 首页**没有任何 `<form>` 元素**（实测），检索
完全由 JS 驱动，本来就没有可拼的表单 URL。

`browser_act` 一次调用装一串动作，探明之后用 `selector` 定位就是一段可以照抄的剧本。

### 剧本：首页检索（部分已探明）

```jsonc
browser_open({ url: "https://xueshu.baidu.com/" })
browser_act({ tabId: "<上一步的 tabId>", actions: [
  { "kind": "type",  "selector": "textarea.search-input", "text": "<检索词>" },
  { "kind": "click", "selector": ".send-btn" },
  { "kind": "wait",  "until": { "selector": "div.paper-wrap.result", "state": "present" } }
]})
```

**那个 `wait` 不是保险，是必需的。** 这个源的检索**不产生主 frame 导航**（SPA 换的是路由），所以工具层没有任何导航终态可等；不显式等结果条目出现，紧接着的 `extract` 就在旧 DOM 上跑，抽到的是上一页 —— **而且不报任何错**。

**收尾快照也不等。** 一批跑完最后一步就立刻取「── 页面变化 ──」（`references/browser.md`
§五末尾）。这个源不产生主 frame 导航，所以那一段的新旧完全取决于上面那个 `wait`：
等到了就是真换了；超时就是条件没成立，按「出错即停」处理 —— **不要**因为「页面变化」
看起来没动就再点一次提交。

`type` 带 `selector` 时会先聚焦该元素，不必额外加一个 `click`。**它还会先全选清空**：
清不掉就明确报错、一个字都不打（不会追加在原有内容后面）—— 中途复用一个已经有内容的框时
可能撞上 `browser.target_unusable`，那不是选择器写错了。

**侦察时 Enter 没能提交**（Scholar 也一样）—— 那是侦察工具发按键的方式问题（CDP 的
`keyDown` 不带 `text` 就不产生 `keypress`，而 Chromium 的表单隐式提交发生在 `keypress`）。
本项目的按键表已经给 `Enter` 带上了 `text`，**这条结论已经作废**，别再当成开放问题背着。
不过这个源的首页**没有 `<form>`**，隐式提交本来就无从谈起：提交仍然要点 `.send-btn`。

点发送按钮 `.send-btn` 是首选的那条路，**但本次侦察它没跑通**（见上「侦察状态」——
两段剧本的提交步骤本次都没成功过），别当成已验证的一步。它在输入框有内容之前 class 是
`send-btn disable`，有内容后变成 `send-btn` —— 这个变化可当「可以提交了」的判据，
也是 `wait` 动作的好条件。侦察用的另一套工具链里它**没有出现在无障碍树里**；本项目 walker
的纳入集更宽（带 `role` / `onclick` / `tabindex` 的 `div` 也进快照），**别预设快照里一定
没有它** —— 但剧本本来就一律用 `selector`，这一条与它在不在快照里无关。

**`type` 一律走文本插入（`Input.insertText`），不产生 `keydown`，也不按字符类分支** ——
中文检索词与英文检索词走的是**同一条路**，没有「英文是安全路径」这回事。
「有内容后按钮变可用」如果靠 `keydown` 触发，那么**任何**检索词打进去按钮都可能不会变可用；
重验时要确认，遇到按钮没变可用就先取一眼快照再点。

### 剧本：高级检索（部分已探明）

高级检索是个对话框，要先点开再填：

```jsonc
browser_act({ tabId: "<上一步的 tabId>", actions: [
  { "kind": "click", "selector": "<「高级检索」按钮，见下方说明>" },
  { "kind": "wait",  "until": { "selector": "#advanced-search-all", "state": "present" } },
  { "kind": "type",  "selector": "#advanced-search-all",    "text": "<全部检索词>" },
  { "kind": "type",  "selector": "#advanced-search-author", "text": "<作者>" },
  { "kind": "click", "selector": "<「确认」按钮，见下方说明>" },
  { "kind": "wait",  "until": { "selector": "div.paper-wrap.result", "state": "present" } }
]})
```

**这两个 `wait` 与首页剧本里那个是同一条规则**（这个源的 `click` 不产生主 frame 导航，
所以每一次 `click` 之后都要自己给条件）。少了第一个，`type` 会与「打开对话框」那一下同时
解析目标 —— 那一刻 `#advanced-search-all` 还不存在，报的是
`browser.target_unusable`「在当前页面上没有匹配」，而选择器本身是对的，照着去换选择器就是
在死路上打转。少了第二个，紧接着的 `extract` 在旧 DOM 上跑。

**两段剧本的提交步骤本次都从未成功过**（提交后 403 + 人机验证，见下）。输入框的选择器是从
首页 DOM 上读下来的、真实存在；提交后能不能到结果页没有被验证。

**不要在剧本里写 `index`。** 快照编号换一次会话就漂；`index` 只在探索期用，探明后一律换成
`selector`。

## 可达性（实测）

| 端点 | 结果 |
| --- | --- |
| `https://xueshu.baidu.com/`（首页） | **200**，正常渲染，标题「百度学术 - 保持学习的态度」 |
| 搜索端点 | **403**，人机验证页 |

## 拦截页指纹（实测）

```
HTTP 403
document.title === '百度安全验证'
正文含「校验失败，请再试一次」与「请依次点击…」
```

**这是可交互的点选验证码，人能解开** —— 与 Google Scholar 的静态硬拦不同。

所以正确反应是**调 `ask_user_question` 交给用户**（带上 `browserTabId`，侧栏会自动展开到这个
标签），提示他完成验证。用户点完，cookie 落进持久 partition，后续检索复用同一个会话。

挂起期间**不要读页面**，也不要替用户点任何东西。

判据用工具结果里那句 `HTTP 403`（导航结论那一行会写「但服务器返回 HTTP 403」）；
**没有一个叫 `httpStatusCode` 的字段给你读** —— 状态码只以这句散文的形式出现。
是否可交互看快照里有没有可点的验证控件。

**检索提交之后才 403 的那一次**（可达性表：首页 200、搜索才 403）不在那一批的返回值里 ——
它挂在**下一次**工具结果**头部**那行 `导航: [tab_…]`，只报一次、报过就清。

## 页面上有哪些控件（实测，读的是首页 DOM）

**主搜索框是 `<textarea>`，不是 `<input>`**：

```
textarea.atomic-textarea-box.search-input     无 name、无 id
```

只能靠 class、或快照里的 role / 位置认出来。**不要按 `input[name=...]` 找它**。

**高级检索是一个对话框**：先点「高级检索」按钮打开，再逐个填字段。字段 id 语义化且稳定：

| id | 含义 | 备注 |
| --- | --- | --- |
| `#advanced-search-all` | 包含全部检索词 | |
| `#advanced-search-precise` | 精确匹配 | 占位文字「多个检索词以，分隔」 |
| `#advanced-search-or` | 包含任一检索词 | 同上 |
| `#advanced-search-not` | 不含检索词 | 同上 |
| `#advanced-search-author` | 作者 | |
| `#advanced-search-affs` | 机构 | |
| `#advanced-search-publication` | 期刊 | |
| `#advanced-search-year-start` / `#advanced-search-year-end` | 年份区间 | |

对话框里还有三个 `input.ant-radio-input` 单选项，**本次没确认它们的含义**，用之前要先看快照。

提交按钮文案是「确认」，取消是「取消」。**这两个按钮和「高级检索」按钮都没有 id**，class 是
一串 `atomic-button atomic-md atomic-button-primary …` 的组合 —— 剧本里用文案定位比用 class
稳（class 是组件库生成的，改版会变）。具体怎么写等补齐侦察时按实际快照定。

**页面上可能弹授权对话框**：本次在首页 DOM 里见到「继续使用」/「取消授权」两个按钮。没有实际
触发过，遇到时按快照实际内容处理，不要预设它一定出现。

首页导航里有一项**「旧版入口」**，疑似通向经典结果页；本次没定位到它的元素形态（不是 `<a>`），
也没点开过。补齐侦察时值得先试它 —— 经典页面通常比新版 SPA 更好抽。

## 结果页怎么抽（实测）

结果页 URL 形态 `https://xueshu.baidu.com/ndscholar/browse/search?wd=<检索词>`，**每页 10 条**。

条目容器：`div.paper-wrap.result`（完整 class 是 `paper-wrap result xpath-log`）。

一条的内部结构：

| 字段 | 选择器 | 说明 |
| --- | --- | --- |
| 标题 | `h3.paper-title a` | 文本即标题 |
| 详情页 | `h3.paper-title a@href` | 形如 `/usercenter/paper/show?paperid=<id>` |
| 摘要片段 | `div.paper-abstract` | 命中词被 `<em>` 包着，取 `innerText` 即可 |
| 类型 | `div.paper-info span.paper-type` | 「期刊」/「学位」/「会议」等 |
| 元信息整行 | `div.paper-info` | 形如 `期刊 梁彤祥， 刘娟， 王晨 - 《材料工程》 - 被引量：33 - 2014年` |
| 被引量 | `div.paper-info a[href*="refpaper"]` | 只有数字；「被引量：」在同级 span 里 |
| 期刊 | `div.paper-info a[href*="/usercenter/data/journal"]` | |
| 作者 | `div.paper-info a[href*="wd=author"]` | 多个 |
| **全文入口** | `div.paper-source a@href` | **多个**，这是拿全文的关键 |

`div.paper-source` 是这个源最有价值的一块 —— 它把同一篇论文在各处的入口并排列出来。实测一条
里同时有：期刊官网（`jme.biam.ac.cn/...`）、国家科技图书文献中心（`nstl.gov.cn`）、iAcademic、
万方（`d.wanfangdata.com.cn`）、知网（`cnki.com.cn`）。

**取全部 `a` 再按域名挑**，不要只取第一个 —— 排在前面的不一定是能直接下到 PDF 的那个。

## 怎么翻页：本期不翻，只取第 1 页

**这个源本期只取结果页的第 1 页**（每页 10 条）。抽完第 1 页就收工，不要试图翻页。

**为什么降级**：翻页控件 `div.pagination-wrap > div.pagination` 里，页码是 `div.page`、
当前页是 `div.page.active`，而「上一页」与「下一页」**共用同一个 class `div.page.n`**，
只能靠文本区分；而 `browser_act` 的 `selector` 是**纯 CSS**
（页内走 `querySelector`），**没有 `:contains()` / `:has-text()` 这类按文本匹配的写法**。
于是两条路都是死的：写 `div.page.n:contains("下一页")` 会被判成非法选择器
（「不是合法的 CSS 选择器」，`browser.bad_action`）；写裸 `div.page.n` 取到的是**第一个**、
也就是「上一页」，点下去是**往回翻**。这些控件还全是没有 `href`、没有 role 的 `div`；
侦察用的另一套工具链里它们没有进无障碍树，本项目 walker 的纳入集更宽
（`[role]` / `[onclick]` / `[tabindex]` 都收），进不进快照要看实际页面 ——
**但剧本里本来就不写 `index`**（编号换一次会话就漂），所以那条路一样不是出路。
**要开翻页，先得对着真站点量出一个只命中「下一页」的 CSS 表达** —— 见「补齐程序」第 3 条。

抽第 1 页，抽完这一次就结束这个源：

```jsonc
{ "kind": "extract", "selectors": {
    "item": "div.paper-wrap.result",
    "title": "h3.paper-title a",
    "detail": "h3.paper-title a@href",
    "info": "div.paper-info",
    "sources": "div.paper-source a@href"
}}
```

**所以这个源本期最多给到 10 条。** `SKILL.md` §三 的「一个源最多 3 页」是通用上限，
在百度学术这里实际只有 1 页 —— 这是本期的已知局限，不是抽漏了。要更多结果就收窄检索词
重搜一次，别拿翻页去凑数。

## 全文入口怎么处理：报告，不下载

**这个源在本期只做检索，不取全文。** 浏览器没有下载工具，页面自己触发的下载也会被一律拒绝。

`div.paper-source a@href` 给的是一组**外部站点**入口，不是 PDF 直链。实测见到的域名有
`nstl.gov.cn` / `d.wanfangdata.com.cn` / `cnki.com.cn` / `iacademic.info` / 期刊官网。
**把这组链接原样报给用户**，让他自己挑一个去开。

这些站点大多需要机构订阅 —— **机构账号（CARSI）登录本期就有**，见 `references/carsi.md`。
但**登录之后本期仍然不下载**：拿到订阅访问权也只是把链接报给用户，下载通道是下一期的事。

左侧筛选面板有「获取方式 → 免费下载」一项（实测那次检索下有 4679 条）。**先按它筛**，报出去
的链接才更可能是用户点开就能看的。

## 什么时候必须交给人

- **403 + 「百度安全验证」点选验证码** —— 这是主要场景，见上
- 需要登录的功能（收藏、文献互助等）
- 其余按 `references/browser.md` 的交接规则

## 已知局限

- 无官方 API；检索动作对被判定为自动化的出口 403 + 人机验证
- 结果质量参差，同一篇论文可能有多条重复记录
- 很多条目走文献传递而非直链，拿不到 PDF 是常态，不是故障

---

## 补齐程序

1. **侦察**：在真实浏览器里交互式搜一次（必要时人工过一次验证码），打开结果页，读出条目容器、
   标题、作者/年/来源、被引数、全文/文献传递入口各自的选择器，以及翻页控件的形态。顺便试
   「旧版入口」那条路
2. **验证**：用本项目的 `browser_act` 的 `extract` 动作把每一条选择器真跑一遍，跑不通的改掉，
   并把「开首页 → 检索 → 抽第 1 页」连成一个能一次跑通的剧本
3. **开翻页**（本期降级掉的那一步，理由见「怎么翻页」）：
   - 先量出一个**只命中「下一页」、不命中「上一页」的纯 CSS 表达**。两者共用 `div.page.n`，
     而 `selector` 走页内的 `querySelector`、没有文本匹配可用 —— 只能从结构位置
     （`div.pagination > div.page.n:last-of-type` 之类）或只出现在其中一个上的属性下手，
     **必须在真页面上实测确认它精确命中 1 个**，别照猜的写进剧本
   - 再一并采出一个**「点击前不成立、翻页后成立」的等待条件**。`div.page.active` 那种
     「当前页」标记**不行** —— 它点击前就已经成立，而 `wait` 是先探一次再等，会立刻回
     「等到了」、一毫秒都没等（`references/browser.md` §五）。Scholar 那边指的方向值得
     在这里也试一次：结果页地址里表示页码/偏移的那一段用 `urlMatches` 判
     （它判的是主进程手里的地址、不进页面，见 `references/scholar.md`）——
     **但这个源换页时地址变不变，本期没测过**，得实测
   - 这一步做完之前，`SKILL.md` §三 的「一个源最多 3 页」在这个源上实际只有 1 页

第 2 步不能省：两套工具看到的 DOM 不一定一样。
