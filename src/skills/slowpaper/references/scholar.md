# Google Scholar · 操作卡片

发现层，不托管全文。覆盖面最广：含预印本、学位论文、专利与灰色文献，有「所有版本」聚合与
PDF 直链。**没有官方 API** —— 这是它必须走浏览器的理由之一。

> **侦察状态：2026-09-16 真站点实测**（Chromium，视口宽 1280，与 KyDog 的 emulation 同宽）。
> 下面每一条选择器都在真 DOM 上数过命中数，翻页真点过一次。
> **未经本项目 `browser_act` 端到端验证** —— 覆盖不到 walker 的隔离世界执行、`extract` 的
> `item` 对齐、我们自己 `type` / `click` 的命中检查与自动滚动。
>
> **2026-09-17 补**（科研工作流验收第三组，经本项目 `browser_act` 真实跑过一次）：结果页抽取
> （10 / 10 / 9 条）与翻页（`start=10`、`start=20`）端到端跑通；同时撞上一种新的拦截形态 ——
> **HTTP 429 + reCAPTCHA**，人解开后恢复，见 ①。

---

## ① 可达性与拦截页指纹

可达性**取决于网络出口**，下面四种状态都实测到过：

| 出口 | 首页 | 搜索 |
| --- | --- | --- |
| 2026-09-16 本次 | **200** | **200**，正常结果页，10 条 |
| 2026-09-17（验收第三组） | **200** | **429**，跳到 Google 的 reCAPTCHA 验证页；人解开后回到结果页 **200**，接着翻 2 页仍是 200 |
| 出口 B（一期，换 IP 后） | 200 | 200 |
| 出口 A（一期，被判为自动化） | **200**，正常渲染 | **403** 静态拦截页 |

**首页 200 不能推出搜索也 200。** 403 与 429 拦的都是搜索这个动作本身。出口 A 上还验证过三件事，
结论一致：先开首页再从表单提交、换 Chrome、换 Safari 并登录 Google 账号，**全部 403**。所以

- 别浪费回合去放慢速度、模拟人类
- **登录 Google 账号解不开** —— 别把「让用户登录」当成解法

### 硬拦：HTTP 403（一期实测）

拦截页指纹：

```
HTTP 403
document.title === 'Sorry...'
正文含 "your computer or network may be sending automated queries"
没有 <form>、没有 reCAPTCHA、没有任何带 id 的元素
```

**这是硬拦，人也解不开** —— 页面上没有任何可交互的东西，唯一的出路是换网络出口。
遇到它**不要**调 `ask_user_question` 把用户叫来（叫来了他也只能干看着）。正确反应是按
`SKILL.md` §三**换用百度学术**，并在产出里注明这一轮用的是百度学术、以及 Scholar 不可达。

### 人能解的：HTTP 429 + reCAPTCHA（2026-09-17 实测一次）

提交检索之后，地址跳到 Google 自己的验证页，标签的 host 从 `scholar.google.com` 变成
`www.google.com`。工具结果里看到的是：

```
导航: [tab_…] 已打开 https://www.google.com/sorry/index?continue=<原来那次检索的地址>&…，但服务器返回 HTTP 429
快照：[1] presentation "reCAPTCHA"　[2] link "为什么会这样？"（另有 3 个 iframe 未穿透）
页面报的错里有 https://www.google.com/recaptcha/enterprise/anchor?…
```

**这种人能解**，按下面交给人：

1. **只调一次** `ask_user_question`，**带上 `browserTabId`**（就是这个 Scholar 标签），侧栏会切到
   验证页。选项至少给「解好了，继续」和「跳过 Scholar」。不要先问一次「要不要去解」、再单独调一次
   带标签的 —— 那是两轮往返，而带标签的那一次本身就能让用户选跳过。
2. 等他回答的时候**不读页面、不点任何东西**。
3. 他答「解好了」之后**不要重新提交检索**：验证页地址里的 `continue` 会把标签带回原来那次检索。
   先调 `browser_tabs`（它不进页面），头部应当有一行
   `导航: [tab_…] 已打开 https://scholar.google.com/scholar?…（HTTP 200）`，看到它就直接 `extract`，
   再照常翻页。
