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

**豁免**（**不要**当成"缺翻译"来标记）：
- `src/skills/fastpaper/`——归上游 fastpaper-cli，本仓库只负责接纳。
  **这条有期限**：上游发出双语 tag、`cli:update` 拉进来之后，它会自然通过配对校验，
  届时把这条豁免删掉，并把这一对纳入 Pass A。

> 豁免清单与 `src/main/skills/builtinSkillsI18n.test.ts` 的 `EXEMPT` 常量同源（该测试在 Task 11 建立）。
> 改一处必须改另一处，否则单测与审核会给出矛盾的结论。

## 有意的双语差异（已裁决，不要"修正"）

下面这些中英文不一致是**刻意的**，理由已经审过。**Pass A 第 2 条「数字与标识符必须完全一致」
不适用于这张表里的行** —— 撞上了直接跳过，不要按"以中文版为准"回改，也不必再找用户裁决。
表外的任何数字差异仍然按漂移处理。

| 文件与行 | 中文 | 英文 | 为什么 | 裁决日期 |
|---|---|---|---|---|
| `fact-check/SKILL.md:148` | 控制在 800–1200 **字** | Keep it to 500–750 **words** | 见下「字数预算」 | 2026-08-27 |
| `research-frontier/SKILL.md:3`（description） | 1500–2500 **字** | 900–1500 **words** | 同上 | 2026-08-27 |
| `research-frontier/SKILL.md:8` | 1500–2500 **字** | 900–1500 **words** | 同上 | 2026-08-27 |
| `research-frontier/SKILL.md:213` | 1500–2500 **字** | 900–1500 **words** | 同上 | 2026-08-27 |
| `research-frontier/assets/briefing-template.md:9` | 1500–2500 **字** | 900–1500 **words** | 同上 | 2026-08-27 |
| `literature-review/SKILL.md:30`（篇幅档「短」） | 800–1200 **字** | 500–750 **words** | 见下「字数预算」 | 2026-08-27 |
| `literature-review/SKILL.md:31`（篇幅档「中」） | 2000–3000 **字** | 1200–1800 **words** | 同上 | 2026-08-27 |
| `literature-review/SKILL.md:32`（篇幅档「长」） | 4000–6000 **字** | 2400–3600 **words** | 同上 | 2026-08-27 |
| `paper-summary/SKILL.en.md:106` | 「作者 等（年份）」或 (Author et al., year) | **原样并列**，中文串保留 | 见下「保留的中文字面量」 | 2026-08-27 |
| `literature-review/SKILL.en.md:191` | 同上 | **原样并列**，中文串保留 | 同上 | 2026-08-27 |
| `literature-review/references/search-strategy.en.md:54` | 综述、述评、进展、研究现状、展望 | **原样保留**，不译 | 同上 | 2026-08-27 |
| `learning-deck/references/deck-json.md:177` | 可见**汉字**数 ÷ **350** | visible **words** ÷ **210** | 见下「阅读速度」 | 2026-08-27 |
| `learning-deck/references/layout.md:386` | ÷ **350**（中文技术材料 **300–400** 字/分） | ÷ **210**（English technical material **180–240** words/min） | 同上 | 2026-08-27 |
| `learning-deck/references/*.md`、`SKILL.md`（`tier` 枚举） | `"听过但说不清"` / `"没接触过"`（另有档位名「熟悉」） | `"heard of it, cannot explain"` / `"never encountered"`（另有 `familiar`） | 见下「learning-deck 的 `tier` 枚举」 | 2026-08-27 |
| `learning-deck/SKILL.en.md:292` | 「听过**、**说不清」（中文版此处用了变体写法） | `"heard of it, cannot explain"`（正名） | 见下「learning-deck 的 `tier` 枚举」 | 2026-08-27 |
| `learning-deck/references/interview.en.md:49` | 「听过**，**说不清」（示例 `label`，第二种变体写法） | `Heard of it, cannot explain`（正名） | 同上，另见「示例 label 的副作用」 | 2026-08-27 |
| `learning-deck/SKILL.en.md`、`references/layout.en.md`（`⟨待填⟩`） | `⟨待填⟩` | **原样保留**，不译 | 见下「`⟨待填⟩` 与 ④-ANCHOR」 | 2026-08-27 |
| `learning-deck/references/layout.md:879`（H2 的「模板自带 4 处」） | 断言依赖模板 L44/45/46/50 的中文散文注释字面 | **同一个数 4**，依赖同样四行 | 见下「H2 的标定常数」 | 2026-08-27 |
| `learning-deck/SKILL.en.md:3`（description） | 「它比直接讲解多做的事：**先问清起点再决定讲什么**，…」 | 该分句**未译出**，其余四项全在 | 见下「learning-deck 的 description」 | 2026-08-27 |

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
  - `paper-summary/SKILL.en.md:106`、`literature-review/SKILL.en.md:191` 的引用格式
    「作者 等（年份）」——它进的是**用户自己的论文**，英文界面下的中文提问者仍要拿到中文格式。
  - `search-strategy.en.md:54` 的「综述、述评、进展、研究现状、展望」——它是直接送进
    `xueshu`（中文源）的**检索串**，翻成英文这条检索指令直接作废。
