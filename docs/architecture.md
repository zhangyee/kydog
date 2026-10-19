# 数据流骨架

主进程与渲染进程之间只有两条链，两条都在 `src/shared/protocol.ts` 收口——`RpcCall` 联合列出全部 RPC 方法及其 args/result，`RuntimeEvent` 联合列出全部广播事件及其 payload。**加或改任何跨进程的东西，都从这个文件开始。**

## RPC 请求（渲染 → 主）

```
组件 → window.kydog.invoke(method, args) → preload → RPC_CHANNEL
     → dispatcher → handlers[method] → service
```

发起方是**组件**，不是 store。以发送消息为例：`Composer.onSend` 先把用户消息乐观写进 store，再 `await window.kydog.invoke('thread.send', …)`；两件事先后独立，store 不参与调用。

> renderer store 原则上只保存状态、不直接调用 bridge。`llmStore.refresh()` 是当前已知偏离。

主进程侧 `registerHandler(method, fn)` 注册，`installDispatcher()` 把 `RPC_CHANNEL` 挂到 `ipcMain.handle`。**异常不跨进程抛**：dispatcher 捕获后返回 `{ ok: false, error }`，preload 再还原成带 `code` 的 `Error` 抛给调用方。

## 事件回流（主 → 渲染）

```
service → broadcaster.emit(topic, payload) → EVENT_CHANNEL（广播给所有窗口）
        → preload 按 topic 过滤 → bootstrap.ts 的 setupEventBridge() → store → 组件
```

渲染层所有 `window.kydog.on(...)` 订阅集中在 `setupEventBridge()` 里，事件从那里落进对应 store。其中全部 `run.*` 汇到 `src/renderer/runEvents.ts` 的 `applyRunEvent()` 一个口子——下面的重放走的也是它。

## 在途 run 的复原（渲染进程重载）

渲染进程可以随时重载（Ctrl+R、菜单 View → Reload），主进程不受影响照跑。重载期间广播出去的 `run.*` 没有窗口接收，`bufferByMessage` 又随窗口一起没了——一组还在跑的工具就会永远停在「运行中」。

**不能靠重新归一化 pi 的 transcript 补救**：并行批次里 pi 要等整批 settle 才追加 toolResult（`agent-loop.js` 的 `executeToolCallsParallel`），而每个工具的 `tool_execution_end` 早在那之前就各自发过了。也就是说终态那一刻只存在于事件里，transcript 上根本没有。丢的是事件，能补回来的也只有事件。

所以 `AgentService` 给每一轮 run 留一份 **journal**（`Bound.runJournal`，`agent_start` 清空、`agent_end` 清空），所有 `run.*` 统一经 `emitRun()` 广播并记账。`thread.loadHistory` 因此带一个副作用：有 run 在飞时，先给发起调用的那个窗口发一帧 `run.resync`（意思是「把你手上关于这一轮的东西全扔了」），紧接着按序重放本轮 journal；返回的 `messages` 对应地**不含**这一轮的 in-flight turn，它由重放的事件在 buffer 里重建。

两个点值得记住：

- **重放为什么不放在 RPC 的 result 里**：那是另一条通道，跟事件流之间没有顺序保证。走 `EVENT_CHANNEL` 才能和后续实时事件严格先进先出——`ensureSession` 之后 `loadHistory` 全程同步，主进程又是单线程，所以「读 transcript、切历史、重放」之间插不进任何新事件，不重不漏，不需要序号对齐。
- **`run.tool_call_*` 三个事件都带 `messageId`**。主进程发它们时 `activeMessageId` 就在手上；不带就等于把归属丢掉，逼渲染层拿「最近的那个 buffer」去猜，而 buffer 集合为空时（刚重载）这个近似直接落空。

## 一处非直觉：ask 事件的来源不同

**只有 ask 的打开/关闭**（`run.ask_start` / `run.ask_end`）是 `askUserQuestionTool` 通过 shared callbacks 主动上行的。原因是只有工具知道 pending 何时真正就绪——校验参数、分配 id、向 broker 注册，这些都发生在 pi 的 `tool_execution_start` **之后**；照那个事件开 UI 会让非法参数也闪一下提问界面。

