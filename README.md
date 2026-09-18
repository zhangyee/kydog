<p align="center">
  <img src="assets/kydog-mascot.svg" width="120" alt="KyDog">
</p>

<h1 align="center">KyDog 科研狗</h1>

<p align="center">—— 面向科研工作流的 AI 智能体桌面应用</p>

<p align="center">
  <a href="https://github.com/zhangyee/kydog/stargazers"><img src="https://img.shields.io/github/stars/zhangyee/kydog?style=flat&color=e4b363" alt="Stars"></a>
  <a href="https://github.com/zhangyee/kydog/releases"><img src="https://img.shields.io/github/v/release/zhangyee/kydog?display_name=tag" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="Platform">
</p>

<p align="center">
  <b>中文</b> · <a href="README.en.md">English</a>
</p>

---

## 演示

![KyDog 科研智能体示例：调用 skill 完成文献研究](docs/images/kydog-demo.webp)

## KyDog 是什么

在 Codex、Claude Code 等编程智能体里接入文献 MCP 可以查文献，但编程智能体的对话与工具调用是围绕代码生成设计的，以产出结果为导向，不适合边读文献边验证想法。科研工作的主体是检索、精读、核对与写作。KyDog 是我根据自己日常科研的需求，按这类工作重新设计的 harness 与智能体外壳。

KyDog 的文献检索由两个工具承担：fastpaper 通过 API 访问学术数据库，slowpaper 在应用内置浏览器中访问没有 API 的源。在此之上，KyDog 提供覆盖研究、学习、写作、评审四个阶段的工作流 skill，以斜杠命令调用。skill 检索时跨源并行、沿引用链追溯，引用的论文逐篇回源核验，并下载到项目的 `papers/` 目录。产出的报告是 Markdown 文件，和论文 PDF 一样可以在应用内阅读和编辑。

KyDog 参考 Openclaw 的工作区设计，用三个文件组成系统提示词：`AGENTS.md` 规定工作方式，`SOUL.md` 规定人格与语气，`USER.md` 记录用户的身份与研究方向。智能体靠这三个文件在不同会话之间保留这些信息。三个文件都可以直接编辑，你可以通过修改它们，自定义出自己独特的科研助手。

## KyDog 能干什么？

- **fastpaper：通过 API 访问的源** —— 随应用打包的命令行工具，可以检索、查询元数据、追溯引用关系、下载 PDF。目前支持 23 个源：arXiv、PubMed、PMC、Europe PMC、bioRxiv、medRxiv、OSF Preprints、Semantic Scholar、OpenAlex、Crossref、DataCite、DBLP、CORE、OpenAIRE、DOAJ、HAL、Zenodo、Unpaywall、INSPIRE-HEP、zbMATH Open、ERIC、OSTI.GOV、NASA NTRS<sup>[注 1]</sup>。
- **slowpaper：通过内置浏览器访问的源** —— 智能体在应用内置浏览器中操作，访问没有 API 的源。目前支持 2 个学术搜索引擎（Google Scholar、百度学术）和 9 个开放获取全文源（MDPI、Frontiers、PeerJ、ChemRxiv、SSRN、AGRIS、PubScholar、ChinaXiv、国家哲学社会科学文献中心）。遇到验证码时，由用户在浏览器侧栏中完成验证。两个工具的源清单与各源能力见[文献源说明](docs/literature-sources.md)。
- **引文可核验，用 harness 约束 LLM 幻觉** —— 编造文献、错误归因，是研究者对 LLM 用于文献检索与论文写作最大的顾虑。KyDog 在 harness 层约束这一点：写入报告的 DOI 都经过回源确认，论断标注原文出处，无法确认的内容不写入。
- **研究工作流 skill** —— 覆盖研究、学习、写作、评审四个阶段，以斜杠命令调用。
- **主流大模型接入全覆盖** —— 20 个内置 LLM provider，以及任意 OpenAI 兼容端点（本地 Ollama / vLLM / 自有代理）。Claude Pro/Max 与 ChatGPT (Codex)、GitHub Copilot 订阅登录；Anthropic、OpenAI、DeepSeek、Google Gemini、OpenRouter、Mistral、Groq、Cerebras、xAI、ZAI、Kimi、MiniMax 等 API Key 接入；Azure OpenAI、Amazon Bedrock、Google Vertex AI 云接入。
- **PDF 与 Markdown 就地读写** —— 内置 PDF 阅读器和所见即所得 Markdown 编辑器，不用在不同应用程序之间来回切换。
- **本地优先** —— 项目就是你自己磁盘上的一个目录，检索到的论文和产出的报告都写在那里；会话与设置存在 `~/.kydog/`，凭据文件权限强制 `0600`。无需注册账号；KyDog 不收集你的文件与对话（对话内容会发送给你配置的模型服务商）。

