# 配图 · figures.md

报告里的图有三种来源，**优先级从高到低**：

1. **原文插图**——作者自己画的那张，最准确，但前提是模型看得见图（见下「能力分支」）。
2. **自画的机制 SVG**——看懂原图之后重画，这是这个 skill 的主力形态。
   ⚠️ **SVG 标记不进 JSON。** 第 5.3 小步只在 `figure` 块的 `sketch` 里写「这张图画什么」，
   标记本身到第 5.5 小步渲染时才写出来（形状见 `references/deck-json.md` 的
   「`sketch`：这张图画什么」，画法见 `references/layout.md` 的「画 SVG」）。
3. **指路卡片**——一张 `.pointer` 块（**不是 `.example`**，见下），`.tag` 写「原图」，
   一句话说明那张图给出了什么，配指向原文的外链。上面两条都走不通时用它。

   ```html
   <div class="pointer">
     <span class="tag">原图</span>
     <p>该文 Fig. 2 画的是三个编码器如何共享同一个时间轴对齐模块。
       <a href="https://doi.org/…" target="_blank" rel="noopener">DOI</a></p>
   </div>
   ```

   ⚠️ **指路卡片不能写成 `example`。** JSON 里它是自己的块类型 `pointer`
   （`references/deck-json.md`），`references/writing.md` 第 4 条的例子闸门数的是
   `type === "example"`，而指路卡片恰恰是「具体例子」的反面——它没有数字、没有输入
   输出、没有对照，只有一个去处。混用会让闸门被一张带 DOI 的卡片轻松满足，等于闸门失效。

**数据图（散点、热图、ROC 曲线、生存曲线、森林图）永远不重画**，只能走 1 或 3。
重画一张数据图等于伪造实验结果。

---

## 第一步：取图

```bash
fastpaper figures <id> -d papers/ [--overwrite]
```

命令形态、`<id>` 支持的标识符范围（arXiv id / PMC id / DOI，PMID 与 URL 不支持）、
`-d` 的落盘位置，`src/skills/fastpaper/SKILL.md` 已经讲清楚——去它的「Commands」代码块里
找 `fastpaper figures` 那一行，以及正文里含「an arXiv source package or a Europe PMC
supplementary package」那一段（按内容搜，别按行号找——那份文件是 `npm run cli:update`
从上游同步下来的，每次升级都会重排），这里不重复，只写 learning-deck 这条工作流特有的
退出码分支。

**退出码分支照着走，不要自己另起一套重试策略**（下表已对 fastpaper 0.6.0 实测过）：

| 退出码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 取到了（或文件已存在，没有 `--overwrite` 就跳过了） | 往下走 |
| `4` | **这篇取不到原图**：arXiv 的 PDF-only 投稿（没有源码包）、非 OA 的 PMC、DOI 转不到 PMCID、包里没有图片文件 | **不重试**，这篇走自画 / 指路卡片 |
| `1` | 源不支持 `figures`，或标识符类型不对（PMID / URL） | **同一个标识符不要重试**。如果原因是你给的是 PMID / URL，手上有 DOI 或 arXiv id 就换成那个再跑一次；没有就放弃这篇 |
| `2` | 命令写错了，或当前 fastpaper 版本还没有 `figures` 这条命令（见下面补充说明） | 改命令，或走补充说明里的降级 |

**实测样例**（`./vendor/current/fastpaper figures … -d /tmp/x`，fastpaper 0.6.0）：

- `12345678`（PMID）→ 退出码 `1`，stderr `Error: PubMed indexes abstracts, not
  files: 12345678`，并提示去查同文的 PMC ID。
- `arxiv 0000.00000`（不存在的 id）→ 退出码 `4`，stderr `Error: Not found on
  arXiv: 0000.00000`。
- `2405.09567`（PDF-only 投稿，没有源码包）→ 退出码 `4`，stderr `Error: arXiv
  has no source package for 2405.09567 (it was submitted as a PDF), so there
  are no original figure files.`，并提示改用 `fastpaper download`。**这是
  arXiv 侧最常见的「取不到」原因**——报错信息本身已经指路：命中这条不用再猜，
  直接走自画 / 指路卡片，需要 PDF 另作他用就改跑 `fastpaper download`。