其余 `run.*` 事件都来自 `AgentService.subscribe()` 对 pi session 的订阅：`run.started` 来自 `agent_start`，两个 delta 来自 message 流，普通 `run.tool_call_*` 来自 `tool_execution_start` / `tool_execution_end`，`run.ended` 来自 `agent_end`。另有一个 `run.resync` 谁都不来自——它是上面那段重放的帧头，只在 `loadHistory` 里发给单个窗口，也不进 journal。

**X 研究的任务快照走另一条线，不在 `run.*` journal 里。** `xResearch.taskUpdated` 的载荷是任务快照（`XResearchTaskSnapshot`：状态、计数、逐行工作项），来源是主进程的 `XResearchTaskService`——队列与在飞状态在进程内存里，落盘在 `~/.kydog/x-research/<threadId>/<researchRunId>/`（`task.json` 是研究级索引、`submission-<id>.json` 是提交级工作项与实时状态；结果正文按工件格式单独落盘，提交记录只存 `artifact` 引用，交付时按那个引用读回来）。于是渲染进程重载时 `run.resync` 带不回它：开对话时 `thread.loadHistory` 那条路顺手拉一次 `xResearch.taskList` 补全整批，之后靠广播跟；卡片自己用 `xResearch.taskGet` 补齐它那几份。研究工作跑在 `run.ended` **之后**，卡也要跟着走——这两件事不能靠一条 journal 的时序。

**卡 = 回合，段 = 目标，轮 = 提交。** 三层各自有唯一的锚，不要混用：

- **卡**的单位是回合（R81b）。分组键是 `task.json` 里的 `runId`（创建这段研究的那个回合，`XResearchTaskRecord` / `XResearchTaskSnapshot` 上的同一个字段），旧记录没有它时退回 `researchRunId`——一段研究一张卡，不会空白。广播仍按研究发（`xResearch.taskUpdated` 一次一段），渲染层按分组键归并、每段只替换自己那一格；锚点也按回合算——一张卡落在「最后一次提到该回合任何一段研究」的那条消息上，后续不再提它的消息不会把卡拽走。
- **段**的单位是 objective（R83）。卡内把该回合所有研究的**提交**按 `createdAt` 串起来，**连续的同一个 objective 合成一段**，换目标才开新段；于是同一个目标横跨几段研究（取消后重开、接着做同一个问题）时仍是一段——现场那「三段残骸」其实就是三轮。段头 = 圈号 + 该段的终态（由 `xResearchRoundsState` 按这一段的**轮**算，与判定研究状态同一把尺子）+ 取消归因（R81a）+ objective；`N 段：…` 那句仍按研究数，数字仍是各研究权威计数的合计。
- **轮**的单位是提交。快照的 `rounds` 把每一份提交列成一项（`submissionId` / `operation` / `objective` / `state` / 取消归因），行在投影时**由拥有它的那份提交**盖上 `submissionId`（盘上旧提交文件没有这个字段，靠投影盖，不靠迁移）。段内按提交序画轮次头（`第 1 轮 · 5 个 query`、`第 2 轮 · 补搜 3 个 query` —— 操作与这一轮的行数都由它说，卡面不再分「搜索 / 读取」两节），行挂在自己那一轮的头下面。**三层靠两样东西分开**：缩进（段头 0 ＜ 轮次头 12px ＜ 行 24px）与字形（段头是 `1.` `2.`，行号是圈号 `①…`；行号在段内跨轮、跨操作连续，每段从 ① 起）。**被取消的那一轮留着**并带一个「已取消（谁停的）」章：取消停的是这一轮，不是整段研究（R83，`cancel` 之后同一段研究可以接着 `submit` 新一轮，被取消的那一轮永远是取消的）。
- 两组退路，判据都在数据里：没有 `rounds` 或行找不到自己那一轮（旧数据）→ 按研究分段、行平铺（与合并成一张卡之前一样，不会空白）；卡头副标题永远取**最早一段**研究的 objective（R10），合并与分段都不能让它换题。

