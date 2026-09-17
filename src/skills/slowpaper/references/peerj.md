# PeerJ · 操作卡片

生命科学与计算机科学的 OA 期刊，开放评审。轴 A 第二类。共同纪律见 `SKILL.md` §五、§六。

> **侦察状态：2026-09-16 在 KyDog 自己的 IAB 里实测**（它有 Cloudflare，别处进不去），
> 选择器带命中数。未量到的写「未探明」。

## ① 可达性

curl **403 Cloudflare**；外部自动化浏览器首次能开、复访被挡；**KyDog 的 IAB 里过得去**。

撞到「正在验证您是否是真人」时交给人点一次，cookie 落进持久 partition 后复用。

## ② 页面上有哪些控件

| 控件 | 选择器 | 实测 |
| --- | --- | --- |
| 检索框 | `#searchTerm` | **1/1** |
| 提交按钮 | —— | **命中 0，这个源没有提交按钮** |

**Enter 是唯一的提交方式，且实测能提交。** 这与 Scholar / 百度学术 / ChemRxiv / AGRIS 相反 ——
别把「一律点按钮」当成通则套到这里，这里没有按钮可点。

## ③ 动作 · 搜索

结果页 `peerj.com/articles/?q=<词>&type=articles`，**15 条/页**。

| 字段 | 选择器 | 命中 |
| --- | --- | --- |
| 条目容器 | `div.row.mb-12.main-search-item-row` | 15 |
| 标题 | `div.text-h6 a[href^="/articles/"]` | 15/15 |
| 详情页 | 同上 `@href`，形如 `peerj.com/articles/21732` | 15/15 |

翻页：

```jsonc
browser_act({ tabId: "<同一个 tabId>", actions: [
  { "kind": "click", "selector": "button[aria-label='Next page']" },
  { "kind": "wait",  "until": { "urlMatches": "page=2" } },
  { "kind": "extract", "selectors": { "item": "div.row.mb-12.main-search-item-row",
      "title": "div.text-h6 a[href^=\"/articles/\"]", "page": "div.text-h6 a[href^=\"/articles/\"]@href" }}
]})
```

翻页控件 `button[aria-label='Next page']` **命中 1/1**，**是 `button` 不是链接** ——
拿不到普通链接那条导航等待保证，上面那个 `wait` 是必需的。

## ④ 动作 · 取得访问权

公开，不需要登录。Cloudflare 是反爬不是权限。

## ⑤ 动作 · 详情页

点标题 → **站内当前标签跳转** → `peerj.com/articles/<id>/`。

## ⑥ 动作 · 取全文

| 入口 | 选择器 | 命中 |
| --- | --- | --- |
| **PDF** | `a.btn.btn-primary.js-download-btn[href$='.pdf']` | **1/1** |

形如 `peerj.com/articles/21696.pdf`，用 `browser_download` 取（它走这个标签的会话）。

## ⑦ 什么时候必须交给人

撞 Cloudflare「正在验证您是否是真人」时 —— `ask_user_question` 带 `browserTabId`，点一次即可。
**不要自己反复重载去等它过。**

## ⑧ 已知局限

- 没有公开检索 API
- **只能在 KyDog 的 IAB 里操作** —— 外部浏览器过不去 Cloudflare，别建议用户换别处试
- 没有提交按钮，只能用 Enter