4. 他答「跳过」，或者 `browser_tabs` 里标签还停在 `www.google.com/sorry/…`：按 403 处理 ——
   换百度学术，并在产出里注明。

### 怎么判是哪一种

**先看状态码**，用工具结果里那句「但服务器返回 HTTP 403」或「但服务器返回 HTTP 429」，
不要去匹配正文字符串。**没有一个叫 `httpStatusCode` 的字段给你读**。

- `HTTP 403` → 硬拦，换源，不叫人
- `HTTP 429` → 再看快照里有没有 `presentation "reCAPTCHA"`：有，交给人；**没有**（这种还没实测到过），
  按 403 处理

**403 与 429 都出现在检索提交之后。** Scholar 的提交控件是表单按钮，不属于普通 `<a href>` 链接的
确定等待保证：导航事实若在本次输入期间到达，提交动作自己的返回值就会带状态码（2026-09-17 那次
429 就是这样到的）；若导航晚到，它会挂在**下一次**浏览器工具结果**头部**那行
`导航: [tab_…] 已打开 …，但服务器返回 HTTP 403`，**只报一次、报过就清**。

---

## ② 页面上有哪些控件

首页有两个可用的检索入口，都是真实的 `<form>`。

**① 首页搜索框**（简单检索）

| 控件 | 选择器 |
| --- | --- |
| 输入框 | `input[name="q"]`（首页上 id 为 `gs_hdr_tsi`） |
| 提交按钮 | `#gs_hdr_tsb`（即 `input[name="btnG"]`） |

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
**不是用来拼 URL 的**。

> ⚠ **界面语言跟随浏览器**（本次是 `hl=zh-CN`）。所以**不要按文案定位任何控件** ——
> 「下一页」在 `hl=en` 下是 `Next`。下面翻页那条选择器不依赖语言，这一点是刻意的。

---

## ③ 动作 · 搜索

### 剧本：首页检索（2026-09-16 实测跑通）

```jsonc
browser_open({ url: "https://scholar.google.com/" })
browser_act({ tabId: "<上一步的 tabId>", actions: [
  { "kind": "type",  "selector": "input[name=\"q\"]", "text": "<检索词>" },
  { "kind": "click", "selector": "#gs_hdr_tsb" },
  { "kind": "extract", "selectors": {
      "item":   ".gs_r.gs_or.gs_scl",
      "title":  "h3.gs_rt a",
      "page":   "h3.gs_rt a@href",
      "pdf":    "div.gs_ggs .gs_or_ggsm a@href",
      "meta":   "div.gs_a",
      "cited":  ".gs_fl a.gs_or_cited"
  }}
]})
```

`type` 带 `selector` 时会先聚焦该元素，不必额外加一个 `click`。**它还会先全选清空**：
清不掉就明确报错、一个字都不打 —— 中途复用一个已经有内容的框时可能撞上
`browser.target_unusable`，那不是选择器写错了。

**剧本只抽判断相关用得上的字段**（`SKILL.md` §四）。摘要片段在「结果页的字段」那张表里，挑中了再抽。

**点提交按钮，不要指望 Enter。** 一期侦察时在输入框里按 Enter 没有提交（百度学术也一样）。
有一条候选解释（CDP 的 `keyDown` 要带 `text` 才产生 char 事件，而本项目的按键表给 `Enter`
带了 `text`），**但本项目一次都没量过** —— 在复验之前一律点按钮。点按钮对
「提交控件不是 `type=submit`」的站点也成立，是唯一一条实测走通过的路。

**别在提交后立刻再点一次。** Scholar 对连续快速动作最敏感，多点的那一下正是掉进 403 的形状。
提交后先看本次返回有没有导航结论；没有的话，下一次调用先看头部那行 `导航: [tab_…]`。

