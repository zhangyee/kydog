# Google Scholar

发现层，不托管全文。覆盖面最广：含预印本、学位论文、专利与灰色文献，有「所有版本」聚合与
PDF 直链。**没有官方 API** —— 这是它必须走浏览器的理由之一。

---

## 侦察状态

**2026-09-08 侦察完成。** 下面的选择器全部从真实结果页的 DOM 上读下来（检索词
`flow matching generative models`，约 49.1 万条结果，每页 10 条）。

**过程中遇到并复现了 403 硬拦**：在第一个网络出口上，搜索一律 403，换 IP 后恢复。那不是这个
源的常态，但是一种**真实会遇到、且必须能识别**的状态 —— 指纹见下。

---

## 操作方式：交互式

**一切操作都在页面上做**：找到控件、点它、输入、提交。不要拼检索 URL 绕过页面。

理由不是洁癖：

- 拼 URL 要为每个源维护一份参数契约，而参数会改、会加签名与时间戳，坏了不报错只出空结果
- 页面可能根本没有可拼的 URL（搜索由 JS 驱动时）
- 交互走的是站点的真实用户路径

**交互式不贵**。`browser_act` 一次调用装一串动作，探明之后用 `selector` 定位就是一段可以照抄
的剧本 —— 连快照都不用取。

### 剧本：首页检索

```jsonc
browser_open({ url: "https://scholar.google.com/" })
browser_act({ tabId: "<上一步的 tabId>", actions: [
  { "kind": "type",  "selector": "input[name=\"q\"]", "text": "<检索词>" },
  { "kind": "click", "selector": "#gs_hdr_tsb" }
]})
```

`type` 带 `selector` 时会先聚焦该元素，不必额外加一个 `click`。

**这里用点提交按钮，不用 Enter。** 侦察时在输入框里按 Enter **没有提交** —— live value 已经
是检索词、元素也聚焦着，页面却毫无反应；百度学术也一样。

**但这多半是侦察工具的问题，不是站点行为，标记为待重验。** Chromium 的表单隐式提交发生在
`keypress`，而 CDP 的 `dispatchKeyEvent` 只有 `keyDown` 且带 `text: '\r'` 时才产生 char 事件；
两个不相干的站点「都」不提交，更像是一种发法的问题。Scholar 这里是真 `<form>`，真浏览器里
回车必然提交。

用自研工具重验时**这条优先查**。在此之前，点按钮是确定可行的那条路。

接着用 §「怎么翻页」的 `repeat` 剧本抽结果。

**不要在剧本里写 `index`。** 快照编号是「这一次打开这个页面」的产物，换一次会话就漂；
`index` 只在探索期用（模型看着快照点），探明后一律换成 `selector`。

## 可达性（实测）

可达性**取决于网络出口**，而且两种状态都实测到了：

| | 首页 | 搜索 |
| --- | --- | --- |
| 出口 A（被判为自动化） | **200**，正常渲染 | **403** 静态拦截页 |
| 出口 B（换 IP 后） | **200** | **200**，正常结果页 |

出口 A 上还验证过三件事，结论一致：**先开首页再从表单提交、换 Chrome、换 Safari 并登录 Google
账号，全部 403**。所以

- 拦的是搜索这个动作本身，与怎么发起无关 —— 别浪费回合去放慢速度、模拟人类
- **登录 Google 账号解不开** —— 别把「让用户登录」当成解法

## 拦截页指纹（实测）

```
HTTP 403
document.title === 'Sorry...'
正文含 "your computer or network may be sending automated queries"
没有 <form>、没有 reCAPTCHA、没有任何带 id 的元素
```

**这是硬拦，人也解不开** —— 页面上没有任何可交互的东西，唯一的出路是换网络出口。

所以遇到它**不要**调 `ask_user_question` 把用户叫来（叫来了他也只能干看着）。正确反应是
按 SKILL.md 的规则**换用百度学术**，并在产出里注明这一轮用的是百度学术、以及 Scholar 不可达。

判据用 `browser_open` 返回的 `httpStatusCode`，不要去匹配正文字符串。

## 页面上有哪些控件（实测，读的是首页 DOM）

首页有两个可用的检索入口，都是真实的 `<form>`：

**① 首页搜索框**（简单检索）

- 输入框 `input[name="q"]`（首页上 id 为 `gs_hdr_tsi`）
- 提交按钮 `input[name="btnG"]`（id `gs_hdr_tsb`），或在输入框里按 Enter

**② 高级检索表单**（页面上的字段，交互式逐个填）

| 字段名 | 页面上是什么 |
| --- | --- |
| `as_q` | 包含全部字词 |
| `as_epq` | 包含完整字句 |
| `as_oq` | 包含至少一个字词 |
| `as_eq` | 不含字词 |
| `as_occt` | 出现位置，单选：`any`（全文任何位置）/ `title`（仅标题） |
| `as_sauthors` | 作者 |
| `as_publication` | 发表于 |
| `as_ylo` / `as_yhi` | 年份下限 / 上限 |

字段名是从页面表单上读下来的，在剧本里直接当选择器用（`input[name="as_sauthors"]` 之类）——
不是用来拼 URL 的。

## 结果页怎么抽（实测）

