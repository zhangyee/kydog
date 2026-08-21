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
    <div class="curtain" id="c1">              幕封页 · 第 1 节（章节锚点在这里）
    <section class="concept">                  ⑤ 知识点正文 · 第 1 节（无 id、无 h2）
    <div class="curtain" id="c2"> … <section class="concept"> …   （每节一对）
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
**唯一的例外是 `.concept`**：它靠 class 直接被选中，所以不需要 id——
章节的锚点在它前面那张幕封页上（见下面「幕封页」）。

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
| < 820px | 单栏 | 正文上方一条 **sticky 横条**（可折叠，滚动时贴在视口顶部） | 570px 居中，面板更窄时自适应 | 块级 |

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
          <li><a href="#c1">§1 …</a></li>   ← 有几节写几条；href 指向幕封页
        </ol>
      </li>
      …
    </ol>
  </div>
</nav>
```

⚠️ 条目与 `.flow` 里的锚点 **一一对应，手写维护**：少一条不报错，
只是那一节在目录里消失；`href` 指到不存在的 id 也不报错，只是点了不动
（交付前用「自检 · HTML 层」的 H4 查一遍，它会直接把指不到的锚点列出来）。
⚠️ 知识点那几条指向的是**幕封页**（`.curtain` 上的 `id`），不是正文 `.concept`——
点 §1 应该从这一节的封面进入。窄档下目录横条是 sticky 的，`:target` 的
`scroll-margin-top` 已经替你让开了它的高度（实测：横条底 68px、幕封页顶落在 66px）。
⚠️ 知识点条目写 `§N 标题`，其余条目**只写名字不编号**，见上面「编号记法」。
⚠️ `aria-expanded` / `aria-controls="toc-body"` 与 `.toc-body` 上的 `id="toc-body"`
要成对保留；当前项的 `aria-current="page"` 由脚本设，你不用写。
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

## 幕封页 `.curtain` —— 章节的标题、编号、锚点全在这里

```html
<div class="curtain" id="c1">
  <div class="curtain-num">§1</div>
  <h2 class="curtain-title">前向加噪过程</h2>
  <p class="curtain-lede">…一句话定义…</p>
</div>
```

一屏高，只有大号章节号 + 标题 + 一句话定义。它是 `<div>` 不是 `<section>`。

⚠️ **章节的 `id` 在幕封页上，不在 `.concept` 上。** 目录里的「§1 …」、速通路径、
知识地图节点、正文里的「见 §2」，指的都是这个 id——读者点过去应该落在封面上，
从这一节的开头进入。`.concept` 不带 id（方向键靠 class 选中它，见上面那条 ⚠️）。

⚠️ **幕封页承担这一节的全部标题与编号，正文里一个都不再出现。**
`.concept` 里**没有 `<h2>`**、**没有 `.counter`**：正文第一个元素就是 `.lede`，
第一个标题是「它解决什么问题」那个 `<h3>`。
理由是实跑暴露的：v2 加幕封页时只把「一句话定义」去了重，标题和编号各留了两份，
而且编号两种记法（封面 `01` vs 正文 `第 1 / 4 个`），用户的原话是
「我以为第一章下面有 4 点，结果看到后面才知道是一共 4 章」。
代价是滚到章节中段时屏上没有章节名——由左侧目录的当前项高亮补偿，这是取舍不是漏做。

⚠️ **`.curtain-lede` 与紧跟其后 `.concept` 里的 `.lede` 是同一句话，必须逐字相同。**
这是「节首一句话定义」在两处的呈现（封面放大展示一次，进入正文时再见一次），
**不是各写一句，也不是为了不重复而拆成两半**。改这句话时两处一起改。
这句话怎么写，见 `references/writing.md` 第 1 条。

### 编号记法：全篇只有 `§N` 一种

| 出现在哪 | 写成 |
|---|---|
| 幕封页的 `.curtain-num` | `§1` |
| `.toc-sub` 的条目 | `§1 前向加噪过程` |
| ③ 速通路径里指向知识点的条目 | `§1 前向加噪过程` |
| ② 知识地图 `.n-focus` 节点的副标 | `要重点补 · §1` |
| 正文 / 侧注里的交叉引用 | `见 <a href="#c2">§2</a>` |
| ⑧ 术语表的 `.where` | `首次出现 §1` |

⚠️ **`§` 只留给 ⑤ 知识点章节。** ⑥ 方法对比、⑦ 收束这些辅助小节**不编号**——
在目录和速通路径里只写名字，顺序由列表本身表达。把「§3 方法对比」写进速通路径，
读者就数不清一共几章了。引用论文自己的章节时写「原文第 2–3 节」，别也用 `§`。

⚠️ **不要写 `01` / `第 1 章` / `第 N / M 个`。** 「封面写 `01`、目录写 `§1`」
这种同一个东西两种记法，正是这次统一掉的东西。

---

## ①–⑪ 各块填什么

| | 块 | class | 里面的位 |
|---|---|---|---|
| ① | 抬头 | `.deck-head` | `div.hero-art`（动效层，**整块原样保留**：里面的 `canvas.hero-gl` 是 WebGL 那层、`svg.hero-fallback` 是它起不来时的兜底，两个都别删）· `h1` 主题 · `p.meta` 顶部三件套的后两样（见下）· `p.for-whom` **基于访谈的起点画像**，不是套话 |
| ② | 知识地图 | `.map` | `figure > svg`，**照 `map.sketch` 现画**（JSON 里没有这张图的标记）。节点是 `g.node` 加三色之一，每个节点里用 `<a href="#…">` 包住 `rect` + `text`；连线 `.edge`；图例 `g.legend` 直接套同一套 class |
| ③ | 速通路径 | `.path` | `ol > li`：`<a href="#cN">§N 标题</a>（时间估计，一句提示）` + `<span class="answers">读完能回答：…</span>`。辅助小节（前序速览 / 方法对比 / 收束）也可以进这张路径表，但**不带 `§` 编号**，只写名字 |
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

⚠️ **这个顺序不用你守，它是渲染出来的。** `.lede` / `.aside` / `.boundary` /
`.source` / `.checkout` / `.back` 在 `.learning-deck` JSON 里是章的固定槽位，
位置由 `references/deck-json.md` 的渲染对照表定死；能自由排的只有中间那段
`blocks`（`prose` / `figure` / `eq` / `example` / `pointer` 五种）。
下面这张图是渲染出来的样子，**照它核对，不要照它手打**。

⚠️ **节首没有 `<h2>`、没有 `.counter`、也没有 `id`**——三样都在前面那张幕封页上，
见「幕封页」。看到旧版「节首要有 h2」「`.counter` 给读者进度感」的说法，那是 v3 的，
已经作废；正文直接从 `.lede` 起。

```
<section class="concept">
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

