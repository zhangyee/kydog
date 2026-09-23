---
name: sync-skill-docs
description: 审核 src/skills/ 下内置 skill 的漂移时使用——中英文两版内容不一致，或 skill 写的做法与实际代码/CLI 脱节（改完 skill、发版前）。触发词：skill 文档审核、同步 skill、中英文不一致、sync skill docs。
---

# sync-skill-docs

审核 `src/skills/` 里内置 skill 的两类漂移，然后**先给出方案、等用户批准，再动手改**。

- **中英文漂移**——某个文件与它的 `.en` 变体在结构或内容上不一致。
- **代码漂移**——skill 里写的做法，代码/CLI 已经不这么做了。

核心原则：**行为以代码为准；散文以中文版为写作基准。** 审核阶段绝不改文件。
流程是：产出发现 → 提方案 → 得到明确同意 → 执行 → 提交。

## 文档清单

**双语对**——`src/skills/<name>/` 下每个文件与它的 `<base>.en.<ext>`，包括
`SKILL.md`、`references/*.md`、`assets/*`。

**豁免**：目前一条都没有。上游 fastpaper 在 v0.7.0 补齐了 `SKILL.en.md`，原先那条
有期限的豁免已经删掉，`src/skills/fastpaper/` 现在和其余六个一样纳入 Pass A。

**但 fastpaper 这一对的修法不同**：它的两份都是上游 `zhangyee/fastpaper-cli` 的产物，
经 `npm run cli:update fastpaper` 整树镜像过来。发现漂移**不要在本仓库改**——改了下次
同步就被覆盖，而且上游那边还错着。去上游修，发新 tag，再 `cli:update` 拉回来。

> 豁免清单与 `src/main/skills/builtinSkillsI18n.test.ts` 的 `EXEMPT` 常量同源。
> 改一处必须改另一处，否则单测与审核会给出矛盾的结论。
> 该单测还会检查每条豁免是否仍挡着真实缺口——挡不到东西时它自己变红，
> 催你把这两处一起删掉，而不是让例外无声地留一辈子。（fastpaper 那条就是这么走完的。）

## 有意的双语差异（已裁决，不要"修正"）

下面这些中英文不一致是**刻意的**，理由已经审过。**Pass A 第 2 条「数字与标识符必须完全一致」
不适用于这张表里的行** —— 撞上了直接跳过，不要按"以中文版为准"回改，也不必再找用户裁决。
表外的任何数字差异仍然按漂移处理。

