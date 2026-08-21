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
<div class="deck">                            ← 三列网格：目录 | 正文 | 边注轨道
  <nav class="toc">                           左侧导航树（条目要手写维护）
  <main class="flow">                         正文列，整篇一个
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
  </main>
</div>
<script> … </script>                                         ← 全文唯一的脚本块
```

⚠️ **新增的 `<section>` 必须带 `id`。** 方向键的停靠点是
`.curtain, .concept, section[id]` 这三样；一个裸 `<section>` 三样都不沾，
方向键会直接跳过它——不报错，读者只会觉得这一屏「按不到」。

⚠️ **不要给 `.flow` 或 `.deck` 加 `style`、`position` 或 `overflow`。**
`position` 会把 `.curtain` / `.concept` 的 `offsetTop` 参照系从文档挪到它身上
（方向键整体落偏）；`overflow` 会把文档滚动搬家（进度条和 scroll-snap 一起失效）。
两种都不报错。

---

## 三栏与它的退化（v3）

`.deck` 是一个三列网格：**左目录 + 中正文（锁 38em ≈ 一行 35 个汉字 / 67 个西文字符）
+ 右边注轨道**。宽度不够时按实测断点退化，**你什么都不用做，加对 class 就是了**：

| 报告面板宽度 | 形态 | 目录 | 正文列 | `.aside` |
|---|---|---|---|---|
| ≥ 1180px | 三栏 | 左侧 sticky 树 | 570px（35 汉字） | 右浮动的 Tufte 边注 |
| 820–1179px | 两栏 | 左侧 sticky 树（收窄） | 570px | 块级，在正文里顺流排 |
| < 820px | 单栏 | 正文上方一条 sticky 横条（可折叠） | 570px 居中，面板更窄时自适应 | 块级 |

⚠️ **KyDog 默认窗口（1280px，左会话列表 + 右 Inspector）下报告面板只有约 738px，
落在单栏那一档。** 三栏要拉宽窗口或收起一侧面板才看得到。别以为三栏坏了。

⚠️ 这里有两处相对 v1/v2 的**有意反转**，模板注释里也写着，别按旧说法改回去：
1. v1/v2 曾明确排除「固定悬浮目录」——**现在要做**（`.toc` 是网格里的一列，
   不是浮在正文上的 fixed 面板，挡不到正文）。
2. v2 让正文「对齐 Markdown tab、不限宽」，连带「已知代价：一行 70+ 汉字」——
   **一并作废**，正文回到定宽。

---

## 交互组件（模板脚本已经接好，你只管加 class）

### `.progress` / `#progress-bar` — 顶部进度条

模板里已经有一份，**不要再写第二份、也不要删**。宽度由文末脚本按滚动位置算。
它是 sticky 2px 细线，是「顶部三件套」的第一样（另外两样见 ① 抬头）。

### `.toc` — 左侧导航树

模板里已经有一份，**不要再写第二份、也不要删**。折叠按钮与当前项高亮
（`.is-current`）由文末脚本接好，**你唯一要做的是把条目改成这份报告真实的章节**：

```html
<nav class="toc" aria-label="章节导航">
  <button class="toc-head" type="button" aria-expanded="true">
    <span class="toc-caret" aria-hidden="true"></span>目录
  </button>
  <div class="toc-body">
    <ol class="toc-list">
      <li><a href="#map">知识地图</a></li>
      …
      <li>
        <div class="toc-group">知识点</div>
        <ol class="toc-sub">
          <li><a href="#c1">§1 …</a></li>   ← 有几节写几条
        </ol>
      </li>
      …
    </ol>
  </div>
</nav>
```

⚠️ 条目与 `.flow` 里的 `section id` **一一对应，手写维护**：少一条不报错，
只是那一节在目录里消失；`href` 指到不存在的 id 也不报错，只是点了不动。
⚠️ 只有知识点那一组用 `.toc-sub` 嵌一层，别把 ①–⑪ 全做成树。

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
| ① | 抬头 | `.deck-head` | `div.hero-art`（动效层，原样保留）· `h1` 主题 · `p.meta` 顶部三件套的后两样（见下）· `p.for-whom` **基于访谈的起点画像**，不是套话 |
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

