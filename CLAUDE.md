# KyDog — Agent guidance

面向科研工作流的 AI 智能体桌面应用（Electron + pi coding-agent SDK）。

## Principles

判定必须基于协议层事实，不靠启发式 proxy（时间窗 / 阈值 / 近似 / 聚类等）；当下游发现需要 proxy 才能得出结论时，意味着上游某处把信号丢了 —— 回到源头把信号正确保留下来，而不是在下游补救。

## 改动前先读

- **跨进程的东西**（加 RPC 方法、加事件 topic、改渲染层与主进程的往返）→ `docs/architecture.md`
- **LLM provider / model** → `docs/llm-architecture.md`。写 `settings.llm.*` 必须配合它 §5 的传播调用，漏了不报错、只在运行时静默用错
- **写或改 e2e** → `docs/e2e-guide.md`：先判断是不是非 e2e 不可、一个功能区一次启动、开发机与 CI 的环境差、判据怎么写
- **pi coding-agent SDK 用法** → 官方完整文档在 `node_modules/@earendil-works/pi-coding-agent/docs/`，示例在同包 `examples/sdk/`。别凭记忆猜 API（干净 checkout 需先 `npm install`）

## Commands

验证类（gate 命令，可随时跑）：

- `npx tsc --noEmit` — 类型检查
- `npm test` — vitest 全跑；`npm test -- <pattern>` 过滤（e.g. `log.test` / `cwdHash` / `atomicWrite` / `persist`）
- `npm run lint` — ESLint 9 flat config

E2E（Playwright + Electron，需要先打包）：

- `npm run package` — `electron-forge package`，**每次 e2e 前必跑一次**（Playwright `_electron.launch` 需要构建后的 main.js）
- `npm run e2e` — Playwright 全跑；`npm run e2e -- 00-shell 01-first-run-settings` 过滤
- `npx playwright install chromium` — 一次性，幂等

其他：

- `npm install` — 可以自己跑。但**往 `package.json` 加新依赖前先跟用户 review**
- `npm start` — 开窗口，需要桌面 UI，**不要在 agent 上下文里跑**
- `npm run cli:update` — 检查上游 CLI 新版本 + 同步其 skill 到 `src/skills/`，逐项 `[y/N]` 确认（交互式）
- `npm run cli:update fastpaper@0.2.1` — 钉到指定版本（可回退），skill 跟着走同一个 tag；用位置参数，别写 `--tool`（npm 会吞掉它）

## 发版流程：同一提交演练 → tag CI → Release 草稿 → 用户手动发布