2026-09-17 验收第三、五组各遇到一次：第一次点提交，等了 8–15 秒地址都没变。同日在全新会话里复现，
点击落在 `#gs_hdr_tsb` 上、也确实提交了，只是跳转在工具返回**之后**才到（跳到的是 ① 的 429 验证页）。所以：

1. 点完没看到导航结论，先调 `browser_tabs` —— 晚到的跳转会挂在它头部那行 `导航: [tab_…]` 上；
2. 地址确实还停在首页，**只补点一次**；
3. 补点之后仍不跳走，带 `browserTabId` 交给用户点，选项里给「跳过 Scholar」。**不要拼 `scholar?q=…`
   地址兜底**（§② 那几个字段名「不是用来拼 URL 的」）。

**这里别用「这一步发出的请求」那一段来判断。** Scholar 首页的提交是整页跳转，不走 XHR / fetch：
那一段说「没有发出任何」在这里是常态，**不说明点击没被接住**。判据只有导航结论，就是上面三步。

**不要在剧本里写 `index`。** 快照编号是「这一次打开这个页面」的产物，换一次会话就漂；
`index` 只在探索期用（看着快照点），探明后一律换成 `selector`。

### 结果页的字段（2026-09-16 实测命中数）

结果页 URL 形态 `https://scholar.google.com/scholar?q=<词>&hl=<语言>&as_sdt=0,5`，**每页 10 条**。
条目容器 `.gs_r.gs_or.gs_scl`（实测 10/10）。

| 字段 | 选择器 | 说明 |
| --- | --- | --- |
| 标题 | `h3.gs_rt a` | 10/10 |
| 论文页 | `h3.gs_rt a@href` | 出版方 / 预印本的落地页，如 `arxiv.org/abs/2210.02747` |
| **PDF 直链** | `div.gs_ggs .gs_or_ggsm a@href` | 右侧那块，本次 10/10。**不是每条都有**，与检索词强相关 |
| PDF 来源标签 | `div.gs_ggs .gs_or_ggsm a` | 文本形如 `[PDF] arxiv.org`、`[PDF] openreview.net` |
| 作者/来源/年 | `div.gs_a` | 一整行，形如 `Y Lipman, RTQ Chen… - arXiv…` |
| 摘要片段 | `div.gs_rs` | |
| 被引数 | `.gs_fl a.gs_or_cited` | 10/10。文本「被引用次数：7347」；href 是 `/scholar?cites=<clusterId>` |
| 所有版本 | `.gs_fl a[href*="cluster="]` | 文本「所有 N 个版本」 |
| 相关文章 | `.gs_fl a[href*="related:"]` | |
| HTML 版 | `.gs_fl a.gs_or_nvi` | 有缓存时才有 |

`.gs_fl` 里「保存」「引用」两个 `a` 的 href 是 `javascript:void(0)`，**不是链接，别去取它们的
href**。

### 怎么翻页（2026-09-16 实测可用）

翻页区 `#gs_n`，里面是**真正的 `<a href>`**。当前页是不带链接的 `<b>`。

「下一页」用 **`#gs_n a:has(.gs_ico_nav_next)`** —— 实测精确命中 **1 个**，且**不依赖界面语言**。
不要去匹配「下一页」这三个字。

**等待条件用地址里的偏移量**：那个链接的 href 是 `/scholar?start=10&…`，点下去 URL 变成
`start=10`，第 3 页是 `start=20`（`start = (页码 − 1) × 10`）。它逐页不同、点击前不成立，
正是 `wait` 要的形状；`urlMatches` 判的是主进程手里的地址、不进页面。

一页一次 `browser_act`，**不要写进 `repeat`** —— 一批里每一轮的等待条件都是同一个，
而「翻到了第几页」逐页不同。

