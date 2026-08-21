# 版式与组件 · layout.md

模板 `assets/report-template.html` 已经定义好全部样式。这一册只写
**「这个块长什么样、什么时候用、里面填什么」**，不重复模板里的 CSS——
样式一个字都不要改。

⚠️ **v5 起模板 `<body>` 里没有任何示例内容了**（一份都没有：不只是章节，
知识地图、前序速览、术语表、参考文献……全部只剩一个带 `⟨待填⟩` 的注释占位）。
所以**可以照抄的完整样例现在全在这一册里**，见下面「② 知识地图：一张画完的图」
与「④ 一章画完的样子」两节。为什么这么改，见「④ 知识点正文」那一节开头。

**不要自己造 class。** 模板里没有的 class 名不会有任何样式，写出来就是一段裸文字，
而且**不报错**。同理**不要给正文加行内 `style`**——没有例外：连内嵌原图的 `<img>` 也不用，
模板里的 `figure img` 已经管好了缩放。

---

## 整篇的骨架

```
<div class="deck">                            ← 三列网格：目录 | 正文 | 边注轨道
  <nav class="toc">                           左侧导航树（条目要手写维护）
  <main class="flow">                         正文列，整篇一个
    <header class="deck-head">        ① 抬头
    <section class="map"      id="map">        ② 知识地图
    <section class="primer"   id="primer">     ③ 前序速览
    <div class="curtain" id="c1">              幕封页 · 第 1 节（章节锚点在这里）
    <section class="concept">                  ④ 知识点正文 · 第 1 节（无 id、无 h2）
    <div class="curtain" id="c2"> … <section class="concept"> …   （每节一对）
    <section class="compare"  id="compare">    ⑤ 方法对比表（主题是「某个方法」时才有）
    <section class="summary"  id="summary">    ⑥ 总结节
    <section class="glossary" id="glossary">   ⑦ 术语对照表
    <section class="next"     id="next">       ⑧ 建议下一步
    <section class="refs"     id="refs">       ⑨ 参考文献
    <section class="honesty"  id="honesty">    ⑩ 诚实边界
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
（方向键整体落偏）；`overflow` 会把文档滚动搬家（scroll-snap 一起失效）。
两种都不报错。

### v5 的四处删改（别按旧说法补回来）

| 变的东西 | 现在 | 为什么 |
|---|---|---|
| 顶部进度条 `.progress` | **删掉了** | 左栏目录的 `.is-current` 已经给了位置感，而进度条为了显示进度必须常驻一条灰轨道，让这个 tab 顶部跟其它 tab 不统一 |
| ③ 速通路径 `.path` | **删掉了** | 章节本来就按依赖顺序排、目录也把顺序摆在左边，它只是把同一串标题换个说法再列一遍 |
| ⑦ 收束节 | 改叫 **⑥ 总结**（class / id / JSON 字段都是 `summary`） | 「收束」是黑话，读者看不懂 |
| ⑩ 文献清单 | 改叫 **⑨ 参考文献**，且正文引用改成**两跳** | 见下面「⑨ 参考文献与两跳引用」 |

编号因此从 ①–⑪ 变成 ①–⑩。

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

### `.toc` — 左侧导航树

模板里已经有一份，**不要再写第二份、也不要删**。折叠按钮与当前项高亮
（`.is-current`）由文末脚本接好，**你唯一要做的是把条目改成这份报告真实的章节**：

```html
<nav class="toc" aria-label="章节导航">
  <button class="toc-head" type="button" aria-expanded="true" aria-controls="toc-body">
    <span class="toc-caret" aria-hidden="true"></span>目录
  </button>
  <div class="toc-body" id="toc-body">
    <ol class="toc-list">
      <li><a href="#map">知识地图</a></li>
      <li><a href="#primer">前序速览</a></li>
      <li>
        <div class="toc-group">知识点</div>
        <ol class="toc-sub">
          <li><a href="#c1">§1 …</a></li>   ← 有几节写几条；href 指向幕封页
        </ol>
      </li>
      <li><a href="#compare">方法对比</a></li>
      <li><a href="#summary">总结</a></li>
      <li><a href="#glossary">术语对照</a></li>
      <li><a href="#next">建议下一步</a></li>
      <li><a href="#refs">参考文献</a></li>
      <li><a href="#honesty">诚实边界</a></li>
    </ol>
  </div>
