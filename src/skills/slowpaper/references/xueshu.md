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

`type` 带 `selector` 时会先聚焦该元素，不必额外加一个 `click`。

**侦察时 Enter 没能提交**（Scholar 也一样）—— 但那多半是侦察工具发按键的方式问题（CDP 的
`keyDown` 不带 `text` 就不产生 `keypress`，而 Chromium 的表单隐式提交发生在 `keypress`），
**待重验**，别当成站点事实。

点发送按钮 `.send-btn` 是确定可行的那条路。它在输入框有内容之前 class 是 `send-btn disable`，
有内容后变成 `send-btn` —— 这个变化可当「可以提交了」的判据，也是 `wait` 动作的好条件。
注意它**在无障碍树里不出现**，只能用 `selector`。

**中文检索词还有一层**：`type` 对 ASCII 走按键事件、对 CJK 走 `insertText`，后者不产生
`keydown`。「有内容后按钮变可用」靠哪种事件触发，重验时要确认 —— 如果它监听 `keydown`，
中文词打进去按钮可能不会变可用。

### 剧本：高级检索（部分已探明）

高级检索是个对话框，要先点开再填：

```jsonc
browser_act({ tabId: "<上一步的 tabId>", actions: [
  { "kind": "click", "selector": "<「高级检索」按钮，见下方说明>" },
  { "kind": "type",  "selector": "#advanced-search-all",    "text": "<全部检索词>" },
  { "kind": "type",  "selector": "#advanced-search-author", "text": "<作者>" },
  { "kind": "click", "selector": "<「确认」按钮，见下方说明>" }
]})
```

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

判据用 `browser_open` 返回的 `httpStatusCode`；是否可交互看快照里有没有可点的验证控件。

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

## 怎么翻页（实测）

翻页控件 `div.pagination-wrap > div.pagination`，里面：

- `div.page` —— 页码
- `div.page.active` —— 当前页
- `div.page.n` —— 「上一页」与「下一页」，**两个用同一个 class**，只能靠文本区分

**这些全是 `div`，没有 `href`、没有 role。** 两个后果，都进剧本：

1. 无障碍树里它们不出现 —— 快照里找不到，`index` 定位对它们**不可用**，只能用 `selector`
2. 「下一页」要用文本定位，比如 `div.page.n` 里取 `innerText` 含「下一页」的那个

翻页 + 抽取的剧本。**一页一次 `browser_act`，不要写进 `repeat`** —— 一批里每一轮的等待条件
都是同一个，而「翻到了第几页」逐页不同（`references/browser.md` §五）。

抽当前这一页：

```jsonc
{ "kind": "extract", "selectors": {
    "item": "div.paper-wrap.result",
    "title": "h3.paper-title a",
    "detail": "h3.paper-title a@href",
    "info": "div.paper-info",
    "sources": "div.paper-source a@href"
}}
```

翻下一页，**单独一次调用**；翻完之后**再发一次调用**用上面那份选择器抽：

```jsonc
{ "kind": "click", "selector": "<「下一页」，见上>" }
```

**这里的翻页是 JS 驱动、不产生导航**，而 `browser_act` 本来也不等任何东西 ——
点击之后**必须自己确认页面真的换了**。

**「等当前页标记出现」这种条件在这里没有用**：`div.page.active` 是**当前页**的标记，
**点击之前就已经成立**，而 `wait` 是先探一次再等 —— 它会立刻回「等到了」，一毫秒都没等
（`references/browser.md` §五）。写上去只会让剧本看起来更严谨。

**怎么确认**：抽完之后拿这一页的第一条 `title` 与上一页的第一条比一眼 ——
**一模一样就是页面还没换**，别把它当成新的一页记下来，也别接着往下翻。
那正是「把第一页抽三遍、返回值一切正常」的样子。
（一个「点击前不成立、翻页后成立」的等待条件本期还没有实测过，见「补齐程序」。）

翻到最后一页时那次 `click` 会因无匹配而报错 —— 预期行为，之前每一页抽到的数据早已经在
各自那次调用的返回值里。

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
   并把整段检索 + 翻页写成一个能一次跑通的剧本。**翻页这一步要一并采出一个「点击前不成立、
   翻页后成立」的等待条件**（`div.page.active` 那种「当前页」标记不行，理由见上）——
   在此之前只能靠上面那条「比一眼第一条标题」

第 2 步不能省：两套工具看到的 DOM 不一定一样。
