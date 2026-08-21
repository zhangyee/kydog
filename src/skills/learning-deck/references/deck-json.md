# 中间表示 · deck-json.md

报告分两段做：**先把内容写进一份 JSON，内容定死之后再渲染成 HTML**。
这一册规定那份 JSON 长什么样、每个块渲染成什么、以及 JSON 层的交付前自检。

文件名与报告同名同目录，只是换个后缀并加一个点号开头：

```
<项目根>/learning-deck-ecg-fm-ami-2026-08-21.html
<项目根>/.learning-deck-ecg-fm-ami-2026-08-21.json
```

**交付后这份 JSON 留着，不要删。** 它不是中间文件：模板以后改进了可以拿它重渲，
用户想改一句话也不必重跑访谈与检索。KyDog 的文件树不显示点号开头的文件
（`projectService.ts` 的 `readDir` 过滤、`fileWatcher.ts` 的 `ignored` 忽略），
所以它不会挤占左侧那棵树。

---

## 为什么要多这一层

三次真跑里 agent 三次绕过 `edit` 去整篇重写 HTML（一次 perl、两次 python）。
根因不是禁令不够狠，是**内容还没定就得在两千行 HTML 上改**——
边写边改、每改一次就得把正文整篇再来一遍，「拼好一次写回」永远比逐节匹配 `oldText` 省力。

JSON 把「想清楚内容」和「变成 HTML」切开：

- **内容阶段**（第 5.1–5.4 小步）改一章就是改一个节点，`edit` 的匹配面只有几行，
  而且完全不碰 CSS、不碰 `<head>`、不碰 SVG 之外的任何标记。
- **渲染阶段**（第 5.5 小步）内容已经定死，是一次机械转换，照下面那张对照表贴就完了。

### 逐字相同：这一册最要紧的一条

**JSON 里那些字符串数组字段，每个元素就是渲染后 HTML 里的一行，包括行首缩进。
渲染时原样贴进去，一个空格都不加。**

这条不是洁癖，它是「回 JSON 改」能便宜下来的全部原因。渲染之后发现某段话写坏了：

```
# 在 JSON 上改（第一次 edit）
oldText:  "    但这条链有一个关键性质：由于每步都是高斯，逐步复合之后仍是高斯，"
newText:  "    这条链有一个关键性质——每步都是高斯，复合之后仍然是高斯，所以"

# 在 HTML 上贴同一处（第二次 edit，oldText / newText 逐字照抄上面那两行）
```

**两次 `edit`，第二次是第一次的复制粘贴。** 代价是 1 次改动变 2 次，不是 1 次变 20 次
——后者才是「整篇重写」的价码。只有加块、删块、换顺序这种**结构**变动才需要重渲整章，
而那也只是一章一百来行，不是整篇。

**字段名叫 `html` / `intro` / `svg` / `mathml` / `aside` 的一律是字符串数组；
其余含标记的字段（`lede` / `checkout` / `caption` / `text` / `def` / `boundary[]` /
`source[]` / `honesty[]` …）是单行字符串，只放行内标记。**

字段里的双引号要按 JSON 转义成 `\"`（`<svg viewBox=\"0 0 640 216\">`）。
这一步烦，但它是逐行的机械操作，**别因为嫌烦就把标记改成单引号**——
交付前自检里 `grep -o 'target="_blank" rel="noopener"'` 这类命令数的是双引号形态。

---

## 顶层形状