| 文件与行 | 中文 | 英文 | 为什么 | 裁决日期 |
|---|---|---|---|---|
| `fact-check/SKILL.md:148` | 控制在 800–1200 **字** | Keep it to 500–750 **words** | 见下「字数预算」 | 2026-08-27 |
| `research-frontier/SKILL.md:3`（description） | 1500–2500 **字** | 900–1500 **words** | 同上 | 2026-08-27 |
| `research-frontier/SKILL.md:8` | 1500–2500 **字** | 900–1500 **words** | 同上 | 2026-08-27 |
| `research-frontier/SKILL.md:230` | 1500–2500 **字** | 900–1500 **words** | 同上 | 2026-08-27 |
| `research-frontier/assets/briefing-template.md:9` | 1500–2500 **字** | 900–1500 **words** | 同上 | 2026-08-27 |
| `literature-review/SKILL.md:30`（篇幅档「短」） | 800–1200 **字** | 500–750 **words** | 见下「字数预算」 | 2026-08-27 |
| `literature-review/SKILL.md:31`（篇幅档「中」） | 2000–3000 **字** | 1200–1800 **words** | 同上 | 2026-08-27 |
| `literature-review/SKILL.md:32`（篇幅档「长」） | 4000–6000 **字** | 2400–3600 **words** | 同上 | 2026-08-27 |
| `paper-summary/SKILL.en.md:106` | 「作者 等（年份）」或 (Author et al., year) | **原样并列**，中文串保留 | 见下「保留的中文字面量」 | 2026-08-27 |
| `literature-review/SKILL.en.md:193` | 同上 | **原样并列**，中文串保留 | 同上 | 2026-08-27 |
| `literature-review/references/search-strategy.en.md:54` | 综述、述评、进展、研究现状、展望 | **原样保留**，不译 | 同上 | 2026-08-27 |
| `learning-deck/references/deck-json.md:177` | 可见**汉字**数 ÷ **350** | visible **words** ÷ **210** | 见下「阅读速度」 | 2026-08-27 |
| `learning-deck/references/layout.md:386` | ÷ **350**（中文技术材料 **300–400** 字/分） | ÷ **210**（English technical material **180–240** words/min） | 同上 | 2026-08-27 |
| `learning-deck/assets/report-template.html:1010`（`.deck-head .meta` 注释里的算法） | ÷ **350**（中文技术材料 **300–400** 字/分） | ÷ **210**（English technical material **180–240** words/min） | 同上；这是同一条算法的**第三处** | 2026-08-27 |
| `learning-deck/references/*.md`、`SKILL.md`（`tier` 枚举） | `"听过但说不清"` / `"没接触过"`（另有档位名「熟悉」） | `"heard of it, cannot explain"` / `"never encountered"`（另有 `familiar`） | 见下「learning-deck 的 `tier` 枚举」 | 2026-08-27 |
| `learning-deck/SKILL.en.md:292` | 「听过**、**说不清」（中文版此处用了变体写法） | `"heard of it, cannot explain"`（正名） | 见下「learning-deck 的 `tier` 枚举」 | 2026-08-27 |
| `learning-deck/references/interview.en.md:49` | 「听过**，**说不清」（示例 `label`，第二种变体写法） | `Heard of it, cannot explain`（正名） | 同上，另见「示例 label 的副作用」 | 2026-08-27 |
| `learning-deck/SKILL.en.md`、`references/layout.en.md`、两份 `assets/report-template*.html`（哨兵前缀 `⟨待填`） | `⟨待填⟩` / `⟨待填：…⟩` | **原样保留**，不译；带说明那一种在 en 侧用半角冒号 `⟨待填: …⟩` | 见下「`⟨待填⟩` 与 ④-ANCHOR」 | 2026-08-28 |
| `learning-deck/references/layout.md:884`（H2 的「模板自带 4 处」） | 断言依赖模板 L44/45/46/50 的中文散文注释字面 | **同一个数 4**，依赖同样四行 | 见下「H2 的标定常数」 | 2026-08-27 |
| `learning-deck/SKILL.en.md:3`（description） | 「它比直接讲解多做的事：**先问清起点再决定讲什么**，…」 | 该分句**未译出**，其余四项全在 | 见下「learning-deck 的 description」 | 2026-08-27 |
| `learning-deck/assets/report-template.html:2`（`<html lang>`） | `lang="zh"` | `lang="en"` | 文档语言声明，各自跟本份模板的默认产出语言走。`SKILL.{md,en.md}` 与全部 `references/*.md` 无一处提到 `lang`，模型从未被告知可以改它 | 2026-08-27 |
| 两份 `assets/report-template*.html`（scrollspy 尾部的布局锚点注释，插入点在原 :2339 之后） | 注释 9 行，总行数 **2805** | 注释 12 行，总行数 **2808** | 同一机理（iframe 无布局时首次 sync() 锁死末条，IO 锚定真实布局）的两种语言表述，英文散文天然更长。用户裁决接受行数不再平价：**自插入点起两份模板行号不再一一对应**，此后跨模板引用行号需各写各的；插入点之前（含全部 `⟨待填` 命中行 ≤2127 与 H2 标定常数所在行）行号仍逐一相同 | 2026-09-01 |
| `learning-deck/assets/report-template.html:2093`（⑦ 术语表 `dt` 的两个槽） | `<dt id="g-xxx">中文<span class="en">English</span></dt>` | `<dt id="g-xxx">Term</dt>` | 英文报告下 `original` 省掉，示例必须示范省掉它，否则模型照抄就排重复影子；见下「⑦ 术语对照的两个槽」 | 2026-08-28 |
| `learning-deck/references/deck-json.md:107`（`glossary` 示例） | `"term": "马尔可夫链", "original": "Markov chain"` | **只写 `"term": "Markov chain"`，不写 `original`** | 同上；`original` 已改成可选字段，英文报告里两个槽只能填同一个词，示例必须示范省掉它 | 2026-08-28 |
| `slowpaper/references/scholar.md:11` ↔ `.en.md:12` | 约 **49.1 万**条结果 | about **491,000** results | **同一个数的两种书写习惯**：中文按「万」分节，英文按千分位。照抄任一侧都会让另一侧读起来像机器翻译。这是本地化，不是漂移 | 2026-09-09 |
| `slowpaper/references/pubscholar.md` ↔ `.en.md`（可检索条数） | 约 **1.08 亿**条 | about **108 million** records | **同一个数的两种书写习惯**：中文按「亿」分节，英文按 million。与上一行 scholar 那条同一裁决 | 2026-09-16 |
| `slowpaper/references/carsi.md:103` ↔ `.en.md:126`（快照上那个记号） | `(已填入机构账号，值不显示)` | **原样保留中文串**，解释文字译成英文 | 它是 `snapshot.ts` 的 `line()` **实发的字面量**，与 locale 无关 —— agent 要在工具结果里逐字认出它。译过去就等于教 agent 去认一个永远不会出现的串。同一份文件里已有两处同款先例（`机构登录: ` 那一行、`实际填的账号框：…` 那句回显）。两侧都由 `slowpaperDocConstants.test.ts` 与 `snapshot.ts` 对账 | 2026-09-09 |
| `slowpaper/references/scholar.md:142` ↔ `.en.md:161`（被引数那一格） | 文本「被引用次数：**7347**」 | 「被引用次数：**7347**」 / "Cited by **7347**" —— 同一个数出现**两次** | 这一格给的是要在页面上逐字认的文案，而 Scholar 的界面语言会变（`hl=en` 时是 "Cited by"）。英文侧把两种界面语言的原文**并列**给出，中文侧只给中文界面那一种；数字出现两次是并列的副产品，不是第二个值 | 2026-09-09 |
| `slowpaper/references/browser.md:303` ↔ `.en.md:366`（标签上那个按钮名） | 「保留」 | **原样保留中文串**，后面加注 `(Keep)` | 按钮上的字在 `TabStrip.tsx` 里**写死成中文**，界面切到英文也还是「保留」。译成 Keep 等于让模型叫用户去找一个界面上根本没有的按钮。与 `carsi.md` 那一行同类：模型要转述的是界面上**实际出现**的字面量。按钮一旦做了本地化，这一行就该撤掉、英文侧改成译名 | 2026-09-14 |

