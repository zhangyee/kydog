# 百度学术 · 操作卡片

中英文混合检索的发现层，中文覆盖好、结果质量参差，对接文献传递。**没有官方 API**。

> **侦察状态：2026-09-16 真站点实测**（Chromium，视口宽 1280，与 KyDog 的 emulation 同宽）。
> 下面每一条选择器都在真 DOM 上数过命中数。
> **未经本项目 `browser_act` 端到端验证** —— 覆盖不到 walker 的隔离世界执行、`extract` 的
> `item` 对齐、我们自己 `type` / `click` 的命中检查与自动滚动。跑不通时以页面为准，别硬套。

---

## ① 可达性与拦截页指纹

| 端点 | 2026-09-16 | 2026-09-08（一期） |
| --- | --- | --- |
| `https://xueshu.baidu.com/`（首页） | **200**，正常渲染 | 200 |
| 检索提交后的结果页 | **200**，10 条结果，**没有验证码** | **403**，人机验证页 |

**两种状态都真实存在，取决于这一刻的网络出口与会话。** 别把「这次没撞上」写成「这个源不会拦」。

拦截页指纹（2026-09-08 实测）：

```
HTTP 403
document.title === '百度安全验证'
正文含「校验失败，请再试一次」与「请依次点击…」
```

**这是可交互的点选验证码，人能解开** —— 与 Google Scholar 的静态硬拦不同。反应是调
`ask_user_question` 交给用户（带上 `browserTabId`，侧栏会展开到这个标签）。用户点完，
cookie 落进持久 partition，后续检索复用同一个会话。挂起期间**不要读页面**，也不要替用户点。

判据用工具结果里那句 `HTTP 403`（导航结论那一行会写「但服务器返回 HTTP 403」）；
**没有一个叫 `httpStatusCode` 的字段给你读**。是否可交互看快照里有没有可点的验证控件。

**检索提交之后才 403 的那一次不在那一批的返回值里** —— 提交走的是 `div` 上的点击，不是普通
链接，没有导航等待保证。它挂在**下一次**工具结果**头部**那行 `导航: [tab_…]`，只报一次、
报过就清。

---

## ② 页面上有哪些控件

**首页没有任何 `<form>` 元素**（实测 `document.forms.length === 0`），检索完全由 JS 驱动 ——
本来就没有可拼的表单 URL。

| 控件 | 选择器 | 实测 |
| --- | --- | --- |
| 主搜索框 | `textarea.search-input` | **是 `<textarea>` 不是 `<input>`**，无 `name`、无 `id`。别按 `input[name=…]` 找它 |
| 提交按钮 | `.send-btn` | 空框时 class 是 `send-btn disable`，有内容后变 `send-btn` |
| 高级检索入口 | `div.advanced-search.advance-toggle-btn` | 页面上的**文案是「高级搜索」**。见 ③ 的警告，这条路不推荐 |

**按钮变可用不依赖 `keydown`。** 实测只派发一个 `input` 事件，`.send-btn` 就从 `disable`
变可用 —— 而 KyDog 的 `type` 走 `Input.insertText`（发 `beforeinput` + `input`，是这个的超集），
所以**任何检索词打进去按钮都会变可用**，中英文没有分支。

**别指望 Enter。** 首页没有 `<form>`，隐式提交无从谈起；提交一律点 `.send-btn`。

---

## ③ 动作 · 搜索

### 剧本：首页检索（2026-09-16 实测跑通）

```jsonc
browser_open({ url: "https://xueshu.baidu.com/" })
browser_act({ tabId: "<上一步的 tabId>", actions: [
  { "kind": "type",  "selector": "textarea.search-input", "text": "<检索词>" },
  { "kind": "click", "selector": ".send-btn" },
  { "kind": "wait",  "until": { "selector": "div.paper-wrap.result", "state": "present" } },
  { "kind": "extract", "selectors": {
      "item":    "div.paper-wrap.result",
      "title":   "h3.paper-title a",
      "detail":  "h3.paper-title a@href",
      "type":    "div.paper-info span.paper-type",
      "info":    "div.paper-info",
      "summary": "div.paper-abstract",
      "sources": "div.paper-source a@href"
  }}
]})
```

**那个 `wait` 不是保险，是必需的。** 提交点的是 `div` 不是 `<a href>`，拿不到普通链接那条
导航等待保证；不显式等结果条目出现，紧接着的 `extract` 就在首页 DOM 上跑，抽到 0 条 ——
**而且不报任何错**。收尾快照同理：它在最后一步之后立刻取，新旧完全取决于这个 `wait`。
超时就按「出错即停」处理，**不要**因为「页面变化」看起来没动就再点一次提交。