```json
{
  "version": 1,
  "slug": "ecg-fm-ami-2026-08-21",
  "title": "ECG-FM 微调 AMI 预测模型",
  "date": "2026-08-21",
  "readingMinutes": 24,
  "forWhom": "这份报告为你而写：……（基于访谈的起点画像，不是套话）",

  "map":   { "intro": ["<p>…</p>"], "svg": ["<svg viewBox=\"0 0 640 340\" …>", "…", "</svg>"], "num": 1, "caption": "…" },
  "path":  [ { "href": "#c1", "label": "§1 先定义 AMI 任务", "time": "10 分钟", "hint": "先读这节", "answers": "…" } ],
  "primer": { "intro": ["<p>…</p>"], "items": [ { "term": "变分下界（ELBO）", "html": ["  对数似然直接算不动时，退而求其次优化它的一个下界。"] } ] },

  "chapters": [ … 见下 … ],

  "compare": { "title": "它与几个替代方案", "intro": ["<p>…</p>"],
               "head": ["方法", "核心假设", "适用场景", "代价", "失效情形"],
               "rows": [ ["扩散模型", "…", "…", "…", "…"] ] },
  "wrapup":  { "title": "所以它到底在干什么", "html": ["<p>…</p>", "<p>…</p>"] },
  "glossary": [ { "id": "g-markov", "zh": "马尔可夫链", "en": "Markov chain",
                  "def": "下一状态只取决于当前状态，与更早的历史无关。", "where": "§1" } ],
  "next": { "mustRead": [ { "text": "Ho et al. (2020), <i>DDPM</i>", "why": "只读原文第 2–3 节就够。" } ],
            "optional": [], "handsOn": [], "nextDeck": [ { "text": "「条件生成与 CFG」——你实际要用的那一半。" } ] },
  "references": [ { "text": "Ho, J., Jain, A. &amp; Abbeel, P. (2020). <i>Denoising Diffusion Probabilistic Models.</i>",
                    "url": "https://arxiv.org/abs/2006.11239", "linkText": "arXiv:2006.11239", "verified": true } ],
  "honesty": [ "…", "…" ]
}
```

- **`compare` 只在主题是「某个方法」时才有**，否则写 `null`（渲染时把 ⑥ 整节删掉）。
- **`references[].verified` 只有真的 `fastpaper get` 回源核验过才写 `true`。**
  没核验过的那条不该出现在这个数组里。
- `readingMinutes` 在这里算好写死：JSON 里的可见汉字数 ÷ 350，向上取整，每张图 +0.5；
  不含 `references`。算法与 `references/layout.md`「① 抬头的顶部三件套」那条一致。

## 一章长什么样

```json
{
  "number": 1,
  "id": "c1",
  "title": "先定义 AMI 任务",
  "tier": "听过但说不清",
  "lede": "AMI 任务的定义就是<strong>写死「预测的是谁、在哪个时点、由什么证据判定」这三件事</strong>：……",
  "aside": ["<p>本节假设你已经知道<a class=\"term\" href=\"#g-icd\">出院诊断码</a>……</p>"],
  "blocks": [ … ],
  "boundary": [
    "<strong>「出院诊断码就是标签」</strong>——不是。……（具体情形 / 具体数字 / 具体对照）"
  ],
  "source": [
    "第四版通用定义来自 <a href=\"https://doi.org/…\" target=\"_blank\" rel=\"noopener\">Thygesen et al. (2018)</a>。"
  ],
  "checkout": "为什么「用出院诊断码当标签」会把模型的 AUROC 抬高又抬不住？"
}
```

⚠️ **`lede` 只在这里出现一次。** 渲染时它被贴到两个地方（幕封页的 `.curtain-lede` 和
正文的 `.lede`），「两处逐字相同」因此是**结构上做不到不一致**，不再需要事后去查。
`title` 与 `number` 同理，只在幕封页出现一次——所以 `blocks` 里**不许出现 `<h2>`**。

⚠️ **`tier` 只有两个合法值**：`"听过但说不清"` / `"没接触过"`。
标 `"熟悉"` 的知识点**不成章**，只在 `map.svg` 里作 `.n-known` 节点出现（见 `references/interview.md`）。
档位怎么改变这一节的写法，见 `references/writing.md` 第 7 条。

⚠️ `lede` / `checkout` / `boundary[]` / `source[]` 是**单行字符串**，只放行内标记
（`<strong>` `<em>` `<code>` `<span class="formula">` `<a>` `<math>`）。
`aside` / `blocks[].html` 这些是**字符串数组**，可以放块级标记。

---

## `blocks[].type`：五个，就这五个

`type` 是**封闭枚举**。下面五个是模板里真有对应组件、真有 CSS 的全部块类型。
写清单外的 class 不会报错，只会渲染成一段裸文字。

