import type { RunEvent } from '../shared/protocol';
import { useRunsStore } from './stores/runsStore';
import { useThreadsStore } from './stores/threadsStore';
import { useAskStore } from './stores/askStore';
import { useUnreadStore } from './panels/workspace/unreadStore';
import { useUiStore } from './stores/uiStore';

/**
 * 本轮的 buffer 还不存在就先建出来。
 *
 * 每个往 buffer 里写东西的 handler 都要先过这一道：主进程发事件的顺序不保证
 * 「一定有个 delta 打头」—— 模型可以张口就是一批工具调用。少一道这个，那一轮的
 * block 会静默 no-op 掉。
 */
function ensureBuffer(threadId: string, messageId: string): void {
  if (!useRunsStore.getState().bufferByMessage[messageId]) {
    useRunsStore.getState().startMessageBuffer(threadId, messageId);
  }
}

/**
 * 人机交接：把浏览器侧栏展开并切到那个标签（spec §4.5）。
 *
 * **只在 `run.ask_start` 真的带了 `browserTabId` 时才做。** 刻意不去推断
 * 「ask 发生时正好有 agent 焦点标签」—— 那是拿时间相关性当事实，而且推不出来：
 * `browser_login` 的首次确认发生在**进标签队列之前**，那一刻还没有任何驱动帧
 * 握着它，推断的结果是 null。
 *
 * `browser.activate` **不先查渲染层那份镜像**：标签在不在是主进程说了算，
 * 镜像只是它的一个副本，拿副本当判据就是在下游补 proxy。id 已经不存在时主进程回
 * `browser.no_tab` —— 那不是错，是「用户把那个标签关了」，侧栏照样展开，不刷日志。
 *
 * **已知的观感问题（登记，不修）**：`run.ask_start` 会被 `thread.loadHistory` 的
 * journal 重放喂第二遍，这个函数会跟着再跑一次、侧栏无缘由展开一下。修法要一个
 * 「这一帧是重放」的协议信号，今天没有 —— 为它现造一个就是在下游补 proxy，
 * 这里选择不修。
 */
function handOffToBrowser(tabId: string): void {
  useUiStore.setState({ browserOpen: true });
  void window.kydog.invoke('browser.activate', { tabId }).catch((err: unknown) => {
    if ((err as { code?: string })?.code === 'browser.no_tab') return;
    console.error('browser.activate failed', err);
  });
}

/**
 * 一条 run.* 事件落进 store 的唯一入口。
 *
 * setupEventBridge 的实时订阅和 thread.loadHistory 的 journal 重放都走这里 ——
 * 重放不是「另一条复原路径」，它就是把同一批事件再喂一遍。两条路径共用一段代码，
 * 才不会出现「直播时算出来的 block 和重载后复原的 block 不一样」。
 */
