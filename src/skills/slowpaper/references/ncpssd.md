# 国家哲学社会科学文献中心（NCPSSD）· 操作卡片

中国社科院承建，完全免费。中文社科期刊 2400+ 种、文章 1380 万+，外文 OA 期刊 1.5 万+ 种。
轴 A 第二类。共同纪律见 `SKILL.md` §五、§六。

> **侦察状态：2026-09-16 在 KyDog 自己的 IAB 里实测，2026-09-17 补测提交、新标签与翻页**，选择器带命中数。
> 未量到的写「未探明」。

## ① 可达性

首页与结果页都正常。没有 Cloudflare。

2026-09-17 首页挂着通知：**域名将由 `www.ncpssd.org` 调整为 `www.ncpssd.cn`**。同日实测 `.org` 仍可用；
哪天 `.org` 打不开了，先换 `.cn` 再下结论。首页偶尔很慢（同日一次 30 秒没出检索框），等 `#text_search` 出现再动手。

## ② 页面上有哪些控件

| 控件 | 选择器 | 实测 |
| --- | --- | --- |
| 检索框 | `#text_search` | **1/1** |
| 提交按钮 | `#but_search` | **1** |

**提交是怎么实现的**（2026-09-17 读了站点脚本 `master.js`，并在 IAB 里实测）：检索框上的 `keydown`
遇到 Enter 就 `$("#but_search").click()`，按钮的 `onclick` 是 `Basicsearch()`。它**先清空检索框，
再 `window.open` 在新标签里打开结果页** —— **结果从来不在当前这个标签里。**

**提交用 Enter，不点按钮。** `type` 按选择器聚焦检索框、不经过坐标，打完焦点就在框里，接着按 Enter
即可。实测点按钮也能提交；但 2026-09-17 第一组验收里，「点按钮」与「点一下检索框再按 Enter」两次都
没触发检索（检索框没被清空，说明 `Basicsearch()` 根本没跑），在 IAB 里换四种配置都没能复现 ——
两次的共同点是都靠坐标点击，Enter 这条路不依赖它。

## ③ 动作 · 搜索

结果页 `/Literature/articlelist?sType=0&search=<base64>&searchname=<base64>&nav=0&ajaxKeys=<base64>`，
**10 条/页**。

| 字段 | 选择器 | 命中 |
| --- | --- | --- |
| 条目容器 | `div.julei-list` | **10** |
| 标题 | `a[data-id]` | **10/10** |
| 详情页 | **拿不到** —— 标题的 href 是 `javascript:void(0);` | — |

### 剧本：检索分两次调用（2026-09-17 实测跑通）

```jsonc
// 第一次：在首页提交。等的是「检索框被清空」—— 那是 Basicsearch() 真的跑了的页面信号。
browser_act({ tabId: "<首页那个标签>", actions: [
  { "kind": "type", "selector": "#text_search", "text": "<检索词>" },
  { "kind": "key",  "key": "Enter" },
  { "kind": "wait", "until": { "selector": "#text_search:placeholder-shown", "state": "present" } }
]})
// 工具结果末尾会有一行「这一批里新开了 1 个标签页 …：[tab_…] …/Literature/articlelist?…」

// 第二次：把 tabId 换成那个新标签，在那里等与抽。
browser_act({ tabId: "<新开的那个标签>", actions: [
  { "kind": "wait", "until": { "selector": "div.julei-list", "state": "present" } },
  { "kind": "extract", "selectors": { "item": "div.julei-list", "title": "a[data-id]" } }
]})
```

- **别在首页那个标签上等 `div.julei-list`。** 结果在新标签里，原标签上等多久都等不到 —— 而超时的报错
  只会说「条件没有成立」，看起来像是检索没发出去。
- 第一次调用里那个 `wait` 超时 = **检索框没被清空 = 检索没发出去**。这时不要改去点按钮重试，照实报告。
- 再检索一个词：回到首页那个标签重复第一次调用即可（`type` 会先清空再打字）。每次都会新开一个结果标签，
  **一轮里 NCPSSD 最多检索两三次**，别把标签开满（`SKILL.md` §四：一轮不超过 3 个标签）。

### 翻页（2026-09-17 实测跑通）

`a.layui-laypage-next` **命中 1/1**。**地址不变、也没有加载提示**，不能用 `urlMatches`；而首条
结果的序号（「1、」→「11、」）是文字，`wait` 认不了。可等的是页码控件：翻到第 N 页之后，
「上一页」带 `data-page="N−1"`；**第 1 页上根本没有「上一页」**（实测 0 个）。它与结果列表在同一帧换上，
实测 1→2、2→3 两次，抽到的都是新的一页。

```jsonc
// 翻到第 2 页（第 3 页把 '1' 换成 '2'）
browser_act({ tabId: "<结果页那个标签>", actions: [
  { "kind": "click", "selector": "a.layui-laypage-next" },
  { "kind": "wait",  "until": { "selector": "a.layui-laypage-prev[data-page='1']", "state": "present" } },
  { "kind": "extract", "selectors": { "item": "div.julei-list", "title": "a[data-id]" } }
]})
```

> ⚠ **检索词在地址里是 base64。** `search=` 那一段是一整套检索语法
> （`(IKTE="深度学习" OR IKPYTE=… )`）的 base64，`ajaxKeys=` 是检索词本身的 base64。
> **这是「不拼检索 URL、走交互」最硬的一个例子** —— 拼它要自己编一套检索语法再编码，改版即废。

## ④ 动作 · 取得访问权

公开，不需要登录。

## ⑤ 动作 · 详情页

**标题的 href 是 `javascript:void(0);`**，`extract` 拿不到地址。
点标题 → **弹新标签**。要接着操作就把 `tabId` 换成工具结果里那个新弹出来的
（见 `references/browser.md`）。

## ⑥ 动作 · 取全文

**全文入口在结果卡上，不在详情页。**

| 入口 | 选择器 | 命中 |
| --- | --- | --- |
| 阅读全文 | `a.house:not(.r100)` | **10/10** |
| 全文下载 | `a.house.r100` | **10/10** |

> ⚠ **这两个的 `href` 都是 `javascript:void(0);`** —— 真实路径在 onclick 里
> （`/Literature/readurl?id=<id>`）。`extract` **取不到地址**，要用就得点。
> 抽取时只能把「有没有全文」当成一个布尔值报出去。

## ⑦ 什么时候必须交给人

需要登录的站内功能。本卡片的动作都用不到。

## ⑧ 已知局限

- 没有公开检索 API
- **详情页与全文入口的地址都拿不到**（全是 `javascript:void(0);`）
- **翻页不能等 URL**，只能等首条序号变化
- **弹新标签会遇到两次**（Enter 提交一次、点标题一次）