**字数预算**：单位从「字」换成「words」时数值必须一起换（约 0.6 word/字），不能照抄数字。
这几条指令自己写明了意图——「写长了没人读，而且会不可避免地滑向综述」「价值在判定和证据链，
不在铺陈」；literature-review 那三档是投稿场合的实际篇幅（会议 Related Work / 期刊研究现状 /
学位论文章节），照抄 "4000–6000 words" 会写出一份没有任何期刊收得下的东西。
直译成 "1500–2500 words" 同样会让英文产物长出近一倍，正好背叛这条指令本身。
**判定标准是行为等价，不是字面等价。**

> literature-review 的篇数上限（正文 25–35 篇 / 12–18 篇）**没有**跟着换算，是对的：
> 那是检索铺开的宽度，不是散文长度，两种语言下同一档要覆盖的文献量一样。

**保留的中文字面量**：判定靠**落点与可恢复性**，不靠界面 locale。
`SKILL.en.md` 自己写明「They ask in Chinese, you produce Chinese — prose, report and section
headings all follow」——**产物跟的是用户说话的语言，不是界面 locale**，所以「英文界面下报告
就是英文」不是理由。真正的分界是：

- **落进用户自己的东西**（论文正文、送进 CLI 的 query 串）→ **原样保留中文**。
  弄错了要用户手工返工，或者命令根本搜不到东西，超出这份产物的边界。
  - `paper-summary/SKILL.en.md:106`、`literature-review/SKILL.en.md:193` 的引用格式
    「作者 等（年份）」——它进的是**用户自己的论文**，英文界面下的中文提问者仍要拿到中文格式。
  - `search-strategy.en.md:54` 的「综述、述评、进展、研究现状、展望」——它是直接送进
    `xueshu`（中文源）的**检索串**，翻成英文这条检索指令直接作废。
- **落进模型自己写的报告**（如 `literature-review/assets/report-template.en.md:68-69` 的
  「作者（年份）《题名》」→ `"Author (year), Title"`）→ **翻成英文**。错了不出这份文件的边界，
  重跑一次即可。research-ideation / fact-check / research-frontier 的英文模板同此裁决。

