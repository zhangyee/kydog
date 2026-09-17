# SSRN · 操作卡片

金融、管理、法学的工作论文主力。轴 A 第二类。共同纪律见 `SKILL.md` §五、§六。

> **侦察状态：2026-09-16 在 KyDog 自己的 IAB 里实测**（它有 Cloudflare，别处进不去），
> 选择器带命中数。未量到的写「未探明」。

## ① 可达性

curl **403 Cloudflare**；外部自动化浏览器里打勾反复重弹；**KyDog 的 IAB 里过得去**。

> ⚠ **提交检索的那一刻可能再弹一次挑战。** 实测：点完提交，当时抓到的还是拦截页
> （`title` 是「请稍候…」），**再等一会儿才变成真结果页**。
> **别当场判成失败**，也别立刻重试 —— 重试正是重弹的形状。

## ② 页面上有哪些控件

| 控件 | 选择器 | 实测 |
| --- | --- | --- |
| 检索框 | **`input#search`** | **1/1** |
| 提交按钮 | `#search-button-with-text` | **1** |

**Enter 也能提交**（当前标签更新）。

> ⚠ **别写 `#search`。** 这个站上 `#search` **同时命中 `<section id="search">` 与
> `<input id="search">`** —— 同一个 id 挂在两个元素上。带标签名的 `input#search` 才命中 1。
> **靠 id 定位时别假设 id 唯一**，这条不止 SSRN 一家。

## ③ 动作 · 搜索

结果页 `papers.ssrn.com/searchresults.cfm?term=<词>`，**50 条/页**。

| 字段 | 选择器 | 命中 |
| --- | --- | --- |
| 条目容器 | `div.result-item` | **50** |
| 标题 / 详情页 | 标题本身就是 `<a href>` → `sol3/papers.cfm?abstract_id=<id>` | 50 |
| 页数 / 发布日期 / 作者 / 机构 / 摘要片段 | **没有独立 class**，只能从条目整段文本里读 | — |

**翻页未探明。**

> ⚠ 结果条目那一层的完整 class 是 `div._boxReset_qveh9_1.result-item`，
> 前半截是 **CSS-module 哈希类，站点一改版就变**。**只写 `div.result-item`**（已单独验过命中 50）。

## ④ 动作 · 取得访问权

公开，不需要登录。Cloudflare 是反爬不是权限。

## ⑤ 动作 · 详情页

点标题 → **站内当前标签跳转** → `sol3/papers.cfm?abstract_id=<id>`。
详情页上有「Download This Paper」与「Open PDF in Browser」两个入口。

## ⑥ 动作 · 取全文

| 入口 | 选择器 | 命中 |
| --- | --- | --- |
| 下载 PDF | `a.button-link.primary[href*='Delivery.cfm'][href*='.pdf']` | **2/2**（页面两处重复 UI） |
| 浏览器打开 PDF | 同上再加 `[href*='type=2']` | **2/2** |

真实形态：`papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID<id>_code<code>.pdf?abstractid=<id>&mirid=1`
（浏览器打开那条末尾多一个 `&type=2`）。用 `browser_download` 取（它走这个标签的会话）。

## ⑦ 什么时候必须交给人

撞 Cloudflare 时 —— `ask_user_question` 带 `browserTabId`，点一次即可。
**不要自己反复重载去等它过。**

## ⑧ 已知局限

- 没有公开检索 API
- **只能在 KyDog 的 IAB 里操作**
- 翻页未探明
- 结果条目的元信息挤在一段文本里，没有分字段
