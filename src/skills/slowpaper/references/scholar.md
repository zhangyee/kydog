# Google Scholar · 操作卡片

发现层，不托管全文。覆盖面最广：含预印本、学位论文、专利与灰色文献，有「所有版本」聚合与
PDF 直链。**没有官方 API** —— 这是它必须走浏览器的理由之一。

> **侦察状态：2026-09-16 真站点实测**（Chromium，视口宽 1280，与 KyDog 的 emulation 同宽）。
> 下面每一条选择器都在真 DOM 上数过命中数，翻页真点过一次。
> **未经本项目 `browser_act` 端到端验证** —— 覆盖不到 walker 的隔离世界执行、`extract` 的
> `item` 对齐、我们自己 `type` / `click` 的命中检查与自动滚动。

---

## ① 可达性与拦截页指纹

可达性**取决于网络出口**，三种状态都实测到过：

| 出口 | 首页 | 搜索 |
| --- | --- | --- |
| 2026-09-16 本次 | **200** | **200**，正常结果页，10 条 |
| 出口 B（一期，换 IP 后） | 200 | 200 |
| 出口 A（一期，被判为自动化） | **200**，正常渲染 | **403** 静态拦截页 |

**首页 200 不能推出搜索也 200。** 403 拦的是搜索这个动作本身。出口 A 上还验证过三件事，
结论一致：先开首页再从表单提交、换 Chrome、换 Safari 并登录 Google 账号，**全部 403**。所以

- 别浪费回合去放慢速度、模拟人类
- **登录 Google 账号解不开** —— 别把「让用户登录」当成解法

拦截页指纹（实测）：

```
HTTP 403
document.title === 'Sorry...'
正文含 "your computer or network may be sending automated queries"
没有 <form>、没有 reCAPTCHA、没有任何带 id 的元素
```

**这是硬拦，人也解不开** —— 页面上没有任何可交互的东西，唯一的出路是换网络出口。
遇到它**不要**调 `ask_user_question` 把用户叫来（叫来了他也只能干看着）。正确反应是按
`SKILL.md` §三**换用百度学术**，并在产出里注明这一轮用的是百度学术、以及 Scholar 不可达。

判据用工具结果里那句 `HTTP 403`（导航结论那一行会写「但服务器返回 HTTP 403」），
不要去匹配正文字符串。**没有一个叫 `httpStatusCode` 的字段给你读**。

**403 出现在检索提交之后。** Scholar 的提交控件是表单按钮，不属于普通 `<a href>` 链接的
确定等待保证：导航事实若在本次输入期间到达，提交动作自己的返回值就会带 `HTTP 403`；
若导航晚到，它会挂在**下一次**浏览器工具结果**头部**那行
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
      "cited":  ".gs_fl a.gs_or_cited",
      "digest": "div.gs_rs"
  }}
]})
```

`type` 带 `selector` 时会先聚焦该元素，不必额外加一个 `click`。**它还会先全选清空**：
清不掉就明确报错、一个字都不打 —— 中途复用一个已经有内容的框时可能撞上
`browser.target_unusable`，那不是选择器写错了。

**点提交按钮，不要指望 Enter。** 一期侦察时在输入框里按 Enter 没有提交（百度学术也一样）。
有一条候选解释（CDP 的 `keyDown` 要带 `text` 才产生 char 事件，而本项目的按键表给 `Enter`
带了 `text`），**但本项目一次都没量过** —— 在复验之前一律点按钮。点按钮对
「提交控件不是 `type=submit`」的站点也成立，是唯一一条实测走通过的路。

**别在提交后立刻再点一次。** Scholar 对连续快速动作最敏感，多点的那一下正是掉进 403 的形状。
提交后先看本次返回有没有导航结论；没有的话，下一次调用先看头部那行 `导航: [tab_…]`。

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

**别翻太多页。** Scholar 对连续快速翻页比对单次检索敏感得多，翻着翻着掉进 403 就要整轮换源。

---

## ④ 动作 · 取得访问权

**公开，不需要登录。**

**403 是反爬，不是权限问题。** 别把它当成「要登录才能看」—— 一期实测登录 Google 账号
照样 403。处置见 ①：换源，不叫人。

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

**本期不下载任何文件。** 浏览器没有下载工具，页面自己触发的下载也会被一律拒绝。

`div.gs_ggs .gs_or_ggsm a@href` 是这个源最值钱的一格 —— 它直接指出哪里有开放副本。实测指向
`arxiv.org/pdf/…`、`iclr.cc`、`neurips.cc`、`openreview.net`。**把它原样报给用户**，别试图去取它。
抽不到就是这一条没有开放副本，不是选择器坏了。

有一条例外值得主动做：直链或论文页指向 **arXiv / PMC / DOI** 时，把标识符交给
`fastpaper download` —— 它按标识符路由，比浏览器省得多。浏览器的价值到「找到了它」就用完了。

裸 PDF URL（`openreview.net/pdf?id=…` 这类）不是 fastpaper 收的形态，**本期就到链接为止**。

---

## ⑦ 什么时候必须交给人

- **不包括 403 硬拦** —— 人也解不开，直接换源（①）
- 其余情况按 `references/browser.md` 的交接规则

---

## ⑧ 已知局限

- 无官方 API；反爬强，搜索动作对被判定为自动化的出口直接 403
- 中国大陆通常需要代理才能访问
- 被引数是 Scholar 自己的口径，与 Web of Science / Scopus 不一致，**不要当权威引用数报出去**
- 没有详情页，元数据只有结果页上那一行 `div.gs_a`（作者/来源/年挤在一起，没有分字段）
- 界面语言跟随浏览器，**任何按文案定位的选择器都不可靠**
