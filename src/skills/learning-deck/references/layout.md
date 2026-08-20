# 版式与组件 · layout.md

模板 `assets/report-template.html` 已经定义好全部样式。这一册只写
**「这个块长什么样、什么时候用、里面填什么」**，不重复模板里的 CSS——
样式一个字都不要改。

**不要自己造 class。** 模板里没有的 class 名不会有任何样式，写出来就是一段裸文字，
而且**不报错**。同理**不要给正文加行内 `style`**——没有例外：连内嵌原图的 `<img>` 也不用，
模板里的 `figure img` 已经管好了缩放。

---

## 整篇的骨架

```
<div class="progress"><div id="progress-bar"></div></div>   ← 模板已有，别删别复制
<div class="deck">                                           ← 整篇一个外壳
  <header class="deck-head">        ① 抬头
  <section class="map"      id="map">        ② 知识地图
  <section class="path"     id="path">       ③ 速通路径
  <section class="primer"   id="primer">     ④ 前序速览
  <div class="curtain">                      幕封页 · 第 1 节
  <section class="concept"  id="c1">         ⑤ 知识点正文 · 第 1 节
  <div class="curtain"> … <section class="concept" id="c2"> …   （每节一对）
  <section class="compare"  id="compare">    ⑥ 方法对比表（主题是「某个方法」时才有）
  <section class="wrapup"   id="wrapup">     ⑦ 收束节
  <section class="glossary" id="glossary">   ⑧ 术语对照表
  <section class="next"     id="next">       ⑨ 建议下一步
  <section class="refs"     id="refs">       ⑩ 文献清单
  <section class="honesty"  id="honesty">    ⑪ 诚实边界
</div>
<script> … </script>                                         ← 全文唯一的脚本块
```

⚠️ **新增的 `<section>` 必须带 `id`。** 方向键的停靠点是
`.curtain, .concept, section[id]` 这三样；一个裸 `<section>` 三样都不沾，
方向键会直接跳过它——不报错，读者只会觉得这一屏「按不到」。

---

## 交互组件（模板脚本已经接好，你只管加 class）

### `.progress` / `#progress-bar` — 顶部进度条

模板里已经有一份，**不要再写第二份、也不要删**。宽度由文末脚本按滚动位置算。
它是 sticky 2px 细线，不是「固定悬浮目录」（那个是明确排除的）。

### 方向键 / scroll-snap

`↓` `→` 下一节、`↑` `←` 上一节、`Home` / `End` 到首尾。
`.curtain` 与 `.concept` 参与 scroll-snap 吸附，辅助小节不吸附但仍是方向键的停靠点。
**这些都不用你做任何事**，加对 class 就自动有。

### `.reveal` — 逐条入场

进入视口时淡入上移。**加在「块」上，不要给正文 `<p>` 逐段加**——
一段一段淡入会让阅读变卡。模板示例把它加在这几处，照抄：

```
aside.aside · div.example · div.boundary · div.source · p.checkout
```

同一个直接父元素下的 `.reveal` 依次错开入场，**封顶 6 个**（第 7 个起不再叠加延迟）。
所以一个父元素下别塞十几个 `.reveal`，那样后面的会挤在一起。

幕封页三件套不加 `.reveal`——它是读者进入这一节的第一眼，淡入会让人以为没加载出来。

### `.draw` — SVG 描边动画

线条按顺序描出来。**只加在线条上**：`<path>` `<line>` `<polyline>`。
加在 `<rect>` `<circle>` 上不会报错（它们也有 `getTotalLength`），
但效果是沿着外框描一圈，观感是错的。文字不参与描边，想让文字淡入就单独给它 `.reveal`。

同一张 `<svg>` 内的 `.draw` 依次错开，同样**封顶 6 个**。

用法是叠在已有的线条 class 上：

```html
<path class="arrow-line draw" d="…" marker-end="url(#ld-arrow)"/>
```

已经用 `stroke-dasharray` 表达虚线语义的路径**不要再加 `.draw`**——两者会打架。

---

## 幕封页 `.curtain`

```html
<div class="curtain">
  <div class="curtain-num">01</div>
  <h2 class="curtain-title">前向加噪过程</h2>
  <p class="curtain-lede">…一句话定义…</p>
</div>
```

一屏高，只有大号章节号 + 标题 + 一句话定义。它是 `<div>` 不是 `<section>`，没有 `id`。

⚠️ **`.curtain-lede` 与紧跟其后 `.concept` 里的 `.lede` 是同一句话，必须逐字相同。**
这是「节首一句话定义」在两处的呈现（封面放大展示一次，进入正文时再见一次），
**不是各写一句，也不是为了不重复而拆成两半**。改这句话时两处一起改。
这句话怎么写，见 `references/writing.md` 第 1 条。

---

## ①–⑪ 各块填什么