**阅读速度**：`readingMinutes` 是**算给读者看的数**，不是控制篇幅的预算，但换算理由和「字数预算」
同源——单位从「汉字」换成「words」时除数必须跟着换。照抄 350 会让英文报告的时长虚高近一倍。
按同一个 0.6 word/字：`350 × 0.6 = 210`，区间 `300–400 × 0.6 = 180–240`，落在英文技术材料的
常见阅读速度带内。**三处必须同时改**（`deck-json.md` 顶层那条 + `layout.md`「① 抬头的顶部两件套」
+ `assets/report-template.html` 的 `.deck-head .meta` 注释），它们互相声明「算法一致」。
「每张图 +0.5 分钟」不换算——那是图，不是字。

**learning-deck 的 `tier` 枚举**：`tier` 是**模型自己写、自己读**的内部字段，
既不进 HTML（`deck-json.md` 的渲染对照表里没有它），也不进 CLI，`SKILL.md` 第 5.2 小步还明令
**不许把档位名给用户看**（「档位名是我们内部的标签，他没见过这三个词」）。
按上面「保留的中文字面量」那条已裁决的判据（落点与可恢复性），它落在
「落进模型自己写的东西 → 翻成英文」那一侧，所以译。
`interview.md` 的三个 `label` 本来就随用户语言走，不译会让 en 树出现
「选项是英文、落档要写中文串」的自相矛盾。**六个文件的三个名字必须逐字一致**
（`familiar` / `heard of it, cannot explain` / `never encountered`），
中文版有**两处**变体写法在英文侧统一成了正名——枚举值出现第二、第三种拼法是真缺陷，不照抄：
`SKILL.md:292`「听过**、**说不清」（顿号）、`references/interview.md:49`「听过**，**说不清」（逗号）。
全仓另有 13 处是正名「听过但说不清」；`没接触过` 与「熟悉」没有变体。

> **示例 label 的副作用（登记，不改译文）**：`interview.md:49` 那处变体在中文里是
> 示例 `label` 与档位名**三取一相同**，归一之后英文变成**三取二相同**
> （`Heard of it, cannot explain` 与 `Never encountered` 都与档位名逐字相同，只有
> `Can explain it` / `familiar` 仍然不同）。紧接着的 `:57` 正要教「`label` 措辞按主题调、
> 档位固定」，`SKILL.en.md:286` 又说用户「never seen those three words」——
> 英文侧的自相矛盾比中文侧更明显。**运行不会挂，是教学性退化。**
> 根子在中文版把示例 label 写成了档位名的近似串；中文侧把 `:49` 的示例 label
> 改成一个真正定制过的措辞（如「知道公式，没想过统计范围」）之后，英文侧跟着改，这条登记即可撤销。

**`⟨待填⟩` 与 ④-ANCHOR**（2026-08-28 修订，见下面「H1 的两处失效」）：`⟨待填` 是**哨兵串前缀**，
`layout.md` 的自检 H1 直接 `grep -n '⟨待填' report.html`。记号有两种形态——光杆的 `⟨待填⟩`
与带说明文字的 `⟨待填：…⟩`（en 模板同位置是 `⟨待填: …⟩`，半角冒号），**两种都必须被前缀命中**。
不变量（2026-08-28 实测，两份模板逐一对应）：

| 断言 | `report-template.html` | `report-template.en.html` |
|---|---:|---:|
| `grep -c '⟨待填'` 行数 | **17** | **17** |
| `grep -o '⟨待填' \| wc -l` 处数 | **18**（`:2030` 一行两处） | **18** |
| 其中光杆 `⟨待填⟩` | 11 行 | 11 行 |
| `<body>`（L1926）之前的命中 | **0** | **0** |
| 命中行号 | 1952 / 1999 / 2019 / 2028 / 2030 / 2033 / 2043 / 2050 / 2069 / 2074 / 2078 / 2085 / 2086 / 2096 / 2104 / 2119 / 2127 | **逐一相同** |

**这 17 行全部是可被一次 `edit` 消费的填充位**，所以「交付时一条都不该剩」在新模式下是真的
（模拟一份填满的交付物实测：新旧模式都 0 行）。**文件头零命中是硬不变量**——H2 要求文件头
原样保留在交付物里，文件头里再出现字面记号就等于给 H1 造一条修不掉的恒红。
英文版按「技术标识符不动」保留原串，两份模板的 17 行一字未译。
④-ANCHOR 那行注释的**散文部分**已译，en 模板 `:2069` 逐字就是：
`<!-- ④-ANCHOR insert concept chapters before this line ⟨待填⟩ -->`
（`SKILL.en.md:397` 与 `references/layout.en.md:518` 拿它当 `oldText`，对不上 `edit` 会报错）。