> **[注 1]** Google Scholar、百度学术因平台收紧 API 访问，自 v0.3.1 起从 fastpaper 的来源列表中移除，现在改由 slowpaper 在内置浏览器里访问（见上面 slowpaper 那一条）。

## 内置 skill

KyDog 的 skill 按研究工作流的四个阶段组织：

```
research 选题与研究  →  study 科研自学  →  write 论文写作辅助  →  review 评审自查与核验
```

### 所有产物共享的一件事：引文经得起查

每个 skill 的指令里都写有以下四条规则：

- **标识符必须回源确认。** 写入产物的 DOI、arXiv id、PMID 都要在源数据库中确认存在，无法确认的条目不写入。
- **论断标注出处。** 数值、效应量与结论方向都定位到原文章节；无法核对原文的证据不写入；文献结论与模型推断分开标注。
- **标注核验层级。** 附录按「已读全文 / 仅读摘要 / 未获取」三档列出文献，没完成的核验步骤如实注明。
- **论文下载到本地。** 产物引用的论文 PDF 保存在项目的 `papers/` 目录，可以逐篇对照原文。

### Research：选题与研究现状

| 命令 | 用途 | 做法 | 产物 |
|---|---|---|---|
| `/research-ideation` | 科研选题：评估一个研究想法是否值得做、是否已有人做过 | 按 Heilmeier 九问逐题梳理选题（DARPA 前局长 George Heilmeier 提出的研究项目评估问题：不用任何专业术语说清要做什么、现有做法及其局限、新意何在及为何能成、谁在乎、成功后带来什么改变、风险、成本、周期、如何检验成功）；检索文献并归入六类（已确立的发现、争议性发现、否定结论的发现、机制、方法论、最接近的相关研究），逐篇回源核验 | 评估报告 —— 值得做 / 需要收窄 / 建议换方向，附一批延伸选题 + `papers/` 里的 PDF |
| `/literature-review` | 论文综述：梳理一个方向的研究现状 | 多轮、多关键词、跨源检索；先找综述再沿引用链反查经典；分清奠基工作、主流路线、共识与争议、最新进展，并说明与已有综述的差异 | 一份 Markdown：前半是可直接用于论文的「研究现状 / Related Work」（作者年份引用 + 参考文献列表），后半是检索漏斗、文献图谱与核验报告 |
| `/research-frontier` | 前沿进展：了解一个方向近一年的进展 | 限定近一年文献，分析主要研究团队、研究路线的演变、受到挑战的既有假设、新术语与尚存争议 | 1500–2500 字简报，面向本领域研究者，不含背景介绍，每条判断标注文献出处 |

### Study：概念与方法自学

| 命令 | 用途 | 做法 | 产物 |
|---|---|---|---|
| `/learning-deck` | 自学报告：学习一个陌生的概念或方法 | 三轮访谈确定用户缺少哪些前置概念，只讲解缺少的部分；检索综述、教程与奠基论文；插图优先用原文插图，取不到时按原文重绘为 SVG（数据图不重绘），每张图注明来源 | 可离线打开的 HTML 自学报告 —— 知识地图、每个知识点一节（定义 → 解决什么问题 → 机制图 → 常见误解与边界 → 出处）、方法对比表、术语对照、精读清单 |

### Write：论文写作辅助

| 命令 | 用途 | 做法 | 产物 |
|---|---|---|---|
| `/paper-summary` | 论文总结：把一篇论文写进自己的论文 | 先确认用途（写入相关工作、与之对比、借鉴或复现方法、以其局限论证自身工作的必要性），按用途生成文字 | 在对话中给出段落，不生成文件 |

### Review：评审与核验