- **落进模型自己写的报告**（如 `literature-review/assets/report-template.en.md:68-69` 的
  「作者（年份）《题名》」→ `"Author (year), Title"`）→ **翻成英文**。错了不出这份文件的边界，
  重跑一次即可。research-ideation / fact-check / research-frontier 的英文模板同此裁决。

**阅读速度**：`readingMinutes` 是**算给读者看的数**，不是控制篇幅的预算，但换算理由和「字数预算」
同源——单位从「汉字」换成「words」时除数必须跟着换。照抄 350 会让英文报告的时长虚高近一倍。
按同一个 0.6 word/字：`350 × 0.6 = 210`，区间 `300–400 × 0.6 = 180–240`，落在英文技术材料的
常见阅读速度带内。**两处必须同时改**（`deck-json.md` 顶层那条 + `layout.md`「① 抬头的顶部两件套」），
它们互相声明「算法一致」。「每张图 +0.5 分钟」不换算——那是图，不是字。

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

**`⟨待填⟩` 与 ④-ANCHOR**：`⟨待填⟩` 是**哨兵串**，`layout.md` 的自检 H1 直接
`grep -n '⟨待填⟩' report.html`，它必须和 `assets/report-template.html` 里的那 15 处逐字相同。
英文版按「技术标识符不动」保留原串，en 模板（下一批翻）**也必须保留 `⟨待填⟩` 不译**，
否则 H1 恒不命中——正好复现该注释里写明的「一条永远绿的自检」。
④-ANCHOR 那行注释的**散文部分**已译，en 模板必须逐字用：
`<!-- ④-ANCHOR insert concept chapters before this line ⟨待填⟩ -->`
（`SKILL.en.md:397` 与 `references/layout.en.md:518` 拿它当 `oldText`，对不上 `edit` 会报错）。

**H2 的标定常数**：`layout.md` / `layout.en.md` 的自检 H2 把**对模板散文注释的计数断言写死在注释里**，
四个数对当前 `assets/report-template.html` 实测全部精确命中：

| grep | 命中数 | 文中写法 | 命中位置 |
|---|---:|---|---|
| `src="http\|@import\|url(http\|…` | **4** | 「模板自带 4 处」/ "comes with 4 matches" | 模板 **L44/45/46/50**，全是中文散文注释 |
| `^<script>` | **1** | 「这个数正好 1」/ "exactly 1" | 文末唯一脚本块 |
| `<script`（任意位置） | **12** | 「十来处」/ "a dozen" | 硬约束注释 + `<style>` 内 + 脚本内 |
| `fill="#\|stroke="#\|color: *#\|background: *#` | **13** | 「十来处」/ "a dozen or so" | `<style>` 的 `@media print` |

**这是第三条跨批次契约。** 那 4 处命中来自模板 L44/45/46/50 的中文散文，正是下一批要翻的：

```
44:  2. 不引任何外部资源：没有 CDN、没有 <link rel=stylesheet>、没有 @import、
45:     没有网络字体、没有 <img src="http…">、CSS 里没有指向网络的 url()、
46:     脚本里没有 fetch/XHR/WebSocket（CSP 会拦，但也别写这种一眼假的代码）。
50:     不是资源，允许；把它当资源加载（img/link/@import）不允许。
```

翻这四行时**字面形态必须保持能被同一条 grep 命中**（`<img src="http…">` 不能改写成
`an <img> pointing at http`，`@import` / `fetch` / `XMLHttpRequest` / `WebSocket` 等词不能拆开或复述）。
命中数从 4 变 3，H2 注释里「模板自带 4 处，都不是违规」就成了错的标定 → 漏判或误判。
与 `⟨待填⟩` 同类：**改模板会让 `layout.*.md` 里的常数失效，而失效不报错。**
真要改动那几行，就得同时改 `layout.md:879` 与 `layout.en.md:879` 的数字。

**learning-deck 的 description**：中文 381 字符、英文 986（余量 38），是六个 skill 里最紧的一份。
直译约 1300，超 1024 会让它在 en 树里静默降级成禁用行。压缩只动叙述句：
**九条触发场景一条未删、词形全保**，与 `/paper-summary` 的消歧整句保留；
删掉的是「先问清起点再决定讲什么」——它与同一句开头的
「Three interview rounds find which layer the user already stands on … fill in only the missing layers」
表达的是同一件事，属于中文版内部的复述，去掉不损失任何触发面或行为约束。

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
   当前余量（2026-08-27 实测）：

   | skill | 中文 | 英文 | 余量 |
   |---|---:|---:|---:|
   | `learning-deck` | 381 | 986 | **38** ← 最紧 |
   | `literature-review` | 278 | 980 | 44 |
   | `fact-check` | 253 | 929 | 95 |
   | `research-frontier` | 260 | 929 | 95 |
   | `paper-summary` | 253 | 895 | 129 |
   | `research-ideation` | 227 | 770 | 254 |

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