> **H1 的两处失效（2026-08-28 已修，登记留档）**：原先 H1 写的是精确匹配 `grep '⟨待填⟩'`。
> (1) **假阳恒红 4 行**：模板文件头 L10/L14/L15 的散文本身带这个串（L15 还逐字引用了这条 grep
>     命令），而 H2 明确要求文件头原样保留；另有 L2065 在 ④ 那段**不作为 `oldText`、交付后存活**的
>     说明注释里也带着它。四行在每一份完成的报告上恒红且永远修不掉——正好训练操作者忽略
>     `layout.md` 自己写明的「H1 命中就是返工信号」。
>     修法：四行的散文改用「待填记号」/ "fill mark" 指代，不再出现字面串。
> (2) **假阴 7 处**：`⟨待填：…⟩`（`:1952` / `:2019` / `:2030`×2 / `:2033` / `:2074` / `:2085`）
>     精确匹配查不到。其中 `:1952` 的 `data-hero` **全盲**——该块内没有裸哨兵兜底，JS 对无法
>     识别的值静默退回 gridwave，页面照常渲染。修法：模式改成前缀 `⟨待填`。
> 两条中英同时修，`SKILL.{md,en.md}:37/378` 的记号说明也一并改成「两种形态」。

**H2 的标定常数**：`layout.md` / `layout.en.md` 的自检 H2 把**对模板散文注释的计数断言写死在注释里**，
四个数对 `assets/report-template.html` **与 `assets/report-template.en.html` 两份**实测全部精确命中：

| grep | 命中数 | 文中写法 | 命中位置 |
|---|---:|---|---|
| `src="http\|@import\|url(http\|…` | **4** | 「模板自带 4 处」/ "comes with 4 matches" | 两份模板都在 **L44/45/46/50** |
| `^<script>` | **1** | 「这个数正好 1」/ "exactly 1" | 文末唯一脚本块 |
| `<script`（任意位置） | **12** | 「十来处」/ "a dozen" | 硬约束注释 + `<style>` 内 + 脚本内 |
| `fill="#\|stroke="#\|color: *#\|background: *#` | **13** | 「十来处」/ "a dozen or so" | `<style>` 的 `@media print` |

**这是第三条跨批次契约。** 那 4 处命中来自模板 L44/45/46/50 的散文注释，英文版为此**保住了记号的字面形态**：

```
44:  2. Pull in no external resource: no CDN, no <link rel=stylesheet>, no @import,
45:     no web fonts, no <img src="http…">, no url() in the CSS pointing at the network,
46:     no fetch/XHR/WebSocket in the script (the CSP blocks them, but do not write code that obviously fakes it either).
50:     not a resource, and is allowed; loading it as a resource (img/link/@import) is not.
```

**字面形态必须保持能被同一条 grep 命中**（`<img src="http…">` 不能改写成
`an <img> pointing at http`，`@import` / `fetch` / `XMLHttpRequest` / `WebSocket` 等词不能拆开或复述）。
命中数从 4 变 3，H2 注释里「模板自带 4 处，都不是违规」就成了错的标定 → 漏判或误判。
与 `⟨待填⟩` 同类：**改模板会让 `layout.*.md` 里的常数失效，而失效不报错。**
真要改动那几行，就得同时改 `layout.md:884` 与 `layout.en.md:884` 的数字，**并且两份模板一起改**。

**learning-deck 的 description**：中文 381 字符、英文 986（余量 38），是六个 skill 里最紧的一份。
直译约 1300，超 1024 会让它在 en 树里静默降级成禁用行。压缩只动叙述句：
**九条触发场景一条未删、词形全保**，与 `/paper-summary` 的消歧整句保留；
删掉的是「先问清起点再决定讲什么」——它与同一句开头的
「Three interview rounds find which layer the user already stands on … fill in only the missing layers」
表达的是同一件事，属于中文版内部的复述，去掉不损失任何触发面或行为约束。

