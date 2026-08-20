# 配图 · figures.md

报告里的图有三种来源，**优先级从高到低**：

1. **原文插图**——作者自己画的那张，最准确，但前提是模型看得见图（见下「能力分支」）。
2. **自画的机制 SVG**——看懂原图之后重画，这是这个 skill 的主力形态。
3. **指路卡片**——一张 `.pointer` 块（**不是 `.example`**，见下），`.tag` 写「原图」，
   一句话说明那张图给出了什么，配指向原文的外链。上面两条都走不通时用它。

   ```html
   <div class="pointer">
     <span class="tag">原图</span>
     <p>该文 Fig. 2 画的是三个编码器如何共享同一个时间轴对齐模块。
       <a href="https://doi.org/…" target="_blank" rel="noopener">DOI</a></p>
   </div>
   ```

   ⚠️ **指路卡片不能写成 `.example`。** `references/writing.md` 第 4 条的例子闸门数的是
   `class="example` 的个数，而指路卡片恰恰是「具体例子」的反面——它没有数字、没有输入
   输出、没有对照，只有一个去处。混用会让闸门被一张带 DOI 的卡片轻松满足，等于闸门失效。

**数据图（散点、热图、ROC 曲线、生存曲线、森林图）永远不重画**，只能走 1 或 3。
重画一张数据图等于伪造实验结果。

---

## 第一步：取图

```bash
fastpaper figures <id> -d papers/
```

`<id>` 接受 arXiv id、PMC id、DOI（DOI 先转 PMCID 再取）。**PMID / URL 不支持。**

⚠️ **先判这一条，再看下面的退出码表。** 今天大概率命中的就是它。

退出码是 `2`，**并且 stderr 里出现 `unrecognized subcommand`**——例如：

```
error: unrecognized subcommand 'figures'
tip: a similar subcommand exists: 'sources'
```

这不是你命令写错了，是**当前装的 fastpaper 版本还没有 `figures` 这条命令**。

- **不要改命令重试**，也**不要听那句 `tip`**——`sources` 是列可用源的命令，
  和取图毫无关系，试它只会浪费一轮。
- 直接走自画 SVG + 指路卡片，并在 ⑪ 诚实边界写明
  「当前 fastpaper 版本没有 `figures` 命令，本报告未取用原文插图」。
- 这一篇不用再试，**整份报告的其余论文也不用再试**——版本不会在一次会话中间变。

排除掉上面这种情形之后，**退出码分支照着走，不要自己另起一套重试策略**：

| 退出码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 取到了（或文件已存在，没有 `--overwrite` 就跳过了） | 往下走 |
| `4` | **这篇取不到原图**：arXiv 的 PDF-only 投稿（没有源码包）、非 OA 的 PMC、DOI 转不到 PMCID、包里没有图片文件 | **不重试**，这篇走自画 / 指路卡片 |
| `1` | 源不支持 `figures`，或标识符类型不对（PMID / URL） | **同一个标识符不要重试**。如果原因是你给的是 PMID / URL，手上有 DOI 或 arXiv id 就换成那个再跑一次；没有就放弃这篇 |
| `2` | 命令写错了（**已排除上面那种情形**） | 改命令 |

**覆盖率约 74%**（用户在 39 篇真实论文上实测），且只覆盖 arXiv 与 Europe PMC。
别的源没有这个通道，不用试。

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

`.pdf` 的图先转成 PNG 再看（PDF 不能直接给 `read`）：

```
pdf_page_png  { "path": "<绝对路径>/figs/architecture.pdf" }
```

默认第 1 页、倍率 2，插图 PDF 通常就一页。图里小字看不清再把 `scale` 提到 3。
**`.eps` 不处理**——跳过那张，记进 ⑪ 诚实边界。

然后用 `read` 打开图片文件，**亲眼看**它画的是什么。

---

## 第三步：能力分支（判据由 harness 给，不用猜）

`read` 打开图片后，如果返回的是：

```
[Current model does not support images. The image will be omitted from this request.]
```

说明**当前模型看不了图**。这时候：

- **不插原图。** 你无法判断哪张文件对应哪一节、更无法确认图号，插了就是乱插。
- 降级到**指路卡片 + 自画 SVG**（自画的依据是正文与图注文字，不是那张你没看见的图）。
- 在 ⑪ 诚实边界写明：「当前模型不支持图片输入，未插入原文插图」。

看得见图的模型才走下面这一节。

---

## 第四步：内嵌原图（能看见图时）

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
  `pdf_page_png` 转成 PNG 再引用，`.eps` 仍然不处理（跳过，记进 ⑪ 诚实边界）。
- 没有体积闸门、没有张数上限——查看器会做单张 8MB / 全篇 24MB 的兜底，
  正常论文插图远远碰不到这个数字，不用先量再决定。

`figure` / `figcaption` / `figure img` 的样式模板里都已经有了（`figure img` 是
`max-width: 100%; height: auto`：太宽的图缩回版心，比版心窄的图保持自然尺寸不被拉糊）。
**不要给 `<img>` 写行内 `style`**——模板已经管好缩放，
写了反而是在跟通则对着干（见 `references/layout.md` 开头）。

---

## 标注纪律

**原图和自画，两边都不许冒充对方。**

| 图的来源 | 图注必须写 |
|---|---|
| 内嵌的原文插图 | 「**原图**，取自 〈第一作者〉 et al.（年份）Fig. N」+ DOI / arXiv 外链 |
| 看懂原图后重画 | 「**改画自** 〈第一作者〉 et al.（年份）Fig. N」+ DOI / arXiv 外链 |
| 依据正文文字自画、原文没有对应的图 | 「示意图为本报告自画，不对应原文任何一张图」 |
| 指路卡片 | 一句话说明那张图给出了什么 + 外链；**不要复述图里的数字**（你没核对过） |

图号（Fig. N）**只能来自你亲眼看过那张图并在原文里对上了图注**。
对不上就不写图号，写「该文的架构图」。

⑪ 诚实边界里要逐条列出：哪些图是原图、哪些是重画的（改画自哪一篇第几张）、
哪些是纯自画的、哪些图因为格式（`.eps`）或体积没能取用。

---

## 一句话流程

> `fastpaper figures` → 退出码分支 → `.pdf` 走 `pdf_page_png` → `read` 看图 →
> 看不见图就降级 → 看得见就写相对路径 `<img src="papers/…">`（查看器渲染时自动内联，
> 不用打 base64）→ 图注标清来源与图号 → 诚实边界记账。
