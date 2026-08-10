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

渲染层所有 `window.kydog.on(...)` 订阅集中在 `setupEventBridge()` 里，事件从那里落进对应 store。

## 一处非直觉：ask 事件的来源不同

**只有 ask 的打开/关闭**（`run.ask_start` / `run.ask_end`）是 `askUserQuestionTool` 通过 shared callbacks 主动上行的。原因是只有工具知道 pending 何时真正就绪——校验参数、分配 id、向 broker 注册，这些都发生在 pi 的 `tool_execution_start` **之后**；照那个事件开 UI 会让非法参数也闪一下提问界面。

其余 `run.*` 事件都来自 `AgentService.subscribe()` 对 pi session 的订阅：`run.started` 来自 `agent_start`，两个 delta 来自 message 流，普通 `run.tool_call_*` 来自 `tool_execution_start` / `tool_execution_end`，`run.ended` 来自 `agent_end`。

其他非直觉点（为什么按 run 而不是按 pi message 合成 messageId、为什么并行判定要读 `message_end` 携带的 content）写在 `src/main/agent/AgentService.ts` 的注释里，改那块之前先读。