**⑦ 术语对照的两个槽（2026-08-28 用户裁决，已修）**：
`deck-json.md:382` 的渲染对照把术语表的 `dt` 写死成两个具名槽，原先叫 `zh` / `en`
（`<dt id="{id}">{zh}<span class="en">{en}</span></dt>`），模板 `:2093` 是它的字面示例。
这套结构假定「产物语言 ≠ 英文」，于是「术语本体 + 英文对照」永远是两个不同的词。
**英文报告里两个槽只能填同一个词**，⑦ 整节退化成一列重复影子
（那一批的英文示例就写成了 `"zh": "Markov chain", "en": "Markov chain"`）。
`.glossary dt .en` 那条 CSS 还会把重复的那份用更小的 sans 字号再排一遍，视觉上更明显。

**裁决分两步走。** 先把外语原词改成**可选字段**——没写、或与术语本体逐字相同时，
`<span class="en">` 整个不渲染；再把**字段名**从 `zh` / `en` 换成 `term` / `original`
（`term` = 本报告语言的术语本体，必填；`original` = 外语原词，可省）。
换名是因为旧名字在英文报告里撒谎：一个叫 `zh` 的字段装着 `"Markov chain"`，
而模型写 JSON 时是照 schema 里的 key 理解语义的，猜错的代价是整节术语表跑偏。
**这是 skill 的行为规则，中英两版同时写明，不是 en 侧的单边旁路。**
**CSS class 名 `.en` 没动**——它是样式钩子，改了要连带动 `<style>` 里的规则，
而 class 名不参与模型的语义推理。落到六处，缺一处就是漂移：

| 位置 | 改了什么 |
|---|---|
| `deck-json.md:107` / `deck-json.en.md:107` | schema 示例的 key 换成 `term` / `original`；en 侧只写 `term`，示范省掉 `original`（见上表那一行） |
| `deck-json.md:382` / `deck-json.en.md:382` | 渲染对照换成 `{term}` / `{original}`，并写明「`original` 可省 → 整个 span 不渲染」 |
| `deck-json.md:430` / `deck-json.en.md:430` | JSON 自检 J-C 第 11 条：缩写命中从「`en` 或 `zh`」改成「`term` 命中，写了 `original` 的话 `original` 命中」 |
| `layout.md:365` / `layout.en.md:365` | ⑦ 那一行块表：`span.en` 从「英文原词」改「外语原词」，并标「与术语本身相同就整个不写」 |
| 两份模板 `:2089` | ⑦ 节首注释不再说「中英对照 / paired with its English」，也跟着改成「外语原词」 |
| 两份模板 `:2095` | 在 `dt` 样例下面写明省略规则，字段名用 `original`；该行是可选化那一步新增的，两份模板同步 +1 行，行数仍相同 |

> 2026-08-27 删掉了 `research-ideation/SKILL.en.md:78/79` 两条「保留中文串」登记及其
> 「硬编码中文串」说明段。`src/main/agent/askAnswers.ts` 的 `renderOutcome` 已按 locale
> 本地化（commit `6610855`），en 分支回给模型的是
> `(the user skipped this question)` / `The user closed the prompt without answering.`，
> `SKILL.en.md` 那两行已同步成英文、全文零中文字符。原登记写好的退出条件已兑现。

---

## Pass A — 中英文一致性

对每一对：

1. **结构**：`grep -c '^#' 两个文件`——标题数量必须相同，小节顺序必须对应。
2. **内容**：通读两版。一版里的每条指令、列表项、表格行、代码块、命令、相对路径，
   另一版都必须有。**数字与标识符必须完全一致**（步骤编号、上限值、文件名、工具名）。