`type` 带 `selector` 时会先聚焦该元素，不必额外加一个 `click`。**它还会先全选清空**：
清不掉就明确报错、一个字都不打 —— 中途复用一个已经有内容的框时可能撞上
`browser.target_unusable`，那不是选择器写错了。

### 字段检索：语法直接打进主搜索框

**不要去开高级检索对话框。** 这个源的字段语法在主搜索框里直接生效：

```
author:(何恺明) 图像
```

2026-09-16 实测：4 条结果，作者全部命中。一次往返，没有对话框的任何坑。
（旁证：结果页上每个作者名的链接就是 `search?wd=author%3A%28…%29`。）

> ⚠ **高级检索对话框这条路在本工具下走不通，别试。** 三个实测理由：
> ① 结果页上 **`#advanced-search-all` 有两个同 id 元素**，`querySelector` 命中的是哪一个不定；
> ② 对话框开 / 合时这些元素的**存在性不变**，而 `wait` 的 `state` 只有 `present` / `absent`、
> 判的是 `document.querySelector` 真假、**不看可见性** —— 所以「点开对话框再等它出现」那一步
> 必然是空转（条件点击前就成立，`wait` 先探一次就立刻返回「等到了」）；
> ③ 对话框的提交按钮 `.button-group button.atomic-button-primary.operate-btn` 文案是
> **「高级检索」**（入口那个才叫「高级搜索」）—— 两个名字反着，容易定位错。

### 怎么翻页（2026-09-16 实测可用）

| 控件 | 选择器 | 实测 |
| --- | --- | --- |
| 下一页 | `div.pagination > div.page.n:last-child` | **精确命中 1 个** |
| 上一页 | `div.pagination > div.page.n:first-child` | 精确命中 1 个 —— **别写裸 `div.page.n`**，那会取到「上一页」，点下去往回翻 |

翻页控件是没有 `href`、没有 role 的 `div`，**无障碍树里可能没有** —— 只能用 `selector`。

**等待条件用地址里的偏移量**：点「下一页」后 URL 变成 `…&pn=10`，第 3 页是 `pn=20`
（`pn = (页码 − 1) × 10`）。它逐页不同、点击前不成立，正是 `wait` 要的形状；
`urlMatches` 判的是主进程手里的地址、不进页面。

一页一次 `browser_act`，**不要写进 `repeat`** —— 一批里每一轮的等待条件都是同一个，
而「翻到了第几页」逐页不同。

```jsonc
// 翻到第 2 页并抽它（第 3 页把 pn=10 换成 pn=20）
browser_act({ tabId: "<同一个 tabId>", actions: [
  { "kind": "click", "selector": "div.pagination > div.page.n:last-child" },
  { "kind": "wait",  "until": { "urlMatches": "pn=10" } },
  { "kind": "extract", "selectors": { "item": "div.paper-wrap.result", "title": "h3.paper-title a",
      "detail": "h3.paper-title a@href", "info": "div.paper-info", "sources": "div.paper-source a@href" }}
]})
```

翻到最后一页时那次 `click` 会因无匹配或控件禁用而报错 —— 预期行为，之前每一页抽到的数据
早已经在各自那次调用的返回值里。

### 结果页的字段（2026-09-16 实测命中数）

结果页 URL 形态 `https://xueshu.baidu.com/ndscholar/browse/search?wd=<检索词>`，**每页 10 条**。
条目容器 `div.paper-wrap.result`（完整 class 是 `paper-wrap result xpath-log`）。

| 字段 | 选择器 | 命中 |
| --- | --- | --- |
| 标题 | `h3.paper-title a` | 10/10 |
| 详情页 | `h3.paper-title a@href` | 10/10，绝对地址，带 `&site=xueshu_se` |
| 摘要片段 | `div.paper-abstract` | 10/10。命中词被 `<em>` 包着，取文本即可 |
| 类型 | `div.paper-info span.paper-type` | 10/10。「期刊」/「学位」/「会议」/「专利」等 |
| 作者 | `div.paper-info a[href*="wd=author"]` | 10/10，多个 |
| 元信息整行 | `div.paper-info` | 形如 `期刊 李颖，李秀宇，卢兆林，... - 《计算机工程与设计》 - 被引量：0 - 2022年` |
| **全文入口** | `div.paper-source a@href` | **9/10**，多个。见 ⑥ |

> ⚠ **期刊名、被引量、年份没有独立的选择器，只能从 `div.paper-info` 整行文本里读。**
> 新版 SPA 把它们渲染成**无 class 的 `<span>`**。一期文档里那两条
> —— `div.paper-info a[href*="refpaper"]`（被引量）与
> `div.paper-info a[href*="/usercenter/data/journal"]`（期刊）—— 在新版上实测 **0/10**，
> 它们是旧版页面的遗留。照着写不会报错，只会让这两格永远是空。