- **发版任务要跟进到草稿交付**：用户要求“推送 GitHub 并 tag 某版本”时，默认包含下述完整流程；只推送 `main` 或只推送 tag，不能当作发版任务完成。用户明确只要求其中一步时，按该范围执行。
- **本地和 CI 共用项目的 Node 版本**：以 `.nvmrc` 为统一来源（目前 24），CI 的 `setup-node` 也从它读取。版本选择须结合本机开发环境、Electron 内置 Node 和依赖支持范围；不把旧 CI 配置当成必须迁就的标准。升级时一起改、一起验证。
- **主动维护 CI 操作系统镜像**：采用受支持的新稳定 runner，并结合本机开发系统评估升级（目前为 `macos-26`、`macos-26-intel`、`windows-latest`）。旧镜像不能未经用户确认就被当成必须保留的兼容基线；需要覆盖旧系统时，单独明确兼容目标和矩阵成本。Node 与操作系统分别评估，修改运行时后完整演练三平台。
- **本地预检只负责提前发现本机可复现的问题**：用上述 Node 运行类型检查、lint 和全量单测；另设 `CI=1`、`KYDOG_REQUIRE_SYMLINK=1` 并用 `--max-old-space-size=2048` 做资源回归检查。2 GB 是额外压力条件，不是假装 macOS 能模拟 Windows/Intel。不要临时加大堆、放宽 timeout 或减少测试来制造绿灯；另外两个平台仍必须由真实 runner 验证。
- **先定候选提交，再跑三平台**：把版本号等全部改完并提交，记录完整 SHA，推送候选分支，然后 `gh workflow run release.yml --ref <候选分支>`。核对该次 run 的 `headSha` **等于候选 SHA**，三个 build 矩阵项全部 `success`；不能拿另一个提交、旧版本或只过部分平台的结果代替。
- **三平台全绿才可创建和推送 tag**：tag 必须指向上述已验证 SHA，且去掉 `v` 后与该提交的 `package.json` 版本一致。任何平台失败、取消、跳过或尚未完成，都不能继续打 tag；说明失败原因并先修复。用户没有明确要求绕过时，不得自行以“先推标签、之后再修”处理。
- **tag 后仍要跑正式发版 CI**：推送 tag 触发 `.github/workflows/release.yml`；继续跟进这一轮 tag push run，核对 `headSha` 与 tag 指向的提交一致，三个 build 和 release job 全部成功。打 tag 前的手动演练是额外门槛，不能替代 tag 后的这一轮 CI；`workflow_dispatch` 本身不会生成 Release。
- **CI 成功后交付 Release 草稿**：工作流以 `draft: true` 创建 GitHub Release 并上传三平台安装包及 `SHA256SUMS.txt`。Agent 核对实际草稿与资产，结合上一版本以来的实际改动整理发布说明，再把草稿链接、正式 CI 链接、tag/SHA 和已知问题交给用户查看。发现重试转绿等情况要如实说明；CI 失败或没有草稿时不能声称已交付。
- **公开发布由用户手动完成**：保持 Release 为 draft，由用户访问 GitHub 检查 CI、发布说明和安装包后手动 Publish。除非用户另行明确要求，Agent 不自动发布、不把草稿改为公开版本。
- **提交变了就重新演练**：演练后修改任何代码、配置、依赖或版本号，都会产生新的候选 SHA，旧绿灯不再放行。发版记录在 `.superpowers/` 留候选 SHA、run URL、三个矩阵结果和本地预检命令。
- **不要移动已推送的 tag 来补发修复**：保留失败现场，先完成修复与演练，再按用户指定的新版本发版。重跑只用于已证实的外部基础设施抖动，不能用反复重跑掩盖产品或测试问题。

## Windows 上跑测试：先开一次「开发者模式」

有一批用例要**真的建符号链接**（考的是软链能不能越出目录、写入会不会穿透链接）。Windows 建符号链接需要 `SeCreateSymbolicLinkPrivilege`，普通用户默认没有，`fs.symlink` 直接抛 `EPERM`。

**设置 → 系统 → 开发者选项 → 开发者模式**，打开即可。这是一次性开关，开完普通用户就一直有这项特权，**不需要每次开管理员窗口**。开之前可以先确认现状：

```bash
node -e "const f=require('fs'),o=require('os'),p=require('path');const d=f.mkdtempSync(p.join(o.tmpdir(),'c-'));f.writeFileSync(p.join(d,'t'),'x');try{f.symlinkSync(p.join(d,'t'),p.join(d,'l'));console.log('OK')}catch(e){console.log('UNAVAILABLE',e.code)}finally{f.rmSync(d,{recursive:true,force:true})}"
```

没开也**不会红**：`src/test-support/symlinkCapability.ts` 会探针式判定，建不了就 `skipIf` 跳过（跳过原因带在用例上，不是静默的）。代价是那批安全用例本机没跑到——所以别把「本机绿」当成「这块没问题」。

CI 里靠 `KYDOG_REQUIRE_SYMLINK=1` 反过来**禁止跳过**：能力缺失就让它以 EPERM 红出来，免得覆盖在发版流水线上悄悄消失。目前钉在两个 macOS 矩阵项上（见 `.github/workflows/release.yml`）。

## Orca 工作树与本地记录