**覆盖率约 79%**（用户在 39 篇真实论文上实测，2026-08-20 对 fastpaper 0.6.0
验证过），且只覆盖 arXiv 与 Europe PMC。别的源没有这个通道，不用试。

### 补充：`unrecognized subcommand` —— 当前版本还没有这条命令

这不是上面表里的 `2`（命令本身写错），是**当前装的 fastpaper 版本比这份文档旧，
还没有 `figures` 这条命令**——多半会在 0.6.0 之前的版本上撞到。表现同样是退出码
`2`，但 **stderr 里会出现 `unrecognized subcommand`**：

```
error: unrecognized subcommand 'figures'
tip: a similar subcommand exists: 'sources'
```

- **不要改命令重试**，也**不要听那句 `tip`**——`sources` 是列可用源的命令，
  和取图毫无关系，试它只会浪费一轮。
- 直接走自画 SVG + 指路卡片，并在 ⑩ 诚实边界写明
  「当前 fastpaper 版本没有 `figures` 命令，本报告未取用原文插图」。
- 这一篇不用再试，**整份报告的其余论文也不用再试**——版本不会在一次会话中间变。

---

## 第二步：认图

落盘长这样，**按标识符建子目录，文件名原样保留**：

```
papers/PMC7075534/ocz228f1.jpg   ocz228f1.gif   ocz228f2.jpg …
papers/2408.05178/figs/architecture.pdf   figs/saliency.png …
papers/2511.11035/1.pdf   2.pdf   3.pdf
```

⚠️ **文件名与图号不对应。** `figures` 有意不解析 `\includegraphics` 和图注——
实测 `2511.11035` 的 `3.pdf` 其实是 Figure 1。**图号只能靠看图确认**，
不许从文件名推。推错了，图注里那句「Fig. 3」就是编的。

`.pdf` 的图用 `read_pdf_figure` 打开（`read` 只认 jpg / png / gif / webp / bmp，
PDF 给它等于没给）。它一步到位：渲染成 PNG、把图给你看、并返回 PNG 路径：

```
read_pdf_figure  { "path": "<绝对路径>/figs/architecture.pdf" }
```

默认第 1 页、倍率 2，插图 PDF 通常就一页。图里小字看不清再把 `scale` 提到 3。
**`.eps` 不处理**——跳过那张，记进 ⑩ 诚实边界。

已经是 png / jpg / gif / webp 的图不用过这一道，直接用 `read` 打开。
两条路一样：**亲眼看**它画的是什么。**它返回的 PNG 路径就是后面 `<img src>` 要用的那个**
——拿不到路径就说明你没看见这张图，见下一节。

---

## 第三步：能力分支（判据由 harness 给，不用猜）

`read_pdf_figure` 或 `read` 返回下面任意一条时，**这张图你没有看见**：

```
[Current model does not support images. Nothing was rendered.]
[Current model does not support images. The image will be omitted from this request.]
[Image could not be attached. No path is returned for this figure.]
```

前两条是同一件事——当前模型不支持图片输入（第一条来自 `read_pdf_figure`，它连渲染都省了；
第二条来自 `read`）。第三条不一样：**这时模型是支持图片的，是渲染成功之后图片没能进
上下文**（比如图片处理流水线本身挂了），跟模型有没有 vision 无关。三条都要走同样的降级
（不插原图、退到指路卡片 + 自画 SVG），但 ⑩ 诚实边界那句话要按哨兵分开写：

- **不插原图。** 你无法判断哪张文件对应哪一节、更无法确认图号，插了就是乱插。
- 降级到**指路卡片 + 自画 SVG**（自画的依据是正文与图注文字，不是那张你没看见的图；
  JSON 里仍然只写 `sketch`，图在 5.5 画）。
- 在 ⑩ 诚实边界写明：命中前两条哨兵——「当前模型不支持图片输入，未插入原文插图」；
  命中第三条哨兵——「图片未能进入上下文，未插入原文插图」（不要写成模型不支持图片，
  那是假话）。

看得见图的模型才走下面这一节。

---

## 第四步：内嵌原图（能看见图时）

JSON 里写成 `{ "type": "figure", "kind": "img", "src": "papers/…", "alt": "…" }`，
渲染出来是下面这个形状。**`kind: "img"` 没有 `sketch`**——原图不用你画。