</nav>
```

⚠️ 条目与 `.flow` 里的锚点 **一一对应，手写维护**：少一条不报错，
只是那一节在目录里消失；`href` 指到不存在的 id 也不报错，只是点了不动
（交付前用「自检 · HTML 层」的 H4 查一遍，它会直接把指不到的锚点列出来）。
⚠️ 知识点那几条指向的是**幕封页**（`.curtain` 上的 `id`），不是正文 `.concept`——
点 §1 应该从这一节的封面进入。窄档下目录横条是 sticky 的，`:target` 的
`scroll-margin-top` 已经替你让开了它的高度。
⚠️ **`compare` 是 `null` 时，把「方法对比」这条连同正文那一整节一起删掉。**
只删一边会留下一个点了不动的死锚点。
⚠️ 知识点条目写 `§N 标题`，其余条目**只写名字不编号**，见下面「编号记法」。
⚠️ `aria-expanded` / `aria-controls="toc-body"` 与 `.toc-body` 上的 `id="toc-body"`
要成对保留；当前项的 `aria-current="page"` 由脚本设，你不用写。
⚠️ 只有知识点那一组用 `.toc-sub` 嵌一层，别把 ①–⑩ 全做成树。

### 方向键 / scroll-snap

`↓` `→` 下一节、`↑` `←` 上一节、`Home` / `End` 到首尾。
`.curtain` 与 `.concept` 参与 scroll-snap 吸附，辅助小节不吸附但仍是方向键的停靠点。
**这些都不用你做任何事**，加对 class 就自动有。

### `.reveal` — 逐条入场

进入视口时淡入上移。**加在「块」上，不要给正文 `<p>` 逐段加**——
一段一段淡入会让阅读变卡。固定加在这几处，照抄：

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

已经用 `stroke-dasharray` 表达虚线语义的路径**不要再加 `.draw`**——两者会打架
（描边动画会用行内 `style.strokeDasharray` 覆盖那个属性，动画播完虚线变实线）。

### 抬头的封面带 `.hero-band`

模板已有。它是 `<body>` 的**直接子元素**（在 `<div class="deck">` 之前），不在
`.deck-head` 里——满幅铺开需要这个位置，别把它搬进去。里面 `canvas.hero-canvas`
是动效那层，`svg.hero-fallback` 是它起不来时的兜底，两个都不能删。它是纯装饰
（`aria-hidden="true"`），任何信息都不许只画在这里。**别把它复制到别处**——
只有抬头用 WebGL / canvas，理由见下面「明确不做的」。

**整块原样保留，唯一要动的是 `data-hero` 那一个值**：

```html
<div class="hero-band" data-hero="gridwave" aria-hidden="true">
```

三个合法值 —— `gridwave`（扫描线 · HUD）· `constellation`（知识星丛）·
`holoband`（全息色散）。取 JSON 顶层的 `hero` 字段，怎么由主题简称定出来见
SKILL.md 第 5.1 小步。写错、写别的值、或者整个属性没写都退回 `gridwave`
（确定的兜底，不是随机）。

⚠️ **别删这条带。** 抬头的 `h1` / `p.meta` / `p.for-whom` 在模板 CSS 里用的是
`--hb-fg`（深色带上的浅色）。带删了，标题就是浅色压在浅纸上——**看不见，而且不报错**。

⚠️ **换一张脸只要改这一个值**（JSON 的 `hero` 与 HTML 的 `data-hero` 保持一致），
不用重渲整份报告。

---

## 幕封页 `.curtain` —— 章节的标题、编号、锚点全在这里

```html
<div class="curtain" id="c1">
  <div class="curtain-num">§1</div>
  <h2 class="curtain-title">按导联还是按整条记录归一化</h2>
  <p class="curtain-lede">…一句话定义…</p>
</div>
```

一屏高，只有大号章节号 + 标题 + 一句话定义。它是 `<div>` 不是 `<section>`。

⚠️ **章节的 `id` 在幕封页上，不在 `.concept` 上。** 目录里的「§1 …」、
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
**不是各写一句，也不是为了不重复而拆成两半**。
JSON 里它只写一次（`chapters[].lede`），渲染时贴到两处，所以这条是**结构上做不到不一致**。

### 编号记法：全篇只有 `§N` 一种

| 出现在哪 | 写成 |
|---|---|
| 幕封页的 `.curtain-num` | `§1` |
| `.toc-sub` 的条目 | `§1 按导联还是按整条记录归一化` |
| ② 知识地图 `.n-focus` 节点的副标 | `要重点补 · §1` |
| 正文 / 侧注里的交叉引用 | `见 <a href="#c2">§2</a>` |
| ⑦ 术语表的 `.where` | `首次出现 §1` |

⚠️ **`§` 只留给 ④ 知识点章节。** ⑤ 方法对比、⑥ 总结这些辅助小节**不编号**——
在目录里只写名字，顺序由列表本身表达。
引用论文自己的章节时写「原文第 2–3 节」，别也用 `§`。

⚠️ **不要写 `01` / `第 1 章` / `第 N / M 个`。** 「封面写 `01`、目录写 `§1`」
这种同一个东西两种记法，正是这次统一掉的东西。

---

## 事后改结构：删一章 / 插一章 / 换顺序

**这一节是交付之后的主路。** SKILL.md 第 5.2 小步不再停下来跟用户确认提纲，
所以「章节不对」这件事只会在**报告已经交付之后**被发现——那时候的补救就是这一节。

改一句话很便宜（在 JSON 上 `edit` 一行，同一个 `oldText` / `newText` 再贴进 HTML，
两次调用），**改结构不是**：章号 `§N` 全篇连续、`id === "c" + number`、
目录条目、知识地图节点、页内锚点、图号、术语表的 `where` 全都跟着动。
上面「编号记法」那张表就是这份检查清单：**`§N` 出现在哪几处，就要改哪几处。**

三条通则，先看清楚再动手：

- **一律先改 JSON，改完再改 HTML。两边都改完之前不要说完成。**
  只改 HTML 会让 JSON 变成一份骗人的存档，而且不报错（SKILL.md 硬约束第 6 条）。
- **改号有方向**：**删章从小到大改**（旧号已经空出来了，撞不上）；
  **插章从大到小改**（先把最后一章 N→N+1，再 N-1→N……）。
  方向反了，新号会撞上还没改的旧号，`edit` 匹配到错的那一处，**而且不报错**。
- **改章号不需要重渲那一章。** 正文 `.concept` 里没有 `<h2>`、没有 `.counter`
  （见上面「幕封页」那条），章号只在幕封页的 `id` 与 `.curtain-num` 两处，
  这两处相邻，一次 `edit` 就换掉了。真正要重渲的只有**新插入的那一章**。

### 删掉 §K（原有 N 章）

**JSON（`.learning-deck-*.json`），一步都不要跳：**

1. 删掉 `chapters[]` 里 K 那一项。
2. **K+1 到 N 每一章**：`number` 减 1，`id` 改成 `"c" + 新 number`（J-A 1 要求两者一致，
   不许只改一个）。这两个字段是相邻两行，**一章一次 `edit`** 就换掉了。**从小到大改。**
3. **全文搜 `#c`**（`grep -n '#c' .learning-deck-<简称>-<日期>.json`，只读，允许）：
   每个 `href="#cX"` 与紧挨着它的 `§X` 字面都跟新号走
   （出现在 `lede` / `aside` / `blocks[].html` / `blocks[].intro` / `boundary[]` /
   `source[]` / `checkout` 里）。**指向被删那章的引用不许留**——要么改指到别处，
   要么把那句话整句删掉。