- **工作树管理**：主要通过 Orca 开发。涉及工作树创建、状态与删除时使用 `orca-cli` skill，通过 Orca 管理；已有工作树直接使用，不再另建嵌套工作树。路径由 Orca 决定，不要求 `.codex/worktrees/<主题>/`，不要绕过 Orca 用裸 Git 创建或删除其管理的工作树。
- **本地记录位置**：设计 spec 放 `docs/superpowers/specs/`，实施 plan 放 `docs/superpowers/plans/`，不要放 `docs/scratch/` 或其他目录；任务过程、审查、验证报告和证据放 `.superpowers/` 下按任务命名的目录。这两个目录都只在本地保存，不进 Git；创建后用 `git check-ignore -v <路径>` 确认被忽略，不要提交。各工作树独立保存，不依赖 Orca 的工作树共享路径自动同步或归档。
- **收尾必须归档**：执行 `finishing-a-development-branch` 的本地合并、验证完成后，须将本次工作树的 `docs/superpowers/` 和 `.superpowers/` 归档到主工作区的对应目录，再报告收尾完成；即使按 skill 的宿主环境规则保留 Orca 工作树，也必须归档。以后删除或放弃工作树前须再次核对并归档新增或变更记录，除非用户明确要求丢弃这些记录；丢弃分支或代码不等于丢弃本地记录。
- **归档方法与判据**：通过 `git worktree list --porcelain` 确认本地 `main` 所在主工作区，不硬编码路径；无法确认时停止清理并说明。复制前解析符号链接，源与目标为同一实际目录时无需复制；否则按相对路径合并：缺失文件复制、内容相同跳过、同名不同内容保留两份并用任务名等标明来源，禁止覆盖已有记录。复制后逐文件校验内容一致（如 SHA-256），确认目标仍被 Git 忽略，并报告归档位置与数量；验证完成前保留源记录。
- **归档后再清理**：清理前直接检查上述两个目录，`git status` 干净不能证明被忽略的记录已归档。归档完成不等于获准删除工作树；清理仍按用户授权通过 Orca 完成。删除失败时先核对 Orca 记录、Git 工作树注册和磁盘目录，不用强制删除、手工解除注册或清空目录掩盖失败。

## 约定