- 长文档里的进度感由**顶部进度条 + 左侧目录的当前项高亮**给，不再有文字计数。
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

**图在第 5.5 小步（渲染）才画，不在 JSON 里。** JSON 给的是「画什么」——
`figure` 块的 `sketch`（`form` 骨架 / `elements[]` 画哪些东西与各自身上那行字 /
`emphasis` 最要紧的那一处）和 ② 知识地图的 `map.sketch`（另有 `nodes[]` / `edges[]`），
形状见 `references/deck-json.md`。**这一节管「怎么画」，那一册管「画什么」，
两边不重叠**：`sketch` 里不写坐标、颜色、class、viewBox，下面这些也不由 `sketch` 覆盖。

`emphasis` 指的那一处，渲染时就是套 `.svg-hi` 的那个元素。

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
- **正文与章节幕封页的 WebGL 背景。** 通篇铺 GPU 动效的代价（发热、掉电、
  长文档里一直在跑）换不来任何阅读上的好处。**只有 ① 抬头那一层是 WebGL**，
  理由是它滚过去就不在视口里了（模板脚本用 IntersectionObserver 把 rAF 停掉）。
  抬头那块代码模板已经写好，**你什么都不用做**——别把它复制到别处。
- **正文里的 `<h2>` 和 `.counter`。** 见上面「幕封页」：标题与编号只在幕封页出现一次。

> 上一版这里还写着「固定悬浮目录」和「限死正文行宽」两条排除。
> **两条都在 v3 被推翻了**（见上面「三栏与它的退化」），别再照旧版删目录、放行宽。
> 同样地，「不引 WebGL」这条在 v4 被收窄成「正文与幕封页不引」——抬头那一层现在是
> 内联 shader 的 WebGL（零外部库、零外部资源），别按旧说法把它删掉。

---

## 交付前自检 · HTML 层

**自检分两层。** 结构类的判据（块计数、每章有没有例子、术语是否都进了 glossary、
编号记法、图的来源）全部在 JSON 上核，见 `references/deck-json.md` 的「JSON 层自检」——
JSON 小到可以读完，那些判据在那里是**直接断言**，不像在两千行 HTML 上只能拿 `grep` 数 class
当结构的代理。

**这里只留渲染之后才成立的四组**：示例内容清没清干净、模板骨架有没有被动过、
外链形态、锚点指不指得到。第 5.6 小步跑一次，**只跑一次**——
上一轮跑了三遍是浪费（而且那三遍之间是拿 python 改的文件，正是要禁的那件事）。