| 命令 | 用途 | 做法 | 产物 |
|---|---|---|---|
| `/peer-review` | 评审自查：投稿前找出审稿人可能提出的问题 | 模拟一轮评审：先做整体判断（逐环检查论证链，检索最接近的前人工作来评估贡献与新意），方向性问题先和用户讨论；再逐条给出意见，处置（改 / 挂起 / 拒绝）由用户确认；也可以输入收到的真实审稿意见 | 修改方案报告 —— 全局判断 + 逐条评审意见（严重度、处置、位置与「改成什么」）+ 引用文献，全部回源核验 |
| `/peer-review-response` | 同行评审：受邀审稿时撰写经得起作者核对的正式意见 | 先客观概括稿件内容，再做整体判断和逐条意见，每条意见包含位置、问题、重要性与修改建议；「已有人做过 / 漏引 / 引文不支持」这类文献判断都经检索回源后才写；没有问题的项目写明「未发现」 | 可直接提交的评审报告 —— 总体判断、Major / Minor、未能评估项、本评审的局限、评审引用的文献 |
| `/fact-check` | 论据核验：判断一个说法是否有证据支持 | 先把断言拆成可判定的子命题并与用户确认拆法；同时检索支持与反对的证据；按研究设计和样本分层评估证据强度，**不看期刊名气**；每篇作为证据的论文都检查是否被撤稿（限 PubMed / PMC 覆盖的领域，覆盖不到的如实写明没查） | 五档判定（成立 / 有条件成立 / 证据不足 / 有反证 / 不成立）及其成立条件，附 800–1200 字核查报告 |

## 安装