| | 块 | class | 里面的位 |
|---|---|---|---|
| ① | 抬头 | `.deck-head` | `h1` 主题 · `p.meta` 「learning-deck · 日期」 · `p.for-whom` **基于访谈的起点画像**，不是套话 |
| ② | 知识地图 | `.map` | `figure > svg`。节点是 `g.node` 加三色之一，每个节点里用 `<a href="#…">` 包住 `rect` + `text`；连线 `.edge`；图例 `g.legend` 直接套同一套 class |
| ③ | 速通路径 | `.path` | `ol > li`：`<a href="#cN">§N 标题</a>（时间估计，一句提示）` + `<span class="answers">读完能回答：…</span>` |
| ④ | 前序速览 | `.primer` | `dl > dt/dd`，每条两三句话带过 |
| ⑤ | 知识点正文 | `.concept` | 见下面「节内固定顺序」 |
| ⑥ | 方法对比表 | `.compare` | `div.table-wrap > table`：假设 / 适用场景 / 代价 / 失效情形 |
| ⑦ | 收束节 | `.wrapup` | 把上面的点合起来回答「所以这东西到底在干什么」 |
| ⑧ | 术语对照表 | `.glossary` | `dt[id]` + `span.en` 英文 · `dd` 一句话解释 + `span.where` 首次出现在哪节 |
| ⑨ | 建议下一步 | `.next` | `h3` 分「必读 / 选读 / 该上手跑什么 / 下一个 learning-deck」，`li` + `span.why` |
| ⑩ | 文献清单 | `.refs` | `ol > li`，题名 + `a.ref-link`。DOI 优先，没有 DOI 才退到 arXiv id |
| ⑪ | 诚实边界 | `.honesty` | `ul > li`，逐条列，不写笼统的免责声明 |

### ② 知识地图的节点三色

| class | 含义 | 链到哪 |
|---|---|---|
| `.n-known` | 访谈里标「熟悉」 | 术语表的那一条 `#g-xxx` |
| `.n-focus` | 要重点补，正文有一节 | `#cN` |
| `.n-brief` | 一句话带过 | `#primer` |

「已掌握」的节点**同样要是锚点**——读者未必真记得，链到术语表比留一个死框有用。

### ⑤ 节内固定顺序（不要自由发挥）

```
<section class="concept" id="cN">
  <h2>标题 <span class="counter">第 N / M 个</span></h2>
  <p class="lede">一句话定义</p>                      ← 与幕封页那句逐字相同
  <aside class="aside reveal">依赖侧注「本节假设你已经知道 §X」</aside>
  <h3>它解决什么问题</h3>  <p>…</p>
  <div class="with-figure">
    <h3>机制</h3> <p>…</p>
    <figure><svg …></svg><figcaption><b>图 N</b> …</figcaption></figure>
  </div>
  <div class="example reveal"><span class="tag">举个例子</span><p>…</p></div>
  <div class="boundary reveal"><h3>常见误解与边界</h3><ul>…</ul></div>
  <div class="source reveal"><h3>出处</h3><ul>…</ul></div>
  <p class="checkout reveal"><b>读完这节你应该能回答：</b>…</p>
  <p class="back"><a href="#map">↑ 回知识地图</a></p>
</section>
```

- `.counter`「第 N / M 个」：长文档里缺少进度感是最主要的弃读原因。
- `.aside` 依赖侧注：访谈里标「熟悉」的那些正好填这里。
- `.with-figure`：**图与讲它的那段必须在同一个 `.with-figure` 里**，
  否则图会漂到下一屏，读者对不上。
- `.checkout` 的问题要**具体到能被回答**（「那个 √(1-β_t) 的缩放是干什么用的」），
  不是「你理解本节内容了吗」。
- `.example` 里装什么，见 `references/writing.md` 第 4 条——那是全篇最容易敷衍的一处。
- `.pointer` 指路卡片（结构同 `.example`：`span.tag` + 一段话 + 外链）只在**取不到原图、
  或当前模型看不见图**时用，指向原文那张图。**它不是 `.example`**，也不能拿来满足
  「每节至少一个例子」那条闸门——用法见 `references/figures.md`。

### 行内的两个

- `.term`：术语**首次出现**处加粗 + 链到 ⑧ 术语表（`<a class="term" href="#g-xxx">`）。
  后文再提不再加粗、不再链。
- `.formula` / `<code>`：等宽字体的行内公式或代码片段。

---

## 画 SVG

- **`viewBox` 宽 640，图内 `font-size` 不得低于 10。** 照抄模板里的数，别自己往下压。
- **颜色一律用模板的 class**（`.svg-label` `.svg-label-faint` `.svg-formula`
  `.arrow-line` `.arrow-head` `.svg-box` `.svg-frame` `.svg-hi` `.svg-rule`
  `.svg-fill-moss` `.svg-fill-amber` `.noise-dot`），**不要写 `fill="…"` / `stroke="…"` 属性**。
  唯一例外是 `fill="url(#…)"` 这种指向同文档 `<pattern>` / `<marker>` 的引用。