- **不要引入危险色**。设计系统里没有红色 token，破坏性操作走统一的 `confirm()` 对话框，不靠颜色警示。
- **往 `vite.main.config.ts` 的 `external` 加包** → 同步 `forge.config.ts` 的 `EXTERNAL_RUNTIME_MODULES`。external 的包不进 bundle，只以裸名留在产物里，运行时按 Node 规则找 `node_modules`；打包成品里没有它就是 `ERR_MODULE_NOT_FOUND`。**开发机上看不出来**：`out/` 在仓库内，解析会一路上溯摸到 `<repo>/node_modules`，借开发树的货照样跑。守这条的是 `e2e/54-packaged-smoke` 的断言 2b（它把成品复制到仓库外再启动），而 e2e 要先 `npm run package`，只跑 gate 命令发现不了。
- **改了 `src/shared/zhSidecar.ts` 的 `BLOCK_KINDS` / `PLACEHOLDER_KINDS` / `PLACEHOLDER_SCRIPTS`** → 同步 `src/main/harness/templates/{zh,en}/AGENTS.md` 里那份契约（bullet 列表与「只认这 N 个值」的数目）。模板是 agent 写译文边车时唯一读得到的说明，一个不认识的值会让**整份文件**被拒。守这条的是 `templates.test.ts`（集合相等，两个方向都守）。
- **改了 `src/main/browser/injected/walker.js` 的输出结构** → 同步 `src/main/browser/snapshot.ts` 的 `AxNode` 与 `renderDiff` 的判据，并跑 `npm test -- snapshot`。walker 在网页里执行、类型系统管不到它，两边漂移不会编译报错，只会让 diff 静默退化成全量。它是 `.js` 不是 `.ts`：整份源码被 `?raw` 原样注入浏览器。
- **改了 `src/main/browser/injected/interact.js` 的 `measure`（含它那唯一一处 `scrollIntoView` 调用）、`e2e/61-browser.spec.ts` 里那个夹具（`bar` 的 `top`、密码框的 DOM 层级、那个撑高块）、`e2e/helpers.ts` 的窗口尺寸、`src/main/browser/browserService.ts` 的 `DEFAULT_VIEWPORT_HEIGHT`、或把密码闸挪出 `browserService.ts` 的 `assertTypeAllowed`**（前四个是同一件事：那条 e2e 判据靠的滚动行为与几何；第五个换的是被测的那道闸本身）→ 回来重做 `e2e/61-browser.spec.ts` 那条「走真的 type…整批在碰页面之前就被挡下」。**这条约定挡的是一次静默失效，不只是「记得同步」**：它的失败形态实测是**静默** —— 把密码闸挪到 `measure` 之外、`interact` 之前（「反正要拒，何必先为它滚一次页面」这个优化），`npx tsc --noEmit` exit 0、这一组 **10 passed 一条不红**，而 docblock 里「第一道闸在 `dispatch` 调 `interact` 之前」指的那一行已经不在了。（挪**进** `measure` 内部则相反：实测**当场红**在 `probeMeasure.ok`、`reason=password`。）这条用例区分密码框上两道**措辞逐字相同**的闸，靠两条判据：**2a** 数「这一轮 `measure` 被调了几次」（记号是隔离世界里 `Element.prototype.scrollIntoView` 上的透传计数器 —— `measure` 是 `interact.js` 里**唯一**调它的地方，`walker.js` 一次都不调；挪走这处调用、或者多出第二处，这个数就不再是「`measure` 调了几次」）；**2b** 断 `scrollY === 0`，它是同一件事的残迹 —— 残迹抹得掉（在抛错前顺手 `window.scrollTo(0, 0)` 就够），所以 2b 不能单独用。另有两条断言钉着 2b 的几何前提：探针 `pwScrollsWindow`（按**快照那一行的序号**取 `nodeId`、调**生产源码** `interact.js` 的 `{op:'measure'}` 真滚一次再滚回来）与非密码对照动作（断 `scrollY > 0`），别把它们当成多余的删掉。注意前提**不是**「密码框在首屏之外」（那是充分不必要条件：`scrollIntoView({block:'center'})` 对首屏内的元素照样滚）。几何与滚动那四项改完会**当场红**（实测），但**只红在 e2e 上** —— `npm test` 与其余 gate 命令一条都看不见；而挪闸那一项连 e2e 都不红，只能靠这条约定把人叫回来。
- **改了 `src/skills/` 的内容**（新增、删除、改 SKILL.md / references / assets）→ 跑 `sync-skill-docs` 审核中英文一致性。`builtinSkillsI18n.test.ts` 只校验双语文件**存在**，校验不了内容有没有同步；放弃 sha 账本之后，这套审核是内容一致性的唯一保障。
- **上层任务 skill 里不写源名与源能力**（`research-frontier` / `literature-review` / `research-ideation` / `fact-check` / `learning-deck`）。源清单、flag 支持、query 语法、限速只在 `src/skills/{fastpaper,slowpaper}/`，路由表只在 `src/main/harness/templates/{zh,en}/AGENTS.md` 的「找论文」一节；上层只写这一步要**哪一类**文献，和本工作流实测出来、影响产物质量的裁决。失败形态是**静默过期**：上游删一个源（0.9.0 删 biorxiv / medrxiv 那次），抄在上层的那份全错，而任何测试都不会红。守这条的是 `sync-skill-docs` 的 Pass C，那里有现成的 grep 和「什么该留」。
- **改了 `src/skills/slowpaper/references/` 里的选择器** → 必须来自一次真实抓取，不许凭记忆写。跑不通的选择器不会报错，只会让 agent 拿到空结果并以为这个源没有这篇论文。
- **写否定型断言**（断「某个东西不在」：`toBeNull` / `toHaveLength(0)` / `not.toContain` / 「祖先链上没有 X」）→ 同一条用例里要先证明「换个条件时它在」，不能靠分成两条、隔壁一条反向对照兜底。失败形态是**假绿**：查找本身坏了（比如 testid 被改名）时，谎话挂在正向那条上，红的是隔壁那条，排查的人第一眼看错地方。
- **写完一条断言** → 把夹具里没被这条断言直接点名的每个相关字段翻一遍面，问一句「翻成另一个值这条还成立吗」。失败形态是**假绿**：断言为真只是因为夹具里某个没人提到的字段恰好撞对了值（默认值撞 mock 值、首项自动激活、活动标签恰好是数组最后一个……），逻辑本身错了也照样绿——这个形态在 `2026-09-10-browser-sidebar-ui` 那份计划的终评里九次假绿占了五次，是最高产的一种。
- **改 `src/shared/userTurn.ts` 的语法** → 只许加新写法、不许改或删已有写法。历史里的用户消息是按当时的语法写进 pi 会话文件的，新语法解不出来就整条显示成带标签的原文，不报错、不红 —— 只会在别人的旧对话里露出来。守这条的是 `userTurn.test.ts` 的「冻结样本」用例：它红了就是要回头的信号，别改样本去迁就新语法。