---

## ④ 动作 · 取得访问权

**公开，不需要登录。** 检索与看详情页都不要账号。

唯一会拦住的是 ① 那个点选验证码，那是反爬不是权限 —— 交给人，不要去找登录入口。

需要登录的是收藏、订阅、文献互助这类功能；本卡片的四个动作都用不到它们。

---

## ⑤ 动作 · 详情页

结果页的摘要只是片段。**完整摘要与关键词只有详情页有。**

```jsonc
browser_open({ url: "<结果页抽到的 detail 值>" })   // /usercenter/paper/show?paperid=…
browser_read({ tabId: "<上一步的 tabId>" })
```

实测（2026-09-16）：

- `/usercenter/paper/show?paperid=…` 会**跳到** `/ndscholar/browse/detail?paperid=…&site=xueshu_se`。
  两个地址都能用，抽到什么就打什么
- 整页正文 **1839 字符**，`browser_read` 一次拿完，远低于它 20000 字符的上限
- 页面上有：完整摘要、关键词、作者、年份、期刊、阅读量、全部来源、相似文献

> ⚠ **别在详情页上用 `.abstract` 这个选择器。** 它实测命中 **9 个**，全是「相似文献」的摘要，
> 本篇的摘要不在里面。抽出来一片看着像摘要的东西，其实是别的论文的 —— 不报错。
> 要本篇的摘要就用 `browser_read`，别用 `extract`。

---

## ⑥ 动作 · 取全文

**本期不下载任何文件。** 浏览器没有下载工具，页面自己触发的下载也会被一律取消。

**全文入口只在结果页抽**：`div.paper-source a@href`（实测 9/10）。它把同一篇论文在各处的
入口并排列出来 —— 实测见到 `nstl.gov.cn`（国家科技图书文献中心）、`qikan.cqvip.com`（维普）、
`d.wanfangdata.com.cn`（万方）、`cnki.com.cn`（知网）、期刊官网、iAcademic。

**取全部 `a` 再按域名挑**，不要只取第一个 —— 排在前面的不一定是能直接下到 PDF 的那个。

> ⚠ **不要为了拿全文入口去开详情页。** 详情页上那些来源是**没有 `href` 的 `div`**
> （`.all-version-item`），`.source-wrap` 里唯一的真 `<a>` 是「文献互助」。进去一趟拿不到链接。

这些站点大多需要机构订阅 —— 但**先打开看一眼**再谈登录（`SKILL.md` §二）：用户在校内网或
挂着 VPN 时本来就有权。真要联邦登录见 `references/carsi.md`；**登录之后本期仍然
不下载**，只把链接报给用户。

左侧筛选面板 `div.filters-wrap` 里有「获取方式 → 免费下载」（2026-09-16 实测那次检索下 834 条，
同组还有「登录查看」707 条）。按它筛过，报出去的链接才更可能是用户点开就能看的。

> ⚠ **这一项没有可写死的选择器。** 面板里每个 `div.filter-field` 只靠**位置**区分（那次检索下
> 「获取方式」排第 4，而字段的有无与顺序随检索词变），条目 `div.filter-field-content` 之间
> 除了计数没有任何差异，CSS 又没有文本匹配。所以这是少数几个**必须走快照 `index` +
> `snapshotId`** 的地方：先取一份快照确认哪一块是「获取方式」，就在那份快照里点它。
> 快照里找不到就**跳过** —— 筛选是优化不是必需，为它多花两次往返不划算。

指向 **arXiv / PMC / DOI** 的，把标识符交给 `fastpaper download` —— 按标识符路由，比浏览器省。

---

## ⑦ 什么时候必须交给人

- **403 +「百度安全验证」点选验证码** —— 主要场景，见 ①
- 需要登录的站内功能（收藏、文献互助等）
- 跳出去的外部站点要求付费、接受条款、填个人信息

调 `ask_user_question` 时**带上 `browserTabId`**，界面会展开侧栏并切到那个标签。

---

## ⑧ 已知局限

- 无官方 API；检索动作对被判定为自动化的出口会 403 + 人机验证（本次没撞上，不等于不会）
- 结果质量参差，**同一篇论文可能有多条重复记录** —— 同一次检索内按标题归一化并掉
- 很多条目走文献传递而非直链，拿不到 PDF 是常态，不是故障
- 期刊 / 被引量 / 年份只有整行文本，没有独立字段（见 ③）
- 高级检索对话框在本工具下不可用（见 ③），字段限定走主搜索框语法
- 首页导航里有一项「旧版入口」，没试过；要试先按当时的快照定位，别照猜的写进剧本