4. `map.sketch`：删掉 `href: "#cK"` 那个 `state: "focus"` 节点，以及 `edges[]` 里
   两端提到它 `label` 的每一条；其余节点的 `href` 跟新号走。
   删完读一遍：有没有节点因此变成孤立的？`emphasis` 说的那条边还在不在？在就留着，不在就重写。
5. `glossary[]`：`where` 是 `§K` 的那几条——那个术语在剩下的正文里第一次出现在哪一节，
   `where` 就改成哪一节；**只在被删那章出现过的，整条删掉**（正文里没有的词不该占术语表）。
   其余 `where` 里大于 K 的号一律减 1。
6. **图号**：`num` 从 1（`map` 那张）连续数下来（J-B 10）。被删那章有几张图，
   K 之后每个 `figure.num` 就减去几。
7. `references[]`：被删那章 `source[]` 里引到的每一个 `r-` id，全文再搜一遍——
   没有别处引它了就把那条删掉（J-E 18：列一条谁也没引的文献，说明它没进这份报告）。
8. `readingMinutes` 重算（算法见 `deck-json.md` 顶层那一节）。
9. `summary` / `next` / `primer` / `honesty` / `forWhom` 里点名提到那一章的句子，逐句改掉。
10. 重跑 JSON 层自检的 **J-A / J-C / J-D** 三组（编号、锚点、记法，正是这趟动到的东西）。

**HTML（报告 `.html`），一处对一处：**

1. **一次 `edit` 删掉那一章**：`oldText` 从 `<div class="curtain" id="cK">` 一直到这一章
   `.concept` 的 `</section>`（章末那行 `<p class="back">` 在 `</section>` 里面，
   跟着一起删），`newText` 留空。幕封页与 `.concept` 是一对，
   **只删一半会让自检 H1 的两个数不相等**。
2. **K 之后每一章改两处**：`.curtain` 的 `id="cX"` 与 `.curtain-num` 里的 `§X`。
   这两行挨着，一章一次 `edit`。正文一个字都不用动。
3. **`.toc-sub`**：一次 `edit` 换掉整个 `<ol class="toc-sub">`，条目照 JSON 重写一遍
   （删掉 §K 那条，其余的 `href` 与 `§N 标题` 跟新号走）。
4. **② 知识地图那张 SVG**：删掉被删章那个 `g.node`（连它的 `<a href="#cK">`、`rect`、
   `text`，以及副标 `要重点补 · §K`）与两端连它的 `.edge`；其余节点的 `<a href="#cX">`
   与副标 `要重点补 · §X` 逐个跟新号走。**少一个节点之后图会缺一块**，剩下的节点该不该
   挪位置照 `map.sketch` 重画——这是「图的画法」，本来就在 HTML 上改（SKILL.md 硬约束第 6 条）。
5. **正文里的交叉引用**：`grep -n 'href="#c' <报告>.html`，逐行对着 JSON 核一遍。
6. **⑦ 术语表**的 `.where`（`首次出现 §X`）、**⑨** 那条要删的 `<li id="r-…">`、
   **①** `p.meta` 里的「约 M 分钟」，各一次 `edit`。
7. 重跑「交付前自检 · HTML 层」的 **H1**（幕封页数 = `.concept` 数 = JSON 章数）
   与 **H4**（指不到的页内锚点，应该 0 行）。**H4 是这一趟的主检**——
   上面每一条漏掉一处，结果都是一个点了不动、又不报错的死链接。

### 插一章

跟「删掉 §K」镜像，三处不同：

- **改号从大到小**（先 N→N+1，再 N-1→N……），理由见上面第二条通则。
  JSON 与 HTML 两边都是这个方向。
- **新那一章要真的渲染出来**：照 SKILL.md 第 5.5 小步第 3 条那次插入渲染，
  `oldText` 取**它后一章**幕封页的第一行 `<div class="curtain" id="cX">`，
  `newText` = 新的「幕封页 + `.concept`」一对 + 原样带回那一行；
  插在最后一章之后的话，拿 ⑤ 或 ⑥ 那一节的起始行当锚。
- **新章的图现在才画**（JSON 里只有 `sketch`），画完把它之后所有 `figure.num` 加上新增的图数；
  `.toc-sub` 多一条，② 知识地图多一个 `.n-focus` 节点与至少一条 `.edge`。

### 换顺序

把一章搬到别的位置（或两章对调）：

1. **JSON**：挪 `chapters[]` 里的数组项，然后**整段重排** `number` 与 `id`
   ——搬动跨过的每一章号都变了，不只是搬动的那一章。改完仍然要走「删掉 §K」JSON 那边的
   第 3–5、9、10 条（交叉引用、知识地图、术语表 `where`、总结里点名的句子、三组自检）。
   图号按新顺序重排（J-B 10）。
2. **HTML**：把那一对「幕封页 + `.concept`」**原样剪过去**——先 `read` 出那一段
   （从 `<div class="curtain" id="cK">` 到它 `.concept` 的 `</section>`），
   再一次 `edit` 在旧位置删掉、一次 `edit` 在新位置插回，
   **中间那段标记一个字都不要重打**（重打就是又一次整章重写，正是 JSON 这一层要消掉的东西）。
   只有 `id` 与 `.curtain-num` 两处跟着新号改。
   其余跟「删掉 §K」HTML 那边的第 2–7 条一样。
