# Frontiers · 操作卡片

200+ 刊的纯 OA 出版社。轴 A 第二类。共同纪律见 `SKILL.md` §五、§六。

> **侦察状态：2026-09-16 真站点实测**（视口 1280），选择器带命中数。未量到的写「未探明」。

## ① 可达性

**关键词检索是 JS 壳**：curl 只有 2.5 KB，浏览器里正常出结果（实测 62,667 条）。

**但按刊浏览是静态的** —— `frontiersin.org/journals/<刊>/articles` curl 就有 1.39 MB。
**要批量拿某一本刊，那条路该交给 fastpaper，别用浏览器。**

## ② 页面上有哪些控件

结果页 `frontiersin.org/search?query=<词>&tab=articles`，**24 条/页**。
检索框与提交按钮**未单独量**。

页面上有 **onetrust cookie 横幅**（`#onetrust-banner-sdk` 存在）。

## ③ 动作 · 搜索

| 字段 | 选择器 | 命中 |
| --- | --- | --- |
| 条目容器 | `ul.entities-list.articles > li` | 24 |
| 标题 | `div.title` | 24/24 |
| 作者 | `.authors` | 24/24（多个作者名连在一起，没有分隔符） |
| 类型 | `.article-type` | 24/24（如 `Systematic Review`） |
| 日期 | `.date` | 24/24（`Published on 20 Nov 2020`） |
| 文章 id | `a[data-test-id]@data-test-id` | 24/24（形如 `article_navigate_610967`） |

**翻页未探明。**

> ⚠ **这一页滚不动。** 实测 `window.scrollTo(0, scrollHeight)` 之后 `scrollY` 恒 **0**、
> 条目数不变（24→24）。多半是那个 onetrust 横幅锁了滚动，它也会挡点击
> （`browser.click_intercepted` 的形状）。**先处理横幅，再谈翻页。**

## ④ 动作 · 取得访问权

公开，不需要登录。

## ⑤ 动作 · 详情页

**标题不是链接。** 包住整条的 `<a>` **没有 href**，全页只有 27 个 `<a>`、其中 24 个指向
`altmetric.com`。所以 `extract` 拿不到落地页地址，只能抽文本。

**点条目会弹新标签。** 要接着操作就把 `tabId` 换成工具结果里那个新弹出来的
（见 `references/browser.md`）。

## ⑥ 动作 · 取全文

**未探明** —— 没进过详情页。结果页上没有 PDF 直链。

## ⑦ 什么时候必须交给人

cookie 横幅挡住操作、且你处理不掉时。

## ⑧ 已知局限

- 关键词检索没有 API，且 curl 拿不到（JS 壳）
- 翻页未探明，滚动实测不生效
- 详情页拿不到 href，只能点，且点了弹新标签
- 取全文未探明