## ① 抬头的顶部三件套

进度条（`.progress`，模板已有）+ **预计阅读时间** + **最后更新日期**，后两样写在
`p.meta` 里，用 `<span class="meta-sep">` 隔开：

```html
<p class="meta">
  <span>learning-deck</span>
  <span class="meta-sep" aria-hidden="true"></span>
  <span>约 12 分钟</span>
  <span class="meta-sep" aria-hidden="true"></span>
  <time datetime="2026-08-20">最后更新 2026-08-20</time>
</p>
```

⚠️ **阅读时间在你生成报告时算好写死，不要写 JS 去数。**
算法：`<body>` 里正文的可见汉字数 ÷ 350（中文技术材料 300–400 字/分取中值），
向上取整，每张图再 +0.5 分钟；不含 ⑩ 文献清单与 SVG 里的标注。
算出来不到 5 就写「约 5 分钟」。

⚠️ 日期就是生成日期，`datetime` 用 ISO 形式，和文字里那个保持一致。

---

## 公式：原生 MathML

**不要引 KaTeX / MathJax**——它们是外部资源，CSP 会直接拦掉，页面上只会剩一段生源码。
Chromium 原生支持 MathML Core，已实测在这套 sandbox + CSP 下是真排版。

三种写法，按复杂度选，别混用：

| 情况 | 写法 |
|---|---|
| 一个符号 / 一小段记号（`x_t`、`β_t`、`N(0, I)`） | `<span class="formula">x_t</span>` |
| 行内但真的有上下标 / 根号 / 分式叠起来 | 行内 `<math>…</math>`（不写 `display`） |
| 单独成行的关键式子 | `.eq` 包裹框（下面这个结构） |

```html
<div class="eq">
  <div class="eq-body">
    <math display="block">
      <mrow>
        <msub><mi>x</mi><mi>t</mi></msub>
        <mo>=</mo>
        <msqrt><msub><mi>α</mi><mi>t</mi></msub></msqrt>
        <mo>&#x2062;</mo>            <!-- invisible times，别用 · 或 * -->
        <msub><mi>x</mi><mn>0</mn></msub>
      </mrow>
    </math>
  </div>
  <span class="eq-num">(1)</span>     <!-- 编号可省；要编就从 (1) 顺下去 -->
</div>
```

常用元素：`<mi>` 变量 · `<mn>` 数字 · `<mo>` 运算符 · `<msub>` `<msup>` 上下标 ·
`<msqrt>` 根号 · `<mfrac>` 分式 · `<mover accent="true">` 加横线（`ᾱ` 写成
`<mover accent="true"><mi>α</mi><mo>&#xAF;</mo></mover>`）· `<mrow>` 分组。
模板里两个 `.eq` 示例覆盖了这些，照抄改。

⚠️ **长推导不要写。** MathML Core 的排版质感不如 KaTeX，希腊字母和数学符号会落到
系统字体；下标、分式、求和够用，一屏高的推导会显得糙——那种情况改成一句话讲清楚
它在干什么，把推导留给 ⑩ 里的原文。

⚠️ `.eq` 的三层结构（`.eq` > `.eq-body` > `math`）不要省中间那层：长公式靠它
自己横向滚动，少了它会撑破正文列。

---

## 画 SVG

- **`viewBox` 宽 640，图内 `font-size` 不得低于 12。**（v3 从 10 提到 12：正文列
  锁定行宽之后图变窄了，两栏/单栏下缩放比约 0.89，12 号字渲染出来才刚够 10.7px。
  实测区间见模板里「SVG 里的共用件」那段。）照抄模板里的数，别自己往下压。
