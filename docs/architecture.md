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

其他非直觉点（为什么按 run 而不是按 pi message 合成 messageId、为什么并行判定要读 `message_end` 携带的 content）写在 `src/main/agent/AgentService.ts` 的注释里，改那块之前先读。

## 用户消息里的结构（附件、批注、@ 引用）

**发给模型的那段文字就是唯一事实**，不另存结构。输入框用 `src/shared/userTurn.ts` 的 `encodeUserTurn` 把附件、批注写成 `<kydog-attachments>` / `<kydog-comment>` 块接在正文后面、@ 引用写成行内 `<kydog-ref path="…"/>`（引用文件夹时路径以 `/` 结尾，在 @ 列表里选中那一刻按 `project.readDir` 给的类型写下，之后不再猜；标签上的名字输入框、历史、自动标题都走 `userTurn.ts` 的 `refLabel`），图片作为 pi 的图片块随 `thread.send` 的 `images` 走（`threadService.send` → `AgentService.send` → `session.prompt(text, { images })`）。`threadService.send` 这一跳还在对话仍叫「无标题」时触发起标题，交给 `titleService` 的是 `turnTitleSource` 解出来的纯文字（正文里的引用换成文件名；正文空就用第一条批注的引文、再没有就用第一个附件的名字），不是带标签的原文。历史显示（`UserMessage`）用同一个模块的 `decodeUserTurn` 解回来：刚发出的与重新载入的走同一段代码，所以不会对不上。解码只认严格格式，不合格的整条按正文原样显示。

文件在不在磁盘上，看 preload 暴露的 `window.kydog.pathForFile`（`webUtils.getPathForFile`）：返回**空串就是不在磁盘上**（截图、从网页拖进来的图），这是 Electron 给的事实，不按文件名猜。判据收在 `attachments.ts` 的 `classifyFile`，粘贴、拖入、回形针三条入口共用（`composerIngest.ts`），粘贴先经 `routePaste` 分流：能发的图片一律读成图片块随消息走，有路径时再带上路径（在目标对话的项目内发相对路径，否则绝对路径），没路径的起名「截图 N」；其他文件有路径就按路径引用，没路径引用不了，托盘提示。

能不能发图由 pi `Model.input` 决定：`llm.list` 的每个服务商带 `imageInputModelIds` 供输入框预先拦；主进程发送时按会话实际模型再判一次（`llm.imageUnsupported`）。

@ 的项目文件列表没有主进程索引，也不另设 RPC / 事件：渲染层一次弹出 = 一个会话（`renderer/panels/main-pane/mentionSearch.ts`，纯逻辑、注入读目录的函数），复用文件树的 `project.readDir`（同一套 `isListedName` 过滤与排序）。查询词为空或含 `/` 时**逐级浏览**，只读那一个目录、按这一层的筛选词筛；否则**按名字找**：先出根目录这一层，同时从浅到深一层层往下读（整个会话同一时间只有一个 readDir 在飞），名字命中的文件随读随进、取前 50。读过的目录记在会话内存里，接着打字只在已读的内容里重筛，切到逐级浏览时暂停往下读。列表关掉就停：Composer 在查询词变回 null、换项目、卸载时 `dispose()`，内存随之丢掉。**不设文件数上限、不设时限、不跨会话缓存** —— 大目录只在用户开着列表等的时候才被读，下次弹出从头读，agent 刚写出的文件自然就在。
