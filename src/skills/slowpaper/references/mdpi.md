# MDPI · 操作卡片

400+ 刊的纯 OA 出版社，全刊 CC-BY。轴 A 第二类。共同纪律见 `SKILL.md` §五、§六。

> **侦察状态：2026-09-16 真站点实测**（视口 1280），选择器带命中数。未量到的写「未探明」。

## ① 可达性

curl **403**；浏览器正常，**没有 Cloudflare 挑战**。

它有 OAI-PMH（`oai.mdpi.com/oai/oai2.php`），但那只能按日期与集合增量收割、**没有关键词检索** ——
所以关键词检索走这里，不走 API。

## ② 页面上有哪些控件

结果页 `mdpi.com/search?q=<词>`，**50 条/页**（页面上的 `page_count` 下拉可调）。
检索框与提交按钮**未单独量**（本次直接走结果页地址核对结构）。

## ③ 动作 · 搜索

| 字段 | 选择器 | 命中 |
| --- | --- | --- |
| 条目容器 | `div.article-item` | 50 |
| 标题 | `a.title-link` | 50/50 |
| 详情页 | `a.title-link@href`，形如 `/2504-4990/8/9/283` | 50/50 |
| 作者 | `div.authors` | 50/50 |
| 刊名 | `.color-grey-dark` | 50/50 |
| DOI | 条目内 `a[href*="doi.org"]` | 50/50 |
| **PDF 直链** | **`a.UD_Listings_ArticlePDF@href`** | **50/50** |

翻页是真 `<a href>`，**按页号定位**：

```jsonc
browser_act({ tabId: "<同一个 tabId>", actions: [
  { "kind": "click", "selector": "a[href*=\"page_no=3&\"]" },
  { "kind": "wait",  "until": { "urlMatches": "page_no=3" } },
  { "kind": "extract", "selectors": { "item": "div.article-item", "title": "a.title-link",
      "page": "a.title-link@href", "pdf": "a.UD_Listings_ArticlePDF@href", "authors": "div.authors" }}
]})
```

> ⚠ `a[href*="page_no=2&"]` 命中 **2** 个（页码「2」与「下一页」箭头，两个都指向第 2 页）；
> `page_no=3&` 才命中 1。页内走 `querySelector` 取第一个，功能上没问题 ——
> 但**到没到第几页靠 `urlMatches` 判，不靠命中数**。

## ④ 动作 · 取得访问权

公开，不需要登录。

## ⑤ 动作 · 详情页

`a.title-link@href` 是真链接，直接开。详情页结构**未探明**（本期没进去量）。

## ⑥ 动作 · 取全文

**`a.UD_Listings_ArticlePDF@href` 在结果页上就有，50/50 全有** —— 这是这批 OA 源里最干净的一格，
不必进详情页。形如 `/2504-4990/8/9/283/pdf?version=…`，用 `browser_download` 取（它走这个标签的会话）。

## ⑦ 什么时候必须交给人

本期没遇到需要交接的情况。

## ⑧ 已知局限

- 没有可用的检索 API（OAI-PMH 只能按日期收割）
- curl 拿不到（403），只能走浏览器
- 检索框 / 提交按钮、详情页结构**未探明**