| `type` | 渲染成 | 每章的量 |
|---|---|---|
| `prose` | `<h3>` + 若干 `<p>` | 不限 |
| `figure` | `.with-figure`（`<h3>` + 讲图那段 + `<figure>`） | **至少 1** |
| `eq` | `.eq > .eq-body > <math display="block">` + `.eq-num` | 不限，公式多的章才用 |
| `example` | `.example.reveal`（`.tag` +正文） | **至少 1** |
| `pointer` | `.pointer`（`.tag` + 正文 + 外链） | 不限，**不顶替 `example`** |

`lede` / `aside` / `boundary` / `source` / `checkout` / `.back` **不在这个枚举里**——
它们是章的固定槽位（上面那张章的形状里的字段），位置由渲染器定死，不由 `blocks` 的顺序定。
这样 `references/layout.md`「⑤ 节内固定顺序」就是渲染出来的结果，不再是一条要人守的规矩。

### 为什么没有 `table`

模板的表格样式全部挂在 `.compare` 下（`.compare table` / `.compare th` / `.compare td` /
`.compare thead th` / `.compare tbody tr:nth-child(even)`），**没有一条通用的 `table` 规则**。
写进 `.concept` 里的 `<table>` 会渲染成一张没有边框、没有斑马纹、没有对齐的裸表格
——不报错，只是难看。所以正文里的表格能拆成 `prose` 就拆，真的必须是表格，
那说明它是 ⑥ 方法对比，放 `compare` 里。**这不是漏了一个块类型，是刻意不给。**

### `prose`

```json
{ "type": "prose", "heading": "它解决什么问题",
  "html": ["  <p>没有明确标签前，最常见做法是直接采用出院诊断码……</p>",
           "  <p>于是模型在测试集上 AUROC 0.94，换一家医院掉到 0.71。</p>"] }
```

`heading` 可以省（省了就不出 `<h3>`）。每章的第一个 `prose` 通常是
「它解决什么问题」，见 `references/writing.md` 第 2 条。

### `figure`

```json
{ "type": "figure",
  "heading": "机制",
  "intro": ["  <p>把标签定义画成一条时间轴，三件事各占一段……</p>"],
  "num": 2,
  "kind": "svg",
  "svg": ["    <svg viewBox=\"0 0 640 216\" role=\"img\" aria-label=\"…\">",
          "      <title>…</title>",
          "      …",
          "    </svg>"],
  "caption": "上排是……下排是……",
  "credit": { "kind": "own" } }
```

- `kind` 是 `"svg"` 或 `"img"`。`"img"` 时用 `"src"` + `"alt"` 代替 `"svg"`，
  `src` 写报告目录树内的相对路径（`papers/<id>/<文件名>`），**不要自己打 base64**，
  见 `references/figures.md`。
- `heading` 与 `intro` 都省略时渲染成裸 `<figure>`，不包 `.with-figure`。
  **有话讲这张图就别省**——图与讲它那段不在同一个 `.with-figure` 里会漂到下一屏。
- `num` 是全篇连续的图号，**`map` 那张是图 1**，章节里的图从 2 接着数。
- `credit.kind` 三选一，这是 `references/figures.md`「标注纪律」的结构化形态：

  | `credit.kind` | 还要写 | 渲染进 `figcaption` 的那句 |
  |---|---|---|
  | `"original"` | `paper` `fig` `url` | 「**原图**，取自 〈paper〉 〈fig〉」+ 外链 |
  | `"redrawn"` | `paper` `fig` `url` | 「**改画自** 〈paper〉 〈fig〉」+ 外链 |
  | `"own"` | —— | 「示意图为本报告自画，不对应原文任何一张图」 |

  图号（`fig`）**只能来自你亲眼看过那张图并在原文里对上了图注**；对不上就不写 `fig`，
  `paper` 后面跟「的架构图」。

### `eq`

```json
{ "type": "eq", "num": "(1)",
  "mathml": ["      <math display=\"block\">",
             "        <mrow><msub><mi>x</mi><mi>t</mi></msub><mo>=</mo>…</mrow>",
             "      </math>"] }
```

`num` 可省。写法、常用元素、以及「长推导不要写」，见 `references/layout.md`「公式：原生 MathML」。
只是一个符号的行内记号不要开 `eq` 块，直接在 `html` 里写 `<span class="formula">x_t</span>`。

### `example`