到 [Releases](https://github.com/zhangyee/kydog/releases) 下载对应平台的安装包。目前提供 macOS（Apple Silicon / Intel）与 Windows x64。

### macOS 首次启动

MVP 阶段还没有 Apple 签名与公证，Gatekeeper 会拦下第一次启动：

1. 系统设置 → 隐私与安全性
2. 拉到底部，在「已阻止 KyDog」处点 **仍要打开**

如果仍打不开（macOS 15.1+ 偶发），在终端跑一次：

```bash
xattr -d com.apple.quarantine /Applications/KyDog.app
```

### Windows 首次启动

1. 双击 `.exe`，SmartScreen 会警告 → 点 **更多信息** → **仍要运行**
2. KyDog 的 shell 工具依赖 [Git for Windows](https://git-scm.com/download/win)。没装的话首次启动会提示，装完重启 KyDog 即可
3. 手动安装新版之前，先完全退出 KyDog。安装卡在解压画面、关掉重装也不行，或者装好后打不开，见 [Windows 安装排错](docs/windows-install-troubleshooting.md)

### 从源码构建

需要 Node.js ≥ 22.12：

```bash
git clone https://github.com/zhangyee/kydog.git
cd kydog
npm install
npm start
```

更多开发相关内容见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## TODO 计划

以下功能在开发计划中：

- [ ] **补齐 skill** —— 沿「研究 — 学习 — 写作 — 评审」往后做。目前研究阶段有三个、学习阶段一个、写作阶段一个、评审阶段三个。
- [x] ~~**PDF 标注** —— 划线批注，中文翻译与双语对照阅读。~~
- [ ] **文档追问与引文评述** —— 在 Markdown 编辑器里就地对选中段落追问，并对它引用的文献给出评述。
- [x] ~~**slowpaper：in-app browsing** —— 让智能体在应用内操作浏览器，接入更多必须经浏览器才能访问的学术文献源。~~
- [ ] **CARSI 登录** —— 用学校账号经 CARSI（中国教育和科研计算机网联邦认证服务）自动登录，访问学校订阅的文献库。
- [ ] **LaTeX 编辑器** —— 类似 Overleaf 的编辑与编译体验。

具体功能需求和使用反馈，欢迎在 [Issues](https://github.com/zhangyee/kydog/issues) 里提。也欢迎你[赞助支持本项目](#支持这个项目)，加速以上功能的实现。

## 致谢

KyDog 站在这些项目的肩膀上。

**架构核心**

- **[Pi](https://github.com/earendil-works/pi)** — Mario Zechner。KyDog 的 agent loop 直接构建在 `pi-coding-agent` 之上：LLM provider 接入与凭据管理、模型目录、工具注册与执行、上下文管理、会话持久化，这一整层都由它承担。KyDog 在它之上只加了自己的工具（向用户提问、操作内置浏览器、读 PDF 插图、直读 Word 文档）、skill 的加载与语言投影，以及桌面端的事件回流。
- **[Electron](https://github.com/electron/electron)** — 桌面外壳。主进程跑 Node，负责 agent 会话、文件读写与 CLI 调用；渲染进程跑 Chromium，负责界面、PDF 阅读器与 Markdown 编辑器；两者只经 `src/shared/protocol.ts` 收口的 RPC 与事件通信。跨平台打包走 electron-forge，自动更新走 Electron 的 `autoUpdater` 与 update.electronjs.org。

**灵感来源**

- **[Openclaw](https://github.com/openclaw/openclaw)** — Peter Steinberger。它把智能体配置写成工作区目录下的 Markdown 文件，可以直接阅读、编辑和纳入版本管理。KyDog 取了其中三份 —— `SOUL.md` 定人格与语气、`AGENTS.md` 定工作方式与流程、`USER.md` 记「你是谁、在研究什么」—— 用来组装系统提示词，用户也因此可以直接改文件来定制自己的助手。
- **[Open Scholar Skill](https://github.com/joshzyj/open-scholar-skill)** — 张勇军教授。面向社会科学顶刊写作的 Claude Code skill 套件，35 个 skill 把选题、文献综述、假设、研究设计、分析、写作、投稿到回应审稿意见这一整条链路逐段拆开，并在关键节点强制人工确认。KyDog 研究类 skill 的拆分粒度，以及先确认再执行的做法，受它启发；评审 skill 的意见分诊（先给处置，经用户确认再修改）和返修时不扩大修改范围的规则，来自它的 scholar-respond。
- **[Academic Research Skills for Claude Code](https://github.com/Imbad0202/academic-research-skills)** — Edward Cheng-I Wu。四个 skill 组成 research → write → review → revise → finalize 的管线，每个阶段都留人工决策点而不追求全自动，并把引用核验、论断与出处对齐做成独立的审计环节。KyDog 的四阶段划分，以及「引文必须回源核验」这条硬约束，都在这里得到过印证。
- **[Claude Academic Research](https://github.com/mronkko/claude-academic-research)** — Mikko Rönkkö。它的 critic-loop 把「改稿改到什么时候算完」建立在可核对的账面事实上：每条意见必须有去向，拒绝一条 Major 只有「可验证的反驳」或「作者明示出界」两条路。KyDog 评审 skill 的处置纪律直接来自这里。
- **[Research Skills](https://github.com/neuromechanist/research-skills)** — Seyed Yahya Shirazi。它的 paper-review 要求每条评审意见包含位置、问题、重要性、建议与依据五项，并给出明确的严重度判据。KyDog 评审 skill 的意见结构与严重度分级采用了这套做法。
## 参与贡献

KyDog 由一个人开发和维护，非常需要来自真实科研场景的反馈。

- **提需求、报问题** → [Issues](https://github.com/zhangyee/kydog/issues)。尤其欢迎具体的反馈，比如某个 skill 在你的领域里效果不好。
- **提交代码** → 开发环境、目录结构、验证命令与约定都在 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证与隐私

本项目以 [GPL-3.0-or-later](LICENSE) 授权。

KyDog 默认参与匿名使用统计（一个随机安装标识 + 应用版本 / 操作系统 / CPU 架构，每天至多一次），**不发送**文件内容、对话内容、项目路径、文件名或任何个人信息。首次设置的最后一页可以取消，之后随时能在「设置 → 关于 → 隐私与统计」里关掉并删除已有数据。完整说明见 [src/about/privacy.md](src/about/privacy.md)，服务端代码开源可核验：[kydog-telemetry](https://github.com/zhangyee/kydog-telemetry)。

## 支持这个项目

如果 KyDog 帮你省下了时间，或者你认可它的目标与方向，欢迎给个 star。也欢迎赞助本项目的开发，你的鼓励与支持，是它继续做下去的全部理由。

<!-- 不放 star 趋势图：GitHub 于 2026-06-30 起把 stargazers API 限制为仓库自己的
     admin/collaborator，第三方服务要画历史曲线就得拿到一个带 contents write 的
     token（GitHub 用写权限判定 collaborator，只读会被拒），不值得。顶部徽章给
     的是当前星数，够用。等有不需要交出写权限的方案再考虑加回来。 -->

<img src="src/renderer/assets/sponsor.jpg" alt="微信赞赏码" width="180">

<sub>微信扫码赞助</sub>