3. **换顺序独有的一件事：依赖侧注会失效。** 被搬过的那几章里，
   `<aside>` 那句「本节假设你已经知道 §X」和 `.lede` 里「先回 §X 看…」这类话，
   原来指的是**前面**讲过的东西，搬完可能指到了**后面**。
   **被跨过的每一章的 `aside` 与 `lede` 都要人读一遍**——这是 5.2 自核第 2 条（顺序）
   在事后重跑一遍，grep 查不出来。

---

## ①–⑩ 各块填什么

| | 块 | class | 里面的位 |
|---|---|---|---|
| ① | 抬头 | `.deck-head` | `h1` 主题 · `p.meta` 顶部两件套（见下）· `p.for-whom` **基于访谈的起点画像**，不是套话。三行字压在 `div.hero-band` 那条深色封面带上，带本身是 `<body>` 的子元素、**整块原样保留**，只填 `data-hero` |
| ② | 知识地图 | `.map` | `figure > svg`，**照 `map.sketch` 现画**（JSON 里没有这张图的标记）。一张画完的图见下面那一节 |
| ③ | 前序速览 | `.primer` | `dl > dt/dd`，每条两三句话带过 |
| ④ | 知识点正文 | `.concept` | 见下面「④ 一章画完的样子」 |
| ⑤ | 方法对比表 | `.compare` | `div.table-wrap > table`：假设 / 适用场景 / 代价 / 失效情形 |
| ⑥ | 总结节 | `.summary` | 把上面的点合起来回答「所以这东西到底在干什么」 |
| ⑦ | 术语对照表 | `.glossary` | `dt[id]` + `span.en` 英文 · `dd` 一句话解释 + `span.where` 首次出现在哪节 |
| ⑧ | 建议下一步 | `.next` | `h3` 分「必读 / 选读 / 该上手跑什么 / 下一个 learning-deck」，`li` + `span.why` |
| ⑨ | 参考文献 | `.refs` | `ol > li[id]`，题名 + `a.ref-link`。**每条都要有 `id="r-…"`**，见下面「⑨ 参考文献与两跳引用」 |
| ⑩ | 诚实边界 | `.honesty` | `ul > li`，逐条列，不写笼统的免责声明 |

### ① 抬头的顶部两件套

**预计阅读时间** + **最后更新日期**，写在 `p.meta` 里，用 `<span class="meta-sep">` 隔开：

```html
<p class="meta">
  <span>learning-deck</span>
  <span class="meta-sep" aria-hidden="true"></span>
  <span>约 24 分钟</span>
  <span class="meta-sep" aria-hidden="true"></span>
  <time datetime="2026-08-21">最后更新 2026-08-21</time>
</p>
```

⚠️ v4 是「三件套」，第一样是顶部那条进度条——**进度条 v5 删掉了**，现在只有两件。
⚠️ **阅读时间在你生成报告时算好写死，不要写 JS 去数。**
算法：`<body>` 里正文的可见汉字数 ÷ 350（中文技术材料 300–400 字/分取中值），
向上取整，每张图再 +0.5 分钟；不含 ⑨ 参考文献与 SVG 里的标注。
算出来不到 5 就写「约 5 分钟」。
⚠️ 日期就是生成日期，`datetime` 用 ISO 形式，和文字里那个保持一致。

### ② 知识地图的节点三色

| class | 含义 | 链到哪 |
|---|---|---|
| `.n-known` | 访谈里标「熟悉」 | 术语表的那一条 `#g-xxx` |
| `.n-focus` | 要重点补，正文有一节 | `#cN` |
| `.n-brief` | 一句话带过 | `#primer` |

「已掌握」的节点**同样要是锚点**——读者未必真记得，链到术语表比留一个死框有用。

### ② 知识地图：一张画完的图

模板里只剩一个 `⟨待填⟩` 注释，所以下面这张是唯一的样例。**照它的结构改，
不要照抄它的内容**（这是一份心电图基础模型的 deck，不是你要写的那份）。