```json
{ "type": "example",
  "html": ["    <p>同一位病人 2024-03-11 因胸痛来急诊，18:42 做了第一张 ECG……</p>"] }
```

`.tag` 固定是「举个例子」，渲染器补，不用写进 JSON。
里面装什么（具体数字 / 具体输入输出 / 做对做错的对照）见 `references/writing.md` 第 4 条
——那是全篇最容易敷衍的一处。

### `pointer`

```json
{ "type": "pointer", "tag": "原图",
  "html": ["    <p>该文 Fig. 2 画的是三个编码器如何共享同一个时间轴对齐模块。",
           "      <a href=\"https://doi.org/…\" target=\"_blank\" rel=\"noopener\">DOI</a></p>"] }
```

取不到原图、或当前模型看不见图时用，指向原文那张图。
⚠️ **它不顶替 `example`。** 指路卡片没有数字、没有输入输出、没有对照，
是「具体例子」的反面；下面 J-B 组那条闸门数的是 `type == "example"`，天然数不到它。

---

## JSON → HTML 渲染对照表

第 5.5 小步照这张表贴。左边是 JSON 里的字段，右边是模板里的标记，
**中间没有任何需要发挥的余地**。

| JSON | HTML |
|---|---|
| `title` | `.deck-head > h1` |
| `readingMinutes` / `date` | `p.meta` 里的「约 N 分钟」与 `<time datetime="…">最后更新 …</time>` |
| `forWhom` | `p.for-whom` |
| `map.intro` / `map.svg` / `map.caption` | `section.map#map` 里的 `<p>` / `figure > svg` / `figcaption`（`<b>图 {num}</b>` 前缀） |
| `path[]` | `section.path#path > ol > li`：`<a href="{href}">{label}</a>（{time}，{hint}）` + `<span class="answers">读完能回答：{answers}</span>` |
| `primer.items[]` | `section.primer#primer > dl`：`<dt>{term}</dt>` + `<dd>{html}</dd>` |
| `chapters[].number` / `.title` / `.lede` | `<div class="curtain" id="{id}">` 里的 `.curtain-num`（写 `§{number}`）/ `.curtain-title` / `.curtain-lede` |
| `chapters[].lede` | 紧跟的 `<section class="concept">` 的第一个元素 `<p class="lede">`（**与上面那句逐字相同**） |
| `chapters[].aside` | `<aside class="aside reveal">` |
| `chapters[].blocks[]` | 见上面五个块各自的写法，按数组顺序排 |
| `chapters[].boundary[]` | `<div class="boundary reveal"><h3>常见误解与边界</h3><ul><li>…</li></ul></div>` |
| `chapters[].source[]` | `<div class="source reveal"><h3>出处</h3><ul><li>…</li></ul></div>` |
| `chapters[].checkout` | `<p class="checkout reveal"><b>读完这节你应该能回答：</b>{checkout}</p>` |
| （固定）| `<p class="back"><a href="#map">↑ 回知识地图</a></p>`，每章末尾都有，JSON 里不写 |
| `compare` | `section.compare#compare`：`<h2>{title}</h2>` + `{intro}` + `.table-wrap > table`（`head` 进 `thead th[scope=col]`，`rows[i][0]` 进 `tbody th[scope=row]`，其余进 `td`）+ `p.back` |
| `wrapup` | `section.wrapup#wrapup`：`<h2>{title}</h2>` + `{html}` |
| `glossary[]` | `section.glossary#glossary > dl`：`<dt id="{id}">{zh}<span class="en">{en}</span></dt>` + `<dd>{def}<span class="where">首次出现 {where}</span></dd>` |
| `next.*` | `section.next#next`：四个 `<h3>`（必读 / 选读 / 该上手跑什么 / 下一个 learning-deck）各带一个 `<ul>`，`<li>{text}<span class="why">{why}</span></li>`（`why` 可省） |
| `references[]` | `section.refs#refs > ol > li`：`{text}<br><a class="ref-link" href="{url}" target="_blank" rel="noopener">{linkText}</a>` |
| `honesty[]` | `section.honesty#honesty > ul > li` |
| `.toc` 条目 | 由 `map` / `path` / `primer` / `chapters` / `compare` / `wrapup` / `glossary` / `next` / `references` / `honesty` 有没有内容决定；知识点那组写 `§{number} {title}`，其余条目**只写名字不编号** |

