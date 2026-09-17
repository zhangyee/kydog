# AGRIS（FAO）· 操作卡片

联合国粮农组织的全球农业文献库。**它产出的是书目记录，不是全文。**
轴 A 第二类。共同纪律见 `SKILL.md` §五、§六。

> **侦察状态：2026-09-16 在 KyDog 自己的 IAB 里实测**（它有 Cloudflare，别处进不去），
> 选择器带命中数。未量到的写「未探明」。

## ① 可达性

curl **403 Cloudflare**；**KyDog 的 IAB 里过得去**。

## ② 页面上有哪些控件

| 控件 | 选择器 | 实测 |
| --- | --- | --- |
| 检索框 | `#query` | **1/1** |
| 提交按钮 | `form:has(#query) button[type="submit"]` | **1** |

**Enter 不提交**（实测无变化），必须点提交按钮。

## ③ 动作 · 搜索

结果页 `agris.fao.org/search/en?query=<词>`，**10 条/页**。

| 字段 | 选择器 | 命中 |
| --- | --- | --- |
| 条目容器 | **`div.col-md-12:has(a[data-agris-title])`** | **10/10** |
| 标题 | `a[data-agris-title]` | **10/10** |
| 详情页 | 同上 `@href` → `/search/en/records/<id>` | 10/10 |
| 全文状态徽标 | `span.badge.bg-emergency` | 10/10（**不可点**，见 ⑥） |

翻页：

```jsonc
browser_act({ tabId: "<同一个 tabId>", actions: [
  { "kind": "click", "selector": "a.page-link[aria-label='Next']" },
  { "kind": "wait",  "until": { "urlMatches": "page=1" } },
  { "kind": "extract", "selectors": { "item": "div.col-md-12:has(a[data-agris-title])",
      "title": "a[data-agris-title]", "page": "a[data-agris-title]@href" }}
]})
```

`a.page-link[aria-label='Next']` **命中 1/1**，翻页后地址会变。

> ⚠ **容器必须带 `:has()` 收紧。** 裸 `div.col-md-12` 命中 **12**，而标题只有 **10** ——
> 多出来的两个不是结果。不收紧就会多抽两行空的，而且不报错。

## ④ 动作 · 取得访问权

公开，不需要登录。Cloudflare 是反爬不是权限。

## ⑤ 动作 · 详情页

点标题 → **站内当前标签跳转** → `agris.fao.org/search/en/records/<id>`。

## ⑥ 动作 · 取全文

**这个源拿不到全文。**

结果卡上那个「Full text」只是**状态徽标**（`span.badge.bg-emergency` 10/10，实测
`fullTextBadgeIsAction: false`，**不可点**）；抽样详情页里也找不到任何 PDF 入口（**0/0**）。

**拿不到全文是这个源的常态，不是你抽漏了。** 把书目记录与 DOI 报给用户 ——
指向 arXiv / PMC / DOI 的交给 `fastpaper download`，**这个源本身没有可 `browser_download` 的地址**。

## ⑦ 什么时候必须交给人

撞 Cloudflare 时 —— `ask_user_question` 带 `browserTabId`，点一次即可。

## ⑧ 已知局限

- 没有公开检索 API（`agris.fao.org` 的网页端与接口都在 Cloudflare 后面）
- **只能在 KyDog 的 IAB 里操作**
- **没有全文**，只有书目记录
- 作者 / 年份 / 来源等字段本轮**未单独量**