```html
<section class="map" id="map">
  <h2>知识地图</h2>
  <p>
    下面这张图是这份报告的骨架，也是导航：点任何一个实线加重的节点直接跳到那一节。
    虚线节点表示只在<a href="#primer">前序速览</a>里两三句话带过。
  </p>

  <figure>
    <!-- 这张图**不写** role="img"：role="img" 会把整个子树变成 presentational，
         里面那些页内锚点对屏幕阅读器就消失了，而「节点兼作导航」正是知识地图的用处。
         改用 <title> + <desc> 加 aria-labelledby 命名。
         正文里那些纯示意图没有可点的东西，role="img" 才是对的。 -->
    <svg viewBox="0 0 640 340" aria-labelledby="map-svg-title map-svg-desc">
      <title id="map-svg-title">心电图基础模型的知识地图</title>
      <desc id="map-svg-desc">三层依赖图。顶层是用基础模型预测心梗；第二层是任务定义、按导联归一化、微调策略；第三层是导联与采样率、对比预训练、评价指标。加重的节点是本报告要补的知识点，每个节点都是可点的页内链接。</desc>

      <!-- 连线：目标 → 第二层 -->
      <path class="edge" d="M300 82 C 200 100, 130 110, 105 138"/>
      <path class="edge" d="M320 82 L 320 138"/>
      <path class="edge" d="M340 82 C 440 100, 510 110, 535 138"/>

      <!-- 连线：第二层 → 第三层 -->
      <path class="edge" d="M105 186 L 105 238"/>
      <path class="edge" d="M320 186 L 320 238"/>
      <path class="edge" d="M535 186 L 535 238"/>

      <!-- 顶层：目标概念 -->
      <g class="node n-focus">
        <a href="#summary">
          <rect x="240" y="42" width="160" height="40" rx="5"/>
          <text x="320" y="69" text-anchor="middle" font-size="17">预测心梗</text>
        </a>
      </g>
      <text class="svg-label-faint" x="320" y="26" text-anchor="middle" font-size="13">目标</text>

      <!-- 第二层 -->
      <g class="node n-focus">
        <a href="#c1">
          <rect x="20" y="140" width="170" height="46" rx="5"/>
          <text x="105" y="159" text-anchor="middle" font-size="15">任务定义</text>
          <text class="svg-label-faint" x="105" y="179" text-anchor="middle" font-size="12">要重点补 · §1</text>
        </a>
      </g>
      <g class="node n-focus">
        <a href="#c2">
          <rect x="235" y="140" width="170" height="46" rx="5"/>
          <text x="320" y="159" text-anchor="middle" font-size="15">按导联归一化</text>
          <text class="svg-label-faint" x="320" y="179" text-anchor="middle" font-size="12">要重点补 · §2</text>
        </a>
      </g>
      <g class="node n-brief">
        <a href="#primer">
          <rect x="450" y="140" width="170" height="46" rx="5"/>
          <text x="535" y="170" text-anchor="middle" font-size="15">微调策略</text>
        </a>
      </g>

      <!-- 第三层。「已掌握」的节点同样是锚点：读者未必真记得，
           链到术语表比留一个死框有用。 -->
      <g class="node n-known">
        <a href="#g-lead">
          <rect x="20" y="240" width="170" height="46" rx="5"/>
          <text x="105" y="270" text-anchor="middle" font-size="15">12 导联与采样率</text>
        </a>
      </g>
      <g class="node n-known">
        <a href="#g-contrastive">
          <rect x="235" y="240" width="170" height="46" rx="5"/>
          <text x="320" y="270" text-anchor="middle" font-size="15">对比预训练</text>
        </a>
      </g>
      <g class="node n-brief">
        <a href="#primer">
          <rect x="450" y="240" width="170" height="46" rx="5"/>
          <text x="535" y="270" text-anchor="middle" font-size="15">评价指标</text>
        </a>
      </g>

      <!-- 图例：色块直接套节点那套 class，样式不会跟节点走偏，打印兜底也一并覆盖 -->
      <g class="legend" transform="translate(20, 306)">
        <g class="node n-known"><rect x="0" y="0" width="14" height="14" rx="3"/></g>
        <text class="svg-label-faint" x="20" y="12" font-size="13">你已掌握</text>

        <g class="node n-focus"><rect x="110" y="0" width="14" height="14" rx="3"/></g>
        <text class="svg-label-faint" x="130" y="12" font-size="13">要重点补</text>

        <g class="node n-brief"><rect x="220" y="0" width="14" height="14" rx="3"/></g>
        <text class="svg-label-faint" x="240" y="12" font-size="13">一句话带过</text>
      </g>
    </svg>
    <figcaption>
      <b>图 1</b> 这份报告的知识依赖图。第三层两个实线绿框是访谈里你标了「熟悉」的，
      这份报告不再讲；加重的红框是这次要补的。
    </figcaption>
  </figure>
</section>
```

---

## ④ 知识点正文

⚠️ **模板不带任何示例章节（v5，用户决定）。** v4 的模板自带两个示例章节的壳，
渲染指令是「第 1、2 章用掉这两个壳，第 3 章起用插入」。两条路的价钱差得太远：
插入的 `oldText` 只有一行注释，替换壳的 `oldText` 含八十行示例 SVG。第四次真跑的
结果是九章全走了插入这条便宜路，两个壳原地留在文件里——JSON 里 9 章，HTML 里
11 个幕封页。**现在没有壳可用，插入是唯一的路。**

怎么插：模板里 ③ 前序速览与 ⑤ 方法对比之间有一行

```html
<!-- ④-ANCHOR 知识点章节插在这一行之前 ⟨待填⟩ -->
```

**一章一次 `edit`**，`oldText` 就是这一行，`newText` = 这一章的「幕封页 + `.concept`」
一对 + 同一行注释。**插最后一章时不再带回那行注释**——它带着 `⟨待填⟩`，
留下来会被交付前自检 H1 抓到。

### 节内固定顺序（不要自由发挥）

⚠️ **这个顺序不用你守，它是渲染出来的。** `.lede` / `.aside` / `.boundary` /
`.source` / `.checkout` / `.back` 在 `.learning-deck` JSON 里是章的固定槽位，
位置由 `references/deck-json.md` 的渲染对照表定死；能自由排的只有中间那段
`blocks`（`prose` / `figure` / `eq` / `example` / `pointer` 五种）。

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

- 长文档里的进度感由**左侧目录的当前项高亮**给，没有文字计数、也没有进度条。
- `.aside` 依赖侧注：访谈里标「熟悉」的那些正好填这里。
- `.with-figure`：**图与讲它的那段必须在同一个 `.with-figure` 里**，
  否则图会漂到下一屏，读者对不上。
- `.checkout` 的问题要**具体到能被回答**，不是「你理解本节内容了吗」。
- `.example` 里装什么，见 `references/writing.md` 第 4 条——那是全篇最容易敷衍的一处。
- `.pointer` 指路卡片（结构同 `.example`：`span.tag` + 一段话 + 外链）只在**取不到原图、
  或当前模型看不见图**时用，指向原文那张图。**它不是 `.example`**，也不能拿来满足
  「每节至少一个例子」那条闸门——用法见 `references/figures.md`。

### ④ 一章画完的样子

下面是一对完整的「幕封页 + `.concept`」，五种块里的四种都出现了一次。
**照它的结构改，不要照抄它的内容。**