⚠️ 所有外链一律 `target="_blank" rel="noopener"`；
所有颜色一律 `var(--x, #xxx)`；这两条见 SKILL.md 硬约束第 2–4 条。

---

## JSON 层自检（交付前，6 组）

**读一遍整份 JSON 逐条核对。** 它小到读得完——这正是它比在两千行 HTML 上数 class
强的地方：下面每一条都是**直接断言**，不是拿文本当结构的代理。

⚠️ **不要为了核这些写脚本。** `node` 在 Electron 里确实存在，但 SKILL.md 硬约束第 5 条
保持绝对：一旦开了「只读校验可以用脚本」的口子，上两次的教训是它会长成「修改也用脚本」。
规则简单没有例外，才挡得住。

**J-A 章节骨架**

1. `chapters[i].number === i + 1`，`chapters[i].id === "c" + number`，全篇连续无跳号。
2. 每章 `title` / `lede` / `tier` / `checkout` 都非空，`boundary` 与 `source` 各至少 1 条；
   `tier` 只在 `"听过但说不清"` / `"没接触过"` 两个值里取。
3. 任何 `html` / `intro` / `aside` 里**不出现 `<h2>`、不出现 `class="counter"`**
   ——标题与编号只在幕封页出现一次。
4. 全篇搜不到 `TODO` / `待补` / `占位`；每章的 `blocks` / `boundary` / `source` 都不是 `[]`。
   （`compare` 写成 `null`、`next.optional` 留空是合法的，那是「这份报告没有这一项」，不是没写完。）

**J-B 每章的闸门**

5. 每章 `blocks` 里 `type === "example"` 的**至少 1 个**；`pointer` 不计入。
6. 每章 `blocks` 里 `type === "figure"` 的**至少 1 个**（每个重点知识点至少一张机制图）。
7. 每个 `figure` 有 `credit.kind`；`"original"` / `"redrawn"` 的还要有 `paper` 与 `url`。
8. `num` 全篇不重复、从 1（`map` 那张）连续数下来。

**J-C 术语与锚点**

9. 正文里出现的每一个缩写（连着两个以上大写字母：AMI、ECG、ELBO、CFG…）
   在 `glossary` 里有一条（`en` 或 `zh` 命中）。**逐个去搜，别靠印象。**
10. 每个 `href="#g-…"` 的目标在 `glossary[].id` 里；
    每个 `href="#c…"` 的目标在 `chapters[].id` 里；
    `map.svg` 里每个节点链接的目标落在 `chapters[].id` / `glossary[].id` / `#primer` / `#wrapup` 之内。
11. `glossary[].where` 写的是 `§N` 或辅助小节的名字，且那一节真的是它第一次出现的地方。

**J-D 编号记法**

12. `§` 只用在知识点章节上。`path[]` 里指向章节的条目写 `§N 标题`，
    指向 ④⑥⑦ 这些辅助小节的**不带 `§`**，只写名字。
13. 全篇没有 `01` / `第 1 章` / `第 N / M 个` 这类第二种记法。

**J-E 文献**

14. `references[].verified` 全为 `true`；有一条不是就把那条删掉。
15. `source[]` 与正文里出现的每个 DOI / arXiv id，在 `references` 里都能找到。

**J-F 档位对深度**（`references/writing.md` 第 7 条的结构化形态）

16. `tier === "没接触过"` 的章，第一个 `prose` 块的 `html` **不少于两段**，
    且第一段里没有本章的核心术语。
17. `tier === "听过但说不清"` 的章，第一个 `figure` 块出现在 `blocks` 的前三个之内
    （「三段之内进入机制」）。
18. 标「熟悉」的知识点**没有**成章，只在 `map.svg` 里作 `.n-known` 节点出现。

不过关就回第 5.3 小步改那一章，**这时候 HTML 还不存在**，改起来只有几行。

写作质量那七条（例子里有没有数字、边界有没有具体情形、祈使句多不多、
单段新术语超没超两个）是**人读**的，见 `references/writing.md` 第 9 条，
在这一步一起读掉。