3. **frontmatter**：`name` 必须完全相同；`description` 是同一句话的两种语言，
   不能一边描述了触发场景另一边没有。
   **改中文 description 之前，先量一遍英文侧的余量。** 英文平均是中文的 3.4–3.7 倍，
   中文加一个短句 = 英文加几十上百字符。超过 1024 时 `parseSkillFrontmatter`
   （`src/main/skills/parseSkillFrontmatter.ts:33`）返回 `ok:false`，那个 skill 在 en 树里
   降级成禁用行、**根本进不了 system prompt** —— 不报错、不崩，只是安静地不再被触发。
   当前余量见下表（2026-09-18 全量重测；`fastpaper` 是上游镜像，列出来只为量预算）。

   **2026-09-16 实测到一次真的降级**：slowpaper 的英文 description 里一个**半角 `: `**
   让 YAML 判成嵌套 mapping，`parseFrontmatter` 直接抛 —— 那一刻 `npm test` 3323 条全绿，
   而 slowpaper 在 en 树里已经是禁用行。守卫已补进
   `src/main/skills/builtinSkillsI18n.test.ts`（真文件喂进 `parseSkillFrontmatter`，
   同时挡住超长那一类）。那条只告诉你「已经超了」；这张表给的是「还能加多少字」的预算，
   **由 `src/main/skills/skillDescriptionBudget.test.ts` 钉住**：每个内置 skill 一行、数字与真文件
   逐个对得上、「最紧」标在余量最小的那一行。改了 description 没更新表，`npm test` 当场红，
   报错里给出实测数字，照抄进来即可（2026-09-17 这张表曾漂过：slowpaper 表里写余量 33、
   实际只剩 13，还漏了 fastpaper，而没有任何东西报错）。余量 = 1024 − 中英两份里较长的那一份：

   | skill | 中文 | 英文 | 余量 |
   |---|---:|---:|---:|
   | `learning-deck` | 381 | 986 | **38** ← 最紧 |
   | `slowpaper` | 384 | 981 | 43 |
   | `literature-review` | 278 | 980 | 44 |
   | `peer-review-response` | 264 | 937 | 87 |
   | `fact-check` | 253 | 929 | 95 |
   | `research-frontier` | 260 | 929 | 95 |
   | `paper-summary` | 253 | 895 | 129 |
   | `peer-review` | 281 | 863 | 161 |
   | `research-ideation` | 227 | 770 | 254 |
   | `fastpaper` | 418 | 688 | 336 |

   量法必须走生产代码那条路（`parseFrontmatter` + 长度校验），**不能用正则数**——
   无引号 plain scalar 里的半角 `: ` 会被 YAML 判成嵌套 mapping，正则看不出来。
   压缩时**先压叙述性解释句，触发场景一条都不能删**（表面词形决定匹配）。
4. **HTML 类模板**（如 `learning-deck/assets/report-template.html`）：
   除可见文本外，还要比对 DOM 结构、CSS 选择器与 JS 里的字符串字面量。
   只看渲染后的可见文字会漏掉一半。

## Pass B — 代码一致性

| skill 里的声明 | 事实来源 | 如何检查 |
|---|---|---|
| 调用的 CLI 名称与子命令 | `vendor/current/` 下的实际二进制 | 跑 `--help` 核对子命令与参数确实存在 |
| 引用的相对路径（`references/x.md`、`assets/y.html`） | 该 skill 目录 | 每个被引用的路径都真实存在，中英文两侧都要查 |
| 产出物的文件类型与打开方式 | `src/renderer/panels/main-pane/` 的 tab 实现 | skill 说会产出 html/pdf/md 时，对应 tab 确实支持 |
| 步骤里提到的工具能力 | pi 的工具集 | 别写 KyDog 没有的工具 |

## 产出 → 批准 → 执行 → 提交

1. **发现**：一张表，最严重的在前。每行：`file:line`、漂移类型（`双语` / `代码`）、
   哪里错了、事实来源。
2. **提议方案**，逐条分类：
   - **翻译同步**——在双语版之间补齐缺失/更新的内容（以中文版为准，除非英文侧才是更新的事实）。
   - **照代码更新**——改写 skill 使其与当前代码相符。
   - 任何模糊之处（如疑似有意为之的措辞差异）交由用户裁决，不要擅自"修正"。
3. **等待明确批准。** 用户说开始之前不要改。若用户调整方案，重新复述一遍。
4. **只执行**已批准的条目。
5. **验证**：`npm test -- builtinSkillsI18n` + 重跑 Pass A 的结构检查。
6. **提交**，一行中文描述本次同步了什么，不带 Conventional Commits 前缀。

## 常见错误

- **信文档不信代码。** 二者冲突时代码是对的、skill 是 bug（除非代码本身才是 bug——
  那就单独标出来，别把坏行为当成"预期"写进 skill）。
- **只比可见文字。** HTML 模板的 CSS 与 JS 字符串里也有要翻的东西。
- **未批先改。** 本 skill 只提方案，由用户批准。批准前动手就违反了流程。
- **拿单测当内容保证。** `builtinSkillsI18n.test.ts` 只校验双语文件**存在**，
  校验不了内容有没有同步。那正是本 skill 存在的理由。