- **颜色一律用模板的 class**（`.svg-label` `.svg-label-faint` `.svg-formula`
  `.arrow-line` `.arrow-head` `.svg-box` `.svg-frame` `.svg-hi` `.svg-rule`
  `.svg-fill-moss` `.svg-fill-amber` `.noise-dot`），**不要写 `fill="…"` / `stroke="…"` 属性**。
  唯一例外是 `fill="url(#…)"` 这种指向同文档 `<pattern>` / `<marker>` /
  `<radialGradient>` 的引用。
- **每张 `<svg>` 自带一套 `<defs>`、自用一套 id 前缀**，不要跨 svg 引用另一张图的 marker。
- 如果你引入了模板里没有的**填充 class**，必须回到 `@media print` 那一段登记一条，
  否则打印/导出时那张图会有一块隐身——**屏幕上完全看不出来**。
  能不新增就不新增，用现成的那几个。

---

## 明确不做的（写在这里是为了防止被当成漏做）

- **`<details>` 折叠区块。** 原生可用、不需要 JS，但折起来的内容在扫读和 ⌘F 里都消失了，
  对自学是负收益。（`.toc` 的折叠不走 `<details>`，走脚本里的一个按钮——脚本没跑起来
  时目录停在展开状态，不会有任何内容被折没。）
- **自测卡 / 内联可运行代码 / slides 形态。** 三样都是用户明确决定不做的，
  未来可能拆成独立 skill。**不要顺手加回来。**
- **外部数学排版库（KaTeX / MathJax）。** 见上面「公式：原生 MathML」。
- **外部资源与第二个 `<script>`。** 见 SKILL.md 的硬约束。

> 上一版这里还写着「固定悬浮目录」和「限死正文行宽」两条排除。
> **两条都在 v3 被推翻了**（见上面「三栏与它的退化」），别再照旧版删目录、放行宽。

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
grep -n 'hidden' 报告.html | grep -v 'aria-hidden' | grep -v 'overflow: hidden'
#   两个 grep -v 是必须的：模板自己用 aria-hidden="true" 标了三处**纯装饰**
#   （抬头的动效层 .hero-art、目录的小三角 .toc-caret、meta 里的分隔点 .meta-sep），
#   还有 .hero-art 的 overflow: hidden —— 它们是要保留的。
#   这一条查的是 SKILL.md 第 6 条禁的那种「把没处理完的示例内容藏起来」。

# 3. 脚本块 —— 唯一的判据是这个数必须正好 1
grep -c '^<script>' 报告.html
grep -n '<script' 报告.html
#   这条会命中很多行（模板自带 11 处），全部落在注释里：文件头的硬约束、
#   <style> 里的几条、<body> 里的几条、脚本内部的一条 —— 它们都在**讲这条规则本身**，
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
#   落在 <style> 的 @media print 那一段里的 10 处（#fff / #000）是模板自带的
#   打印兜底，本来就该写死，而且你被明令「<style> 一个字都不要改」—— 跳过它们。

# 7. 幕封页与正文节成对 —— 三个数必须相等
grep -c 'class="curtain"' 报告.html
grep -c 'class="concept"' 报告.html
grep -c 'class="lede"' 报告.html

# 8. 每节至少一个例子 —— 应 ≥ 上面的 .concept 数（模板注释里另有 1 处命中，
#    在 .pointer 那段 CSS 注释里，所以真实门槛是「这个数 − 1 ≥ .concept 数」）
grep -c 'class="example' 报告.html

# 9. 目录条目都指得到 —— 两份清单要对得上（人工比对，不是数字相等）
grep -o 'class="toc[^"]*"' 报告.html | head -3     # 确认 .toc 那一块还在
grep -o '<a href="#[a-zA-Z0-9_-]*"' 报告.html | sort -u
grep -o 'id="[a-zA-Z0-9_-]*"' 报告.html | sort -u
#   前者是所有页内锚点（含目录条目与知识地图节点），后者是所有 id。
#   每个 href="#x" 都要能在第二份里找到 id="x"；找不到就是点了不动，**不报错**。
```

第 7 组三个数不等，通常意味着某一节漏了幕封页、或者 `.curtain-lede` 和 `.lede` 写岔了。
第 8 组不达标，回 `references/writing.md` 第 4 条。