- **每张 `<svg>` 自带一套 `<defs>`、自用一套 id 前缀**，不要跨 svg 引用另一张图的 marker。
- 如果你引入了模板里没有的**填充 class**，必须回到 `@media print` 那一段登记一条，
  否则打印/导出时那张图会有一块隐身——**屏幕上完全看不出来**。
  能不新增就不新增，用现成的那几个。

---

## 明确不做的（写在这里是为了防止被当成漏做）

- **`<details>` 折叠区块。** 原生可用、不需要 JS，但折起来的内容在扫读和 ⌘F 里都消失了，
  对自学是负收益。
- **固定悬浮目录。** 要么挡正文，要么窄窗口下失效，导航由 ② 知识地图承担。
- **限死正文行宽。** v1 那条「32–36 个汉字」已作废：`.deck` 现在与 Markdown tab
  一样是 `padding: 32px 88px 120px`、不限宽。宽窗口下一行会到 70+ 汉字，
  这是用户明确要求的对齐代价，**不要用行内 style 或新容器把它改回去**。
- **外部资源与第二个 `<script>`。** 见 SKILL.md 的硬约束。

---

## 交付前自检

**固定用 `grep`。KyDog 不打包 ripgrep，`rg` 一定返回 127**，跑三次也一样。
（系统提示词那句「用 bash 做 ls / rg / find」已经从源头改成 `grep`，见
`src/main/agent/systemPrompt.ts`；这条仍然写在这里，因为模型也可能自己想用 `rg`。）
下面这份照抄，把 `报告.html` 换成实际文件名，**不要即兴发挥**：

```bash
# 1. 残留的示例内容（模板的例子讲的是扩散模型）
grep -n '扩散\|马尔可夫\|β_t\|ᾱ\|DDPM\|Sohl-Dickstein\|Ho et al\|ELBO\|噪声调度\|U-Net\|MNIST' 报告.html
#   判据与 #3 一样：命中**只应落在文件头注释里**（那段硬约束注释本身就写着
#   「示例内容讲的是『扩散模型』，纯属占位」，它是要保留的，不要去删）。
#   <body> 里一行都不该有。

# 2. 藏起来的没处理完的内容 —— 应该 0 行
grep -n 'hidden' 报告.html

# 3. 脚本块 —— 唯一的判据是这个数必须正好 1
grep -c '^<script>' 报告.html
grep -n '<script' 报告.html
#   这条会命中很多行（模板自带 9 处），全部落在注释里：文件头的硬约束、
#   <style> 里的两条、<body> 里的两条、脚本内部的一条 —— 它们都在**讲这条规则本身**，
#   不是违规，不要去删。真正要找的是第二个**行首的** <script> 标签。

# 4. 外部资源 —— 判据同 #1：命中只应落在文件头注释里
grep -n 'src="http\|@import\|url(http\|fonts.googleapis\|cdn\.\|unpkg\|fetch(\|XMLHttpRequest\|WebSocket' 报告.html
#   模板自带 4 处命中，都在文件头的硬约束注释里：三处在第 2 条（它本身就在列举
#   CDN / @import / img src="http…" / fetch 这些词），一处在第 3 条（「把它当资源
#   加载（img/link/@import）不允许」那句）。都不是违规。
#   <body> 里应该 0 行。指向论文的 <a href="http…"> 是链接不是资源，合法（这条 grep
#   也不查 href）；真出现在 img / link / @import / url() / 脚本里的，会被 CSP 拦掉，必须删。

# 5. 外链都带 target/rel —— 两个数必须相等
grep -o 'href="http' 报告.html | wc -l
grep -o 'target="_blank" rel="noopener"' 报告.html | wc -l

# 6. 写死的颜色 —— 逐条看，**只看 <body> 里的命中**
grep -n 'fill="#\|stroke="#\|color: *#\|background: *#' 报告.html
#   <body> 里只有 var(--x, #xxx) 这种带 fallback 的形态是合法的。
#   落在 <style> 的 @media print 那一段里的 6 处（#fff / #000）是模板自带的
#   打印兜底，本来就该写死，而且你被明令「<style> 一个字都不要改」—— 跳过它们。

# 7. 幕封页与正文节成对 —— 三个数必须相等
grep -c 'class="curtain"' 报告.html
grep -c 'class="concept"' 报告.html
grep -c 'class="lede"' 报告.html

# 8. 每节至少一个例子 —— 应 ≥ 上面的 .concept 数
grep -c 'class="example' 报告.html
```

第 7 组三个数不等，通常意味着某一节漏了幕封页、或者 `.curtain-lede` 和 `.lede` 写岔了。
第 8 组不达标，回 `references/writing.md` 第 4 条。