```jsonc
// 翻到第 2 页并抽它（第 3 页把 start=10 换成 start=20）
browser_act({ tabId: "<同一个 tabId>", actions: [
  { "kind": "click", "selector": "#gs_n a:has(.gs_ico_nav_next)" },
  { "kind": "wait",  "until": { "urlMatches": "start=10" } },
  { "kind": "extract", "selectors": { "item": ".gs_r.gs_or.gs_scl", "title": "h3.gs_rt a",
      "page": "h3.gs_rt a@href", "pdf": "div.gs_ggs .gs_or_ggsm a@href", "meta": "div.gs_a",
      "cited": ".gs_fl a.gs_or_cited" }}
]})
```

翻页点击本身是普通链接，`browser_act` 会等主 frame 导航的明确终态 —— 上面那个 `wait`
不是为了等导航，是为了区分**第 2 页与第 3 页**（导航终态证明不了你到了哪一页）。

翻到最后一页时那次 `click` 会因无匹配而报错 —— 预期行为，之前每一页抽到的数据早已经在
各自那次调用的返回值里。

**别翻太多页。** Scholar 对连续快速翻页比对单次检索敏感得多，翻着翻着掉进 403 就要整轮换源
（掉进的是 429 验证页，可以交给人解，见 ①）。

---

## ④ 动作 · 取得访问权

**公开，不需要登录。**

**403 与 429 都是反爬，不是权限问题。** 别把它们当成「要登录才能看」—— 一期实测登录 Google 账号
照样 403。处置见 ①：403 换源、不叫人；429 验证页交给人解。

---

## ⑤ 动作 · 详情页

**这个源没有详情页。** `h3.gs_rt a@href` 直接指向出版方或预印本的落地页，不经过 Scholar
自己的中间页。

所以「看详情」= 打开那个落地页（`browser_open` + `browser_read`），那已经是**别的站点**了 ——
它属于哪一类源、要不要访问权，回 `SKILL.md` §二 重新判一次。

顺带两个 Scholar 自己的聚合页，需要时才开，**它们都要算进翻页预算**：

- 「所有版本」`.gs_fl a[href*="cluster="]` —— 同一篇的各个副本，想找开放副本时有用
- 「被引用次数」`.gs_fl a.gs_or_cited` —— 引用它的文献列表，页面结构与普通结果页相同

---

## ⑥ 动作 · 取全文

**这个源不托管全文，它指出去哪儿取。** 真要读全文时按下面两条路取（规则在 `SKILL.md` §五）；
页面自己触发的下载仍然一律取消。

`div.gs_ggs .gs_or_ggsm a@href` 是这个源最值钱的一格 —— 它直接指出哪里有开放副本。实测指向
`arxiv.org/pdf/…`、`iclr.cc`、`neurips.cc`、`openreview.net`。
抽不到就是这一条没有开放副本，不是选择器坏了。

- **直链或论文页指向 arXiv / PMC / DOI** → 把标识符交给 `fastpaper download`。它按标识符路由，
  比浏览器省得多。
- **其余裸 PDF 直链**（`openreview.net/pdf?id=…` 这类）→ `browser_download`：`url` 原样传抽到的
  那个直链，`tabId` 用这个 Scholar 标签。fastpaper 只收裸标识符，会直接拒绝 URL。

报 `browser.download_not_pdf` 说明这个地址在当前会话下回的不是 PDF（拦截页、落地页）——
**是我们没取到，不是这篇没有全文**。把链接原样报给用户。

---

## ⑦ 什么时候必须交给人

- **429 验证页**（快照里有 `presentation "reCAPTCHA"`）—— 带 `browserTabId` 交给人，解开后不要重新提交（①）
- **不包括 403 硬拦** —— 人也解不开，直接换源（①）
- 其余情况按 `references/browser.md` 的交接规则

---

## ⑧ 已知局限

- 无官方 API；反爬强，搜索动作对被判定为自动化的出口直接 403，或者给一张 429 验证页
- 中国大陆通常需要代理才能访问
- 被引数是 Scholar 自己的口径，与 Web of Science / Scopus 不一致，**不要当权威引用数报出去**
- 没有详情页，元数据只有结果页上那一行 `div.gs_a`（作者/来源/年挤在一起，没有分字段）
- 界面语言跟随浏览器，**任何按文案定位的选择器都不可靠**