```html
<div class="curtain" id="c2">
  <div class="curtain-num">§2</div>
  <h2 class="curtain-title">按导联还是按整条记录归一化</h2>
  <p class="curtain-lede">
    归一化的<strong>统计范围</strong>决定了模型看到的是「这一导联相对它自己的形态」，
    还是「这一导联相对整张图的幅度」——换一家医院的设备，两者的结论会分道扬镳。
  </p>
</div>

<section class="concept">
  <p class="lede">
    归一化的<strong>统计范围</strong>决定了模型看到的是「这一导联相对它自己的形态」，
    还是「这一导联相对整张图的幅度」——换一家医院的设备，两者的结论会分道扬镳。
  </p>

  <aside class="aside reveal">
    <p>本节假设你已经知道 <a class="term" href="#g-lead">12 导联</a>各自的物理含义
    ——访谈里这一项你标的是「熟悉」。</p>
    <p>卡在「为什么跨中心会崩」那里的话，先回 <a href="#c1">§1</a> 看任务是怎么定义的。</p>
  </aside>

  <h3>它解决什么问题</h3>
  <p>
    原始 ECG 的绝对幅度受电极位置、皮肤阻抗、设备增益三件事影响，
    同一位病人在两台机器上录出来的电压能差一倍。不归一化，模型学到的一大半是设备指纹。
  </p>

  <div class="with-figure">
    <h3>机制</h3>
    <p>
      三种统计范围算出来的东西完全不同：整条记录一套均值方差、每导联一套、
      每导联每窗口一套。下面这张图把同一段信号在三种范围下的结果并排画出来。
    </p>

    <figure>
      <svg viewBox="0 0 640 190" role="img"
           aria-label="三种归一化统计范围的对照：整条记录、按导联、按导联按窗口，各自算出的均值方差范围不同">
        <title>三种归一化的统计范围</title>

        <!-- 每张 <svg> 自带一套 defs、自用一套 id 前缀。
             不要跨 svg 引用另一张图的 marker / pattern —— 浏览器多半认，
             但一旦某张图被删就静默失效。 -->
        <defs>
          <marker id="ld-arrow-n" viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path class="arrow-head" d="M0,0 L10,5 L0,10 z"/>
          </marker>
        </defs>

        <text class="svg-label-faint" x="12" y="20" font-size="13">同一段 12 导联信号</text>

        <g>
          <rect x="12" y="32" width="150" height="52" rx="4" class="svg-frame"/>
          <text class="svg-label" x="87" y="52" text-anchor="middle" font-size="14">整条记录</text>
          <text class="svg-label-faint" x="87" y="72" text-anchor="middle" font-size="12">1 套 μ, σ</text>
        </g>

        <!-- emphasis 那一处套 .svg-hi：这张图上最要紧的就是中间这一档 -->
        <g>
          <rect x="245" y="32" width="150" height="52" rx="4" class="svg-hi"/>
          <text class="svg-label" x="320" y="52" text-anchor="middle" font-size="14">按导联</text>
          <text class="svg-label-faint" x="320" y="72" text-anchor="middle" font-size="12">12 套 μ, σ</text>
        </g>

        <g>
          <rect x="478" y="32" width="150" height="52" rx="4" class="svg-frame"/>
          <text class="svg-label" x="553" y="52" text-anchor="middle" font-size="14">按导联按窗口</text>
          <text class="svg-label-faint" x="553" y="72" text-anchor="middle" font-size="12">12 × W 套 μ, σ</text>
        </g>

        <path class="arrow-line draw" d="M162 58 L 239 58" marker-end="url(#ld-arrow-n)"/>
        <path class="arrow-line draw" d="M395 58 L 472 58" marker-end="url(#ld-arrow-n)"/>
        <text class="svg-label-faint" x="320" y="112" text-anchor="middle" font-size="13">
          统计范围越窄，跨设备的幅度差被抹得越干净
        </text>
        <text class="svg-label-faint" x="320" y="134" text-anchor="middle" font-size="13">
          ——同时被抹掉的还有导联之间真实的幅度关系
        </text>
        <path class="svg-rule" d="M12 156 H628"/>
        <text class="svg-label" x="12" y="178" font-size="14">左端保留最多信息 · 右端最耐设备漂移</text>
      </svg>
      <figcaption>
        <b>图 3</b> 三种统计范围的对照。红框是跨中心场景下的默认选择：
        它把设备增益的差异吃掉，又不至于像逐窗口那样把 ST 段的绝对抬高也抹平。
        <br>示意图为本报告自画，不对应原文任何一张图。
      </figcaption>
    </figure>
  </div>

  <!-- 公式：Chromium 原生 MathML。**不要引 KaTeX / MathJax**，CSP 会拦。
       结构固定三层：.eq > .eq-body > math[display=block]，编号放 .eq-num。 -->
  <div class="eq">
    <div class="eq-body">
      <math display="block">
        <mrow>
          <msubsup><mi>x</mi><mrow><mi>l</mi><mo>,</mo><mi>t</mi></mrow><mo>&#x2032;</mo></msubsup>
          <mo>=</mo>
          <mfrac>
            <mrow>
              <msub><mi>x</mi><mrow><mi>l</mi><mo>,</mo><mi>t</mi></mrow></msub>
              <mo>&#x2212;</mo>
              <msub><mi>μ</mi><mi>l</mi></msub>
            </mrow>
            <msub><mi>σ</mi><mi>l</mi></msub>
          </mfrac>
        </mrow>
      </math>
    </div>
    <span class="eq-num">(1)</span>
  </div>

  <div class="example reveal">
    <span class="tag">举个例子</span>
    <p>
      同一位病人先后在两台机器上录：A 机 V4 导联的 R 波峰值是 1.8 mV，
      B 机是 3.1 mV。整条记录归一化之后两张图的 V4 仍然差 0.4 个标准差；
      按导联归一化之后差 0.05。模型在 A 机数据上训练、B 机数据上测试，
      前者 AUROC 从 0.91 掉到 0.74，后者掉到 0.88。
    </p>
  </div>

  <div class="boundary reveal">
    <h3>常见误解与边界</h3>
    <ul>
      <li>
        <strong>「按导联归一化总是更好」</strong>——不是。低电压这个诊断本身依赖绝对幅度，
        按导联归一化会把它抹掉。要判低电压就得把幅度作为单独特征留出来。
      </li>
      <li>
        <strong>「统计量可以在训练集全局算一次」</strong>——那是数据泄漏的一种：
        推理时你拿不到测试集的分布。μ 与 σ 必须**在每条记录内部**算。
      </li>
    </ul>
  </div>

  <!-- 出处：**两跳**。这里链的是 ⑨ 参考文献里那条 <li> 的 id，不是论文 URL。 -->
  <div class="source reveal">
    <h3>出处</h3>
    <ul>
      <li>
        按导联归一化在跨中心迭代上的对照实验见
        <a href="#r-strodthoff2021">Strodthoff et al. (2021)</a> 的 §4。
      </li>
    </ul>
  </div>

  <p class="checkout reveal">
    <b>读完这节你应该能回答：</b>三种统计范围各自算出什么？
    为什么跨中心的数据必须按导联来？什么情况下按导联反而是错的？
  </p>
  <p class="back"><a href="#map">↑ 回知识地图</a></p>
</section>
```

