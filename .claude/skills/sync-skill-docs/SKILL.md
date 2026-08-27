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
   | `literature-review` | 278 | 980 | **44** ← 最紧 |
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