结果页 URL 形态 `https://scholar.google.com/scholar?q=<词>&hl=<语言>&as_sdt=0,5`，**每页 10 条**。

条目容器：`.gs_r.gs_or.gs_scl`。

| 字段 | 选择器 | 说明 |
| --- | --- | --- |
| 标题 | `h3.gs_rt a` | |
| 论文页 | `h3.gs_rt a@href` | 出版方/预印本的落地页，如 `arxiv.org/abs/2210.02747` |
| **PDF 直链** | `div.gs_ggs .gs_or_ggsm a@href` | 右侧那块。**不是每条都有** |
| PDF 来源标签 | `div.gs_ggs .gs_or_ggsm a` | 文本形如 `[PDF] arxiv.org`、`[PDF] iclr.cc`、`[PDF] openreview.net` |
| 作者/来源/年 | `div.gs_a` | 一整行，形如 `Y Lipman, RTQ Chen… - arXiv…` |
| 摘要片段 | `div.gs_rs` | |
| 被引数 | `.gs_fl a.gs_or_cited` | 文本「被引用次数：7347」；href 是 `/scholar?cites=<clusterId>` |
| 所有版本 | `.gs_fl a[href*="cluster="]` | 文本「所有 N 个版本」 |
| 相关文章 | `.gs_fl a[href*="related:"]` | |
| HTML 版 | `.gs_fl a.gs_or_nvi` | 有缓存时才有 |

**PDF 直链是这个源最值钱的一格** —— 它直接指出哪里有开放副本。本次检索 10 条全都有，但
**这与检索词强相关，不要当成常态**：抽不到就是这条没有开放副本。本期只报告它，不取（见下）。

`.gs_fl` 里的「保存」「引用」两个 `a` 的 href 是 `javascript:void(0)`，**不是链接，别去取它们的
href**。

## 怎么翻页（实测）

翻页区 `#gs_n`，里面是**真正的 `<a href>`**（与百度学术不同，那边全是无 role 的 div）。当前页
是不带链接的 `<b>`。

「下一页」用 **`#gs_n a:has(.gs_ico_nav_next)`** 定位 —— 实测精确匹配 1 个，且**不依赖界面
语言**。不要去匹配「下一页」这三个字：`hl=en` 时它是 `Next`。

翻页 + 抽取的 `repeat` 剧本：

```jsonc
{ "kind": "repeat", "times": 3, "actions": [
  { "kind": "extract", "selectors": {
      "item": ".gs_r.gs_or.gs_scl",
      "title": "h3.gs_rt a",
      "page": "h3.gs_rt a@href",
      "pdf": "div.gs_ggs .gs_or_ggsm a@href",
      "meta": "div.gs_a",
      "cited": ".gs_fl a.gs_or_cited"
  }},
  { "kind": "click", "selector": "#gs_n a:has(.gs_ico_nav_next)" }
]}
```

Scholar 的翻页是**真链接、走主 frame 导航**，所以这里不需要显式 `wait` —— 工具层会等这次导航的终态。
**百度学术不是这样**（SPA 翻页不产生导航，`click` 之后必须跟 `wait`），两个源在这一点上不能照抄彼此的剧本。

翻到最后一页时 `click` 会因无匹配而停 —— 预期行为，前几轮抽到的数据照常返回。

**别翻太多页。** Scholar 对连续快速翻页比对单次检索敏感得多，翻着翻着掉进 403 就要整轮换源。

## PDF 链接怎么处理：报告，不下载

**这个源在本期只做检索，不取 PDF。** 浏览器没有下载工具 —— 页面自己触发的下载也会被一律拒绝。

`div.gs_ggs .gs_or_ggsm a@href` 抽到的直链实测指向 `arxiv.org/pdf/…`、`iclr.cc`、`neurips.cc`、
`openreview.net`。**把它原样报给用户**，别试图去取它。

有一条例外值得主动做：直链或论文页指向 **arXiv / PMC / DOI** 时，把标识符交给
`fastpaper download` —— 它按标识符路由，比浏览器省得多。浏览器的价值到「找到了它」就用完了。

裸 PDF URL（`openreview.net/pdf?id=…` 这类）不是 fastpaper 收的形态，**本期就到链接为止**。

## 什么时候必须交给人

- **不包括** 403 硬拦（见上，人也解不开，直接换源）
- 其余情况按 `references/browser.md` 的交接规则

## 已知局限

- 无官方 API；反爬强，搜索动作对被判定为自动化的出口直接 403
- 中国大陆通常需要代理才能访问
- 被引数是 Scholar 自己的口径，与 Web of Science / Scopus 不一致，**不要当权威引用数报出去**

---

## 补齐程序

第 1 步（侦察）已完成，**第 2 步还没做**：

2. **验证**：基座做完后，用本项目 `browser_act` 的 `extract` 动作把上面每一条选择器真跑一遍，
   跑不通的改掉，并把「开首页 → 检索 → 翻页取数」连成一个能一次跑通的剧本

这一步不能省：两套工具看到的 DOM 不一定一样（登录态、UA、是否走代理都可能让 Scholar 返回不同
版本的页面）。**上面的选择器在被自研工具跑通之前，只是候选。**