### 行内的两个

- `.term`：术语**首次出现**处加粗 + 链到 ⑦ 术语表（`<a class="term" href="#g-xxx">`）。
  后文再提不再加粗、不再链。
- `.formula` / `<code>`：等宽字体的行内公式或代码片段。

---

## ⑨ 参考文献与两跳引用

**正文里的引用不再直接外链到论文。** 改成两跳：

```
正文 .source 里的 <a href="#r-xxx">Strodthoff et al. (2021)</a>
   ↓ 第一跳：页内，落到 ⑨ 里那条 <li id="r-xxx">
<li id="r-xxx"> 完整题录 <a class="ref-link" href="https://…">DOI</a>
   ↓ 第二跳：外链，交给系统浏览器
```

为什么：v4 是正文一点就跳出 app，读者既看不到这条文献的完整题录（谁写的、
哪一年、发在哪），也回不到刚才读到的地方。第一跳留在页内，是「先让我看看这是什么」
和「好，我现在要去读原文」两个不同的动作。

```html
<section class="refs" id="refs">
  <h2>参考文献</h2>
  <ol>
    <li id="r-strodthoff2021">
      Strodthoff, N. et al. (2021). <i>Deep Learning for ECG Analysis.</i>
      IEEE JBHI 25(5), 1519–1528.
      <br><a class="ref-link" href="https://doi.org/10.1109/JBHI.2020.3022989" target="_blank" rel="noopener">https://doi.org/10.1109/JBHI.2020.3022989</a>
    </li>
  </ol>
</section>
```

⚠️ **每条 `<li>` 都必须带 `id="r-…"`**，漏一个就是一个点了不动的死链接（H4 会抓）。
id 用「首作者姓 + 年份」的小写形态（`r-ho2020` / `r-thygesen2018`），撞了就加序号。
⚠️ 页内锚点靠查看器注入的 `<base href="about:srcdoc">` 才成立——**别在报告里自己写
`<base>`**，查看器只在报告没有 base 时才注入它自己那条。
⚠️ 只有 `a.ref-link` 那条外链写 `target="_blank" rel="noopener"`；正文里的 `#r-…`
是页内锚点，**不要**加这两个属性（加了会在新标签里打开一个 about:srcdoc）。
⚠️ DOI 优先。计算机方向的会议论文（NeurIPS / ICML / ICLR 等）常常压根没有分配 DOI，
那种情况才退到 arXiv id。**一条都不许编**，每条都要 `fastpaper get` 回源核验过。

---

## 公式：原生 MathML

**不要引 KaTeX / MathJax**——它们是外部资源，CSP 会直接拦掉，页面上只会剩一段生源码。
Chromium 原生支持 MathML Core，已实测在这套 sandbox + CSP 下是真排版。

三种写法，按复杂度选，别混用：

| 情况 | 写法 |
|---|---|
| 一个符号 / 一小段记号（`x_t`、`β_t`、`N(0, I)`） | `<span class="formula">x_t</span>` |
| 行内但真的有上下标 / 根号 / 分式叠起来 | 行内 `<math>…</math>`（不写 `display`） |
| 单独成行的关键式子 | `.eq` 包裹框（结构见上面那一章的样例） |

常用元素：`<mi>` 变量 · `<mn>` 数字 · `<mo>` 运算符 · `<msub>` `<msup>` 上下标 ·
`<msqrt>` 根号 · `<mfrac>` 分式 · `<mover accent="true">` 加横线（`ᾱ` 写成
`<mover accent="true"><mi>α</mi><mo>&#xAF;</mo></mover>`）· `<mrow>` 分组 ·
`<mo>&#x2062;</mo>` invisible times（别用 `·` 或 `*`）。

⚠️ **长推导不要写。** MathML Core 的排版质感不如 KaTeX，希腊字母和数学符号会落到
系统字体；下标、分式、求和够用，一屏高的推导会显得糙——那种情况改成一句话讲清楚
它在干什么，把推导留给 ⑨ 里的原文。

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
  实测区间见模板里「SVG 里的共用件」那段。）照抄上面样例里的数，别自己往下压。
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
- **顶部进度条。** v5 删掉了，理由见上面「v5 的四处删改」。
- **「速通路径」那一节。** 同上。

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