**固定用 `grep`。KyDog 不打包 ripgrep，`rg` 一定返回 127**，跑三次也一样。
（系统提示词那句「用 bash 做 ls / rg / find」已经从源头改成 `grep`，见
`src/main/agent/systemPrompt.ts`；这条仍然写在这里，因为模型也可能自己想用 `rg`。）
下面这份照抄，把 `报告.html` 换成实际文件名，**不要即兴发挥**：

```bash
# H1. 残留的示例内容（模板的例子讲的是扩散模型）
grep -n '扩散\|马尔可夫\|β_t\|ᾱ\|DDPM\|Sohl-Dickstein\|Ho et al\|ELBO\|噪声调度\|U-Net\|MNIST' 报告.html
#   命中**只应落在文件头注释里**（那段硬约束注释本身就写着「示例内容讲的是
#   『扩散模型』，纯属占位」，它是要保留的，不要去删）。<body> 里一行都不该有。
#   这一条也顺带查「藏起来没处理完的内容」：JSON 里没有藏东西的地方，
#   渲染又是照对照表贴的，所以示例文字要么被替换掉、要么整节被删，不该剩。

# H2. 模板骨架没被动过 —— 三条都只应命中文件头 / <style> 里的注释
grep -c '^<script>' 报告.html
#   唯一的判据是这个数正好 1。<script 这个词模板自带 11 处命中，全在注释里
#   （文件头的硬约束、<style> 里几条、<body> 里几条、脚本内部一条），它们在
#   **讲这条规则本身**，不是违规。真正要找的是第二个**行首的** <script> 标签。
grep -n 'src="http\|@import\|url(http\|fonts.googleapis\|cdn\.\|unpkg\|fetch(\|XMLHttpRequest\|WebSocket' 报告.html
#   模板自带 4 处命中，都在文件头的硬约束注释里（第 2 条本身在列举 CDN / @import /
#   img src="http…" / fetch 这些词，第 3 条那句「把它当资源加载」）。都不是违规。
#   <body> 里应该 0 行。指向论文的 <a href="http…"> 是链接不是资源，合法（这条 grep
#   也不查 href）；真出现在 img / link / @import / url() / 脚本里的会被 CSP 拦掉，必须删。
grep -n 'fill="#\|stroke="#\|color: *#\|background: *#' 报告.html
#   <body> 里只有 var(--x, #xxx) 这种带 fallback 的形态是合法的。
#   落在 <style> 的 @media print 那一段里的 10 处（#fff / #000）是模板自带的
#   打印兜底，本来就该写死，而且你被明令「<style> 一个字都不要改」—— 跳过它们。

# H3. 外链都带 target/rel —— 两个数必须相等
grep -o 'href="http' 报告.html | wc -l
grep -o 'target="_blank" rel="noopener"' 报告.html | wc -l

# H4. 指不到的页内锚点 —— 应该 0 行（直接吐出坏锚点，不要靠人眼比对两份清单）
comm -23 \
  <(grep -o '<a href="#[a-zA-Z0-9_-]*"' 报告.html | sed 's/.*#//;s/"//' | sort -u) \
  <(grep -o 'id="[a-zA-Z0-9_-]*"' 报告.html | sed 's/id="//;s/"//' | sort -u)
#   左边是所有页内锚点（目录条目、知识地图节点、正文里的 §N 链接、术语链接），
#   右边是所有 id。输出的每一行都是「点了不动」的死链接——**不报错**，
#   所以必须靠这条查。模板原样跑这条输出为空。
#   JSON 层第 J-C 组已经核过 href 的目标存不存在，这一条查的是**渲染有没有把
#   对应的 id 真的写出来**（比如某章插进去时 .curtain 的 id 漏了），只有渲染后才成立。
#   ⚠️ 这条 sed 是**读**，不是改报告：它在管道里把 grep 的输出削成 id，
#      一个字节都没写回文件。SKILL.md 第 5 条禁的是拿 sed/perl/python 去**改**
#      报告文件，跟这里不冲突，照抄就是了。
```

**H1 有命中、或 H4 吐出坏锚点，说明渲染贴漏了一处**——回第 5.5 小步把那一章重渲一遍，
**不要只在 HTML 上补**（见 SKILL.md 硬约束第 6 条：HTML 是产物，改动的源头在 JSON）。
H2 有 `<body>` 里的命中，分两种：

- 命中落在某张 `<svg>` 里（写死了 `fill="#…"` / `stroke="#…"`）——那是**画法**写错了，
  **直接在 HTML 上把它改成模板的颜色 class**，JSON 不用动，JSON 里本来就没有画法
  （见 SKILL.md 硬约束第 6 条的三分表）。
- 命中落在正文标记里（`<img src="http…">`、`@import`、行内 `color: #…`）——
  那是 JSON 里那段 `html` 本身就写错了，**回 JSON 改**，改完把同一行贴进 HTML。