取消按钮确认一次，然后逐个 `xResearch.taskCancel` 停下该回合里还在排队/进行中的每一段（RPC 仍按研究）。

**与 spec §4.4 的偏差（知情接受）：实时状态不按节流窗口落盘。** 盘上只在状态转移（提交、开跑、收尾、取消、交付标记）时更新，滚动数 / 帖数这类活计数只在内存里。于是进程被杀之后，`submission-*.json` 里的行会停在 `stopped` 且没有结论——卡对这类行只说「中断」，不报「收 0 帖」「无根帖」这种没人观测到的残缺计数。

其他非直觉点（为什么按 run 而不是按 pi message 合成 messageId、为什么并行判定要读 `message_end` 携带的 content）写在 `src/main/agent/AgentService.ts` 的注释里，改那块之前先读。

## 用户消息里的结构（附件、批注、@ 引用）

**发给模型的那段文字就是唯一事实**，不另存结构。输入框用 `src/shared/userTurn.ts` 的 `encodeUserTurn` 把附件、批注写成 `<kydog-attachments>` / `<kydog-comment>` 块接在正文后面、@ 引用写成行内 `<kydog-ref path="…"/>`（引用文件夹时路径以 `/` 结尾，在 @ 列表里选中那一刻按 `project.readDir` 给的类型写下，之后不再猜；标签上的名字输入框、历史、自动标题都走 `userTurn.ts` 的 `refLabel`），图片作为 pi 的图片块随 `thread.send` 的 `images` 走（`threadService.send` → `AgentService.send` → `session.prompt(text, { images })`）。`threadService.send` 这一跳还在对话仍叫「无标题」时触发起标题，交给 `titleService` 的是 `turnTitleSource` 解出来的纯文字（正文里的引用换成文件名；正文空就用第一条批注的引文、再没有就用第一个附件的名字），不是带标签的原文。历史显示（`UserMessage`）用同一个模块的 `decodeUserTurn` 解回来：刚发出的与重新载入的走同一段代码，所以不会对不上。解码只认严格格式，不合格的整条按正文原样显示。

文件在不在磁盘上，看 preload 暴露的 `window.kydog.pathForFile`（`webUtils.getPathForFile`）：返回**空串就是不在磁盘上**（截图、从网页拖进来的图），这是 Electron 给的事实，不按文件名猜。判据收在 `attachments.ts` 的 `classifyFile`，粘贴、拖入、回形针三条入口共用（`composerIngest.ts`），粘贴先经 `routePaste` 分流：能发的图片一律读成图片块随消息走，有路径时再带上路径（在目标对话的项目内发相对路径，否则绝对路径），没路径的起名「截图 N」；其他文件有路径就按路径引用，没路径引用不了，托盘提示。

能不能发图由 pi `Model.input` 决定：`llm.list` 的每个服务商带 `imageInputModelIds` 供输入框预先拦；主进程发送时按会话实际模型再判一次（`llm.imageUnsupported`）。

@ 的项目文件列表没有主进程索引，也不另设 RPC / 事件：渲染层一次弹出 = 一个会话（`renderer/panels/main-pane/mentionSearch.ts`，纯逻辑、注入读目录的函数），复用文件树的 `project.readDir`（同一套 `isListedName` 过滤与排序）。查询词为空或含 `/` 时**逐级浏览**，只读那一个目录、按这一层的筛选词筛；否则**按名字找**：先出根目录这一层，同时从浅到深一层层往下读（整个会话同一时间只有一个 readDir 在飞），名字命中的文件随读随进、取前 50。读过的目录记在会话内存里，接着打字只在已读的内容里重筛，切到逐级浏览时暂停往下读。列表关掉就停：Composer 在查询词变回 null、换项目、卸载时 `dispose()`，内存随之丢掉。**不设文件数上限、不设时限、不跨会话缓存** —— 大目录只在用户开着列表等的时候才被读，下次弹出从头读，agent 刚写出的文件自然就在。