**这里只留渲染之后才成立的四组**：填充锚点消费干净没有、模板骨架有没有被动过、
外链形态、锚点指不指得到。第 5.6 小步跑一次，**只跑一次**。

**固定用 `grep`。KyDog 不打包 ripgrep，`rg` 一定返回 127**，跑三次也一样。
下面这份照抄，把 `报告.html` 换成实际文件名，**不要即兴发挥**：

```bash
# H1. 填充锚点消费干净了吗 —— 第一条 0 行，后两条相等且等于 JSON 的章数
grep -n '⟨待填⟩' 报告.html
#   模板 <body> 里每一处等着你填的位置（含 ④ 章节插入锚点）都带着 ⟨待填⟩ 这个记号，
#   渲染时那段注释连同它标的位置一起被 newText 换掉，所以交付时一条都不该剩。
#   剩下的每一行都是「这一节压根没渲染」。
#   ⚠️ 这条取代了 v4 那条「grep 扩散|马尔可夫|DDPM|ELBO…」。旧那条查的是
#      **模板自带的示例文字有没有被替换干净**；v5 起模板 <body> 里一句示例都没有，
#      那条 grep 恒不命中，等于一条永远绿的自检。真正要防的失败模式没变——
#      「某一节根本没被渲染就交付了」——所以判据换成直接查那个位置填了没有。
#      （v4 真跑那次它本该红：11 个幕封页对 9 章、41 处示例文字。自检跑了，
#      但没有据此返工。这条记在这里：**H1 命中就是返工信号，不是提示信号。**）

grep -c '<div class="curtain"' 报告.html      # 幕封页数
grep -c '<section class="concept"' 报告.html  # 正文节数
#   两个数必须**相等**，且**等于 JSON 里 chapters 的条数**。
#   不等 = 插漏了一节、多插了一节，或者一对里只插了半边。

# H2. 模板骨架没被动过 —— 三条都只应命中文件头 / <style> 里的注释
grep -c '^<script>' 报告.html
#   唯一的判据是这个数正好 1。<script 这个词模板自带十来处命中，全在注释里
#   （文件头的硬约束、<style> 里几条、脚本内部一条），它们在**讲这条规则本身**，
#   不是违规。真正要找的是第二个**行首的** <script> 标签。
grep -n 'src="http\|@import\|url(http\|fonts.googleapis\|cdn\.\|unpkg\|fetch(\|XMLHttpRequest\|WebSocket' 报告.html
#   模板自带 4 处命中，都在文件头的硬约束注释里（第 2 条本身在列举 CDN / @import /
#   img src="http…" / fetch 这些词，第 3 条那句「把它当资源加载」）。都不是违规。
#   <body> 里应该 0 行。指向论文的 <a href="http…"> 是链接不是资源，合法（这条 grep
#   也不查 href）；真出现在 img / link / @import / url() / 脚本里的会被 CSP 拦掉，必须删。
grep -n 'fill="#\|stroke="#\|color: *#\|background: *#' 报告.html
#   <body> 里只有 var(--x, #xxx) 这种带 fallback 的形态是合法的。
#   落在 <style> 的 @media print 那一段里的十来处（#fff / #000）是模板自带的
#   打印兜底，本来就该写死，而且你被明令「<style> 一个字都不要改」—— 跳过它们。

# H3. 外链都带 target/rel —— 两个数必须相等
grep -o 'href="http' 报告.html | wc -l
grep -o 'target="_blank" rel="noopener"' 报告.html | wc -l
#   ⚠️ 正文 .source 里的引用是**页内两跳**（href="#r-…"），不算外链、
#      也不该带 target/rel。这条 grep 只数 href="http 开头的那些，天然不会数到它们。

# H4. 指不到的页内锚点 —— 应该 0 行（直接吐出坏锚点，不要靠人眼比对两份清单）
comm -23 \
  <(grep -o '<a href="#[a-zA-Z0-9_-]*"' 报告.html | sed 's/.*#//;s/"//' | sort -u) \
  <(grep -o 'id="[a-zA-Z0-9_-]*"' 报告.html | sed 's/id="//;s/"//' | sort -u)
#   左边是所有页内锚点（目录条目、知识地图节点、正文里的 §N 链接、术语链接、
#   以及 v5 新增的 #r-… 引用锚点），右边是所有 id。输出的每一行都是「点了不动」
#   的死链接——**不报错**，所以必须靠这条查。
#   ⚠️ v5 起这条同时在守两跳引用：正文里每一个 <a href="#r-xxx"> 都要求
#      ⑨ 参考文献里有一条 <li id="r-xxx">。漏写 id 是最容易犯的那一处。
#   ⚠️ 这条 sed 是**读**，不是改报告：它在管道里把 grep 的输出削成 id，
#      一个字节都没写回文件。SKILL.md 第 5 条禁的是拿 sed/perl/python 去**改**
#      报告文件，跟这里不冲突，照抄就是了。
```

**H1 有命中、或 H4 吐出坏锚点，说明渲染贴漏了一处**——回第 5.5 小步把那一处重渲一遍，
**不要只在 HTML 上补**（见 SKILL.md 硬约束第 6 条：HTML 是产物，改动的源头在 JSON）。
H2 有 `<body>` 里的命中，分两种：

- 命中落在某张 `<svg>` 里（写死了 `fill="#…"` / `stroke="#…"`）——那是**画法**写错了，
  **直接在 HTML 上把它改成模板的颜色 class**，JSON 不用动，JSON 里本来就没有画法
  （见 SKILL.md 硬约束第 6 条的三分表）。
- 命中落在正文标记里（`<img src="http…">`、`@import`、行内 `color: #…`）——
  那是 JSON 里那段 `html` 本身就写错了，**回 JSON 改**，改完把同一行贴进 HTML。
