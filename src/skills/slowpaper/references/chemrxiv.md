# ChemRxiv · 操作卡片

化学预印本平台。轴 A 第二类。共同纪律见 `SKILL.md` §五、§六。

> **侦察状态：2026-09-16 在 KyDog 自己的 IAB 里实测**（它有 Cloudflare，别处进不去），
> 选择器带命中数。未量到的写「未探明」。

## ① 可达性

curl **403 Cloudflare**，**连它的 public-api 也是 403** —— 所以连 API 那条路都不通。
KyDog 的 IAB 里过得去，但**本轮仍需要人工点一次验证**才拿到真实 DOM。

> ⚠ **这个源有一条硬纪律：不许直接开结果深链。**
> 实测从首页交互检索能正常进结果页；而直接打开 `chemrxiv.org/action/doSearch?...` 这类地址
> **会掉回 Cloudflare 循环**。所以入口只有一条：**首页 → 真实检索 → 结果页**。

## ② 页面上有哪些控件

| 控件 | 选择器 | 实测 |
| --- | --- | --- |
| 检索框 | `input[placeholder="Search for preprint research articles, keywords, etc."]` | **1** |
| 提交按钮 | 同表单内 `button[type="submit"]` | **1** |

**Enter 不提交**（实测无变化），必须点提交按钮。

结果页上有 **osano cookie 横幅**（「接受 / 拒绝」两个按钮可见），与 Frontiers 的 onetrust 同类，
会挡点击。

## ③ 动作 · 搜索

```jsonc
browser_open({ url: "https://chemrxiv.org/" })
browser_act({ tabId: "<上一步的 tabId>", actions: [
  { "kind": "type",  "selector": "input[placeholder=\"Search for preprint research articles, keywords, etc.\"]", "text": "<检索词>" },
  { "kind": "click", "selector": "form:has(input[placeholder=\"Search for preprint research articles, keywords, etc.\"]) button[type=\"submit\"]" },
  { "kind": "wait",  "until": { "selector": "div.auth-xslt-item", "state": "present" } },
  { "kind": "extract", "selectors": { "item": "div.auth-xslt-item",
      "title": "div.auth-xslt-item__title__wrapper span.hlFld-Title > a",
      "page": "div.auth-xslt-item__title__wrapper span.hlFld-Title > a@href" }}
]})
```

结果页 `chemrxiv.org/action/doSearch?AllField=<词>`，**20 条/页**。

| 字段 | 选择器 | 命中 |
| --- | --- | --- |
| 条目容器 | `div.auth-xslt-item` | **20/20** |
| 标题 / 详情页 | `div.auth-xslt-item__title__wrapper span.hlFld-Title > a[href*='/doi/full/']` | **20/20** |
| 日期 | `div.auth-xslt-item__date` | 已抓到 |

翻页：「下一页」的真实 href 含 `startPage=1`，等待条件 `urlMatches: "startPage=1"`。

## ④ 动作 · 取得访问权

公开，不需要登录。Cloudflare 是反爬不是权限。

## ⑤ 动作 · 详情页

标题本身就是 `<a href>`，点它 → **站内当前标签跳转** → `chemrxiv.org/doi/full/10.26434/chemrxiv-<id>`。

## ⑥ 动作 · 取全文

| 入口 | 选择器 | 命中 |
| --- | --- | --- |
| 查看 PDF | `a.btn.btn--pdf[href*='/doi/pdf/']` | **2/2**（页面两处重复 UI） |
| 下载 PDF | `a#downloadPdfUrl[href*='/doi/pdf/']` | **1/1** |
| 补充材料 | `a[download][href$='.pdf']` | **1/1** |

> ⚠ **它的下载链接站方自己拼错了**：实测样例是
> `…/doi/pdf/10.26434/chemrxiv-2023-bt10w?download=true?redirectToLatest=false` —— **两个 `?`**。
> **原样拿这个地址去 `browser_download`，别替它改成 `&`** —— 那是猜，改错了就取不到。

## ⑦ 什么时候必须交给人

撞 Cloudflare 时（**本源是常态，首次几乎必撞**）—— `ask_user_question` 带 `browserTabId`。
cookie 横幅挡住操作时同理。

## ⑧ 已知局限

- 没有可用的 API（public-api 也被 Cloudflare 挡）
- **只能在 KyDog 的 IAB 里操作**，且**只能从首页检索进去**
- 结果页有 cookie 横幅，可能挡点击