**写相对路径，不要自己打 base64。** 查看器渲染报告时会自己读文件、转成
`data:` URI 写回 `src`——这一步不用你操心：

```html
<figure>
  <img src="papers/2408.05178/figs/architecture.png" alt="模型整体架构">
  <figcaption><b>图 3</b> 原图，取自 McKeen et al. (2024) Fig. 2。
    <a href="https://doi.org/…" target="_blank" rel="noopener">DOI</a></figcaption>
</figure>
```

- **路径相对于报告文件所在目录**（报告写在项目根目录，`papers/` 也在根目录下，
  所以通常就是 `papers/<id>/<文件名>`，跟 `fastpaper figures` 落盘的路径一致）。
- **图必须在报告所在目录树内**——查看器只认这个范围，逃出去的（`../`、绝对路径）
  会被拒绝、自动退化成 `alt` 文字，页面上不会崩，但也不会显示图。
- 扩展名只认 `png` / `jpg` / `jpeg` / `gif` / `webp`；`.pdf` 先按第二步过一道
  `read_pdf_figure`，**引用它返回的那个 PNG 路径**，`.eps` 仍然不处理（跳过，记进 ⑩ 诚实边界）。
- 没有体积闸门、没有张数上限——查看器会做单张 8MB / 全篇 24MB 的兜底，
  正常论文插图远远碰不到这个数字，不用先量再决定。

`figure` / `figcaption` / `figure img` 的样式模板里都已经有了（`figure img` 是
`max-width: 100%; height: auto`：太宽的图缩回版心，比版心窄的图保持自然尺寸不被拉糊）。
**不要给 `<img>` 写行内 `style`**——模板已经管好缩放，
写了反而是在跟通则对着干（见 `references/layout.md` 开头）。

---

## 标注纪律

**原图和自画，两边都不许冒充对方。**

JSON 里这件事是 `figure` 块的 `credit` 字段（`"original"` / `"redrawn"` / `"own"`，
见 `references/deck-json.md`），渲染时按下表拼成 `figcaption` 里的那句话。
**`credit` 是必填的**，JSON 层自检第 7 条会核；下表是它渲染出来的样子。
图注、图号、出处都是**图的意图**，改它们回 JSON 改；改线条怎么走是**画法**，
就在 HTML 上改（SKILL.md 硬约束第 6 条）。

| 图的来源 | 图注必须写 |
|---|---|
| 内嵌的原文插图 | 「**原图**，取自 〈第一作者〉 et al.（年份）Fig. N」+ DOI / arXiv 外链 |
| 看懂原图后重画 | 「**改画自** 〈第一作者〉 et al.（年份）Fig. N」+ DOI / arXiv 外链 |
| 依据正文文字自画、原文没有对应的图 | 「示意图为本报告自画，不对应原文任何一张图」 |
| 指路卡片 | 一句话说明那张图给出了什么 + 外链；**不要复述图里的数字**（你没核对过） |

图号（Fig. N）**只能来自你亲眼看过那张图并在原文里对上了图注**。
对不上就不写图号，写「该文的架构图」。

⚠️ **图注里的出处链**（`credit.url`、指路卡片里那个）**仍然是直接外链**，
没有跟着 v5 的两跳走。这是刻意的，不是漏改：两跳（`references/layout.md`
「⑨ 参考文献与两跳引用」）解决的是「正文引用一点就跳出 app、看不到题录」；
图注这一条说的是**这张图从哪来的**，读者点它是要去看原图那一页，
中间插一站没有收益。而且图的出处未必是一篇进了 ⑨ 参考文献的文献
（比如只取了一张图的那种），强行两跳反而会逼你往参考文献里塞一条没被正文引用的。

⑩ 诚实边界里要逐条列出：哪些图是原图、哪些是重画的（改画自哪一篇第几张）、
哪些是纯自画的、哪些图因为格式（`.eps`）或体积没能取用。

---

## 一句话流程

> `fastpaper figures` → 退出码分支 → `.pdf` 走 `read_pdf_figure`（转成 PNG + 看图一步到位）→
> 看不见图就降级 → 看得见就写相对路径 `<img src="papers/…">`（查看器渲染时自动内联，
> 不用打 base64）→ 图注标清来源与图号 → 诚实边界记账。