export function applyRunEvent(e: RunEvent): void {
  switch (e.topic) {
    case 'run.started': {
      useRunsStore.getState().setRun(e.payload.threadId, { status: 'running', runId: e.payload.runId });
      return;
    }
    case 'run.thinking_delta': {
      const p = e.payload;
      ensureBuffer(p.threadId, p.messageId);
      useRunsStore.getState().appendThinking(p.messageId, p.delta);
      return;
    }
    case 'run.message_delta': {
      const p = e.payload;
      ensureBuffer(p.threadId, p.messageId);
      useRunsStore.getState().appendDelta(p.messageId, p.delta);
      return;
    }
    // 三个 tool_call 事件一律按 payload 里的 messageId 归位 —— 那是主进程发事件时
    // 手上的 activeMessageId，是协议事实。曾经这里靠「最近的那个 buffer」「已经含这个
    // toolCallId 的 buffer」去猜，渲染进程一重载 buffer 全空，两个近似都落空，
    // 于是重载期间结束的工具永远停在「运行中」。
    case 'run.tool_call_start': {
      const p = e.payload;
      // 与两个 delta handler 同形：本轮如果直接就是工具调用、前面没有任何文字或思考，
      // buffer 还不存在，addToolCall 会静默 no-op。
      ensureBuffer(p.threadId, p.messageId);
      useRunsStore.getState().addToolCall(p.messageId, p.toolCallId, p.name, p.command);
      return;
    }
    case 'run.tool_call_chunk': {
      const p = e.payload;
      ensureBuffer(p.threadId, p.messageId);
      useRunsStore.getState().appendToolChunk(p.messageId, p.toolCallId, p.stream, p.chunk);
      return;
    }
    case 'run.tool_call_end': {
      const p = e.payload;
      ensureBuffer(p.threadId, p.messageId);
      useRunsStore.getState().finalizeToolCall(p.messageId, p.toolCallId, p.status, p.exitCode);
      return;
    }
    case 'run.parallel_group': {
      const p = e.payload;
      // 这条来自 pi 的 message_end，比批次里任何一个 tool_execution_start 都早。
      // 本轮若直接就是一批工具调用（前面没有文字或思考），buffer 还不存在，
      // markParallelGroup 会静默 no-op —— 并行 groupId 登记不上，六张卡片就散开了。
      ensureBuffer(p.threadId, p.messageId);
      useRunsStore.getState().markParallelGroup(p.messageId, p.toolCallIds, p.parallelGroupId);
      return;
    }
    // 一条事件两个消费者：askStore 驱动提问态 composer，runsStore 驱动留痕 block。
    case 'run.ask_start': {
      const p = e.payload;
      useAskStore.getState().open(p.threadId, p.toolCallId, p.questions);
      // 与 delta / tool handler 同形：这一轮如果直接发 ask、前面没有任何文字或思考，
      // buffer 还不存在，addAskBlock 会静默 no-op，整轮留痕就没了。
      ensureBuffer(p.threadId, p.messageId);
      useRunsStore.getState().addAskBlock(p.messageId, p.toolCallId, p.questions);
      // journal 重放会把这一条再喂一遍：侧栏因此会跟着再展开一次，是已知的观感
      // 问题，见 handOffToBrowser 文档注释，不修。
      if (p.browserTabId !== undefined) handOffToBrowser(p.browserTabId);
      return;
    }
    case 'run.ask_end': {
      const p = e.payload;
      useAskStore.getState().close(p.threadId, p.toolCallId);
      useRunsStore.getState().finalizeAskBlock(p.messageId, p.toolCallId, p.outcome);
      return;
    }
    case 'run.message_end': {
      const p = e.payload;
      const blocks = useRunsStore.getState().takeBuffer(p.messageId);
      if (!blocks) return;
      useThreadsStore.setState((s) => ({
        historyByThread: {
          ...s.historyByThread,
          [p.threadId]: [
            ...(s.historyByThread[p.threadId] ?? []),
            { id: p.messageId, role: 'assistant', createdAt: new Date().toISOString(), blocks },
          ],
        },
      }));
      return;
    }
    // 「把你手上关于这一轮的东西全扔了」。紧随其后的就是主进程重放的本轮 journal，
    // 由它把 buffer 重建出来。run 状态在这里就先置上，重放的 run.started 会再确认一次。
    case 'run.resync': {
      const p = e.payload;
      // 按 thread 整体清，不是按某个 messageId 清：上一轮没能 flush 掉的残留 buffer
      // 也一并扫走，重放之后这条 thread 手上只剩本轮的真实内容。
      useRunsStore.getState().dropBuffersForThread(p.threadId);
      useRunsStore.getState().setRun(p.threadId, { status: 'running', runId: p.runId });
      return;
    }
    case 'run.ended': {
      const p = e.payload;
      if (p.reason === 'error') {
        useRunsStore.getState().setRun(p.threadId, { status: 'error', error: p.errorMessage ?? 'unknown' });
      } else {
        useRunsStore.getState().setRun(p.threadId, { status: 'idle' });
      }
      const currentId = useThreadsStore.getState().currentThreadId;
      if (p.threadId !== currentId) {
        useUnreadStore.getState().markUnread(p.threadId);
      }
      return;
    }
  }
}
