import { promises as fs } from 'node:fs';
import { createAskUserQuestionTool, type AskSharedState } from './askUserQuestionTool';
import type { AskLocale } from './askAnswers';
import { ASK_TOOL_NAME } from '../../shared/askQuestion';
import { pickFixtureEvents, type FixtureFile, type FixtureEvent } from '../../../e2e/fixtures/fixture.types';

export type FakeSessionListener = (event: { type: string; [k: string]: unknown }) => void;

/**
 * 一个已注册的 customTool，在 fixture 这一侧用得着的那部分。
 *
 * 形状照 pi 的工具定义（`browserTools.ts` 那四个的公共形态），但**只挑名字与
 * `execute`**：fixture 不做 schema 校验、不看 description —— 它要做的事就是
 * 「按名字把那次调用真的执行一遍」。
 */
export type FixtureTool = {
  name: string;
  execute: (
    toolCallId: string,
    args: never,
    signal?: AbortSignal,
    ...rest: never[]
  ) => Promise<{ content: unknown[]; details?: unknown }>;
};

export type FakeAgentSession = {
  prompt: (content: string) => Promise<void>;
  abort: () => void;
  subscribe: (listener: FakeSessionListener) => () => void;
  cleanup: () => Promise<void>;
  state: { messages: unknown[] };
};

/**
 * @param tools 这条 session 上**真的注册着**的工具（`sessionFactory` 交进来的那一份）。
 *   `tool` 事件按名字在这里找。缺省空数组 —— 只发 text/bash/ask 的老 fixture 一个字都不用改。
 */
export async function createFixtureSession(
  fixturePath: string,
  askShared: AskSharedState,
  threadId: string,
  locale: AskLocale,
  tools: readonly FixtureTool[] = [],
): Promise<FakeAgentSession> {
  const raw = await fs.readFile(fixturePath, 'utf8');
  const file = JSON.parse(raw) as FixtureFile;
  const listeners = new Set<FakeSessionListener>();
  let aborted = false;
  // abort() 落地时可能已经有一个事件在 setTimeout 里等待（比如 fixture 里
  // after_ms 很长的下一条 delta）——只置 aborted 标志拦不住它：定时器到点后
  // 事件照样会被 emit 出去，慢机器上 Stop 就形同虚设。abort 之后不得再送任何
  // 事件——这是协议层面的语义，不是"尽量快地停"，所以必须能短路当前正在
  // 等待的那一个定时器，而不是干等它自然到点。
  let cancelPendingWait: (() => void) | null = null;
  // 工具的 `execute` 收到的那个 AbortSignal。**不是第二个真相**：唯一的写入点还是
  // abort()，这里只是把同一次中止翻译成工具那一侧认得的形态。缺了它，一批 60 个动作的
  // `browser_act`（`runBatch` 逐步查 `signal.aborted`）在 fixture 下按了停止也停不住，
  // 而真实 pi 那条路上是停得住的 —— 两条路的语义不许在这里分叉。
  let toolAbort: AbortController | null = null;

  return {
    state: { messages: [] },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    abort() { aborted = true; cancelPendingWait?.(); toolAbort?.abort(); },
    async cleanup() { listeners.clear(); },
    async prompt(content) {
      // 先挑剧本：认不到就在发出任何事件之前抛（AgentService 那边按这一轮出错收口）。
      const events = pickFixtureEvents(file, content);
      // 中止只作用于它那一轮。不复位的话，同一个对话里停过一次，之后每一轮的事件都会被
      // 下面的 `aborted` 判断整份吞掉 —— 真实 pi 那条路上没有这回事。
      aborted = false;
      try {
        toolAbort = new AbortController();
        // Accumulate tool chunks so tool_end can embed them in result
        const toolChunks = new Map<string, string>();
        // 必须用真实 threadId：broker 按 threadId 索引 pending，
        // renderer 发来的 ask.submit / ask.cancel 带的就是它。
        const askTool = createAskUserQuestionTool(threadId, askShared, locale);
        for (const evt of events) {
          if (aborted && evt.type !== 'agent_end') continue;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, evt.after_ms);
            cancelPendingWait = () => { clearTimeout(timer); resolve(); };
          });
          cancelPendingWait = null;
          // abort 可能就发生在上面这次等待期间：定时器被提前短路唤醒，这条事件
          // 本身也不该再送出去（agent_end 除外——UI 靠它把状态收回 idle）。
          if (aborted && evt.type !== 'agent_end') continue;

          if (evt.type === 'ask') {
            // 走真实的工具：校验、分配 id、注册 broker、挂起等 renderer。
            // 先发 tool_execution_start（AgentService 靠它缓存 args），
            // 再发 tool_execution_end（携带 details），与真实 pi 顺序一致。
            emitRaw(listeners, {
              type: 'tool_execution_start',
              toolCallId: evt.toolCallId,
              toolName: ASK_TOOL_NAME,
              args: { questions: evt.questions },
            });
            let result: { content: unknown[]; details: unknown };
            let isError = false;
            try {
              result = (await askTool.execute(
                evt.toolCallId,
                { questions: evt.questions },
                undefined,
                undefined,
                {} as never,
              )) as typeof result;
            } catch (err) {
              result = { content: [{ type: 'text', text: String(err) }], details: {} };
              isError = true;
            }
            emitRaw(listeners, {
              type: 'tool_execution_end',
              toolCallId: evt.toolCallId,
              toolName: ASK_TOOL_NAME,
              result,
              isError,
            });
            continue;
          }

          if (evt.type === 'tool') {
            // 走真实的工具，**与上面 ask 那一条一字不差的形态** —— 那一条从来就是真调
            // `askUserQuestionTool.execute`。这里只是把「只认识 ask 一种工具」补齐成
            // 「按名字找 sessionFactory 交进来的任意一个」。
            //
            // **这条路上没有任何捷径**：`tools` 里的对象就是非 fixture 分支交给 pi 的
            // 那一份（`sessionFactory` 里同一次 `createBrowserTools()`），所以
            // `browser_act` → `browserService.enqueue` → `withAgentDriving` →
            // `dispatch` / `evalInPage` 整条路一步不少。事件顺序也照真实 pi：
            // 先 tool_execution_start（AgentService 靠它建工具卡），再 end。
            //
            // **「没有捷径」也意味着「有真实副作用」**：`browser_open` 真打公网，
            // `browser_login` 真用设置里那份校园账号提交一次登录、且本轮只有一次机会。
            // 副作用清单写在 `e2e/fixtures/fixture.types.ts` 的 `tool` 那段 docblock 里
            // （那是写剧本的人唯一会读的地方），改这里也去看一眼。
            emitRaw(listeners, {
              type: 'tool_execution_start',
              toolCallId: evt.toolCallId,
              toolName: evt.name,
              args: evt.args,
            });
            const tool = tools.find((t) => t.name === evt.name);
            let result: { content: unknown[]; details?: unknown };
            let isError = false;
            if (!tool) {
              // 名字打错了**不许**静默变成「这一步什么都没发生」：那样一条本该红的用例会绿。
              result = { content: [{ type: 'text', text:
                `fixture 里写的工具名 ${JSON.stringify(evt.name)} 没有注册。`
                + `这条 session 上注册着：${tools.map((t) => t.name).join(' / ') || '（一个都没有）'}` }] };
              isError = true;
            } else {
              try {
                result = await tool.execute(evt.toolCallId, evt.args as never, toolAbort?.signal);
              } catch (err) {
                result = { content: [{ type: 'text', text: String(err) }] };
                isError = true;
              }
            }
            emitRaw(listeners, {
              type: 'tool_execution_end',
              toolCallId: evt.toolCallId,
              toolName: evt.name,
              result,
              isError,
            });
            continue;
          }

          // Accumulate chunks before emitting
          if (evt.type === 'tool_chunk') {
            toolChunks.set(evt.toolCallId, (toolChunks.get(evt.toolCallId) ?? '') + evt.chunk);
          }
          emit(listeners, evt, aborted, toolChunks);
          if (evt.type === 'agent_end') break;
        }
      } finally {
        // 照 pi：`_runAgentPrompt` 的 finally 里最后发 `agent_settled`（出错、中止都发）。AgentService
        // 靠它清掉本轮的 runId —— 不发的话 `hasActiveRun()` 在 fixture 下跑过一轮就恒为真，
        // 之后切界面语言一律被拒，而真实 pi 那条路上没有这回事。
        emitRaw(listeners, { type: 'agent_settled' });
      }
    },
  };
}

/** 直接投递已经是 pi 形状的事件（ask 分支自己造事件，不经过 toPiShape）。 */
function emitRaw(listeners: Set<FakeSessionListener>, evt: { type: string; [k: string]: unknown }) {
  for (const l of listeners) l(evt);
}

function emit(listeners: Set<FakeSessionListener>, evt: FixtureEvent, aborted: boolean, toolChunks: Map<string, string>) {
  const piShape = toPiShape(evt, aborted, toolChunks);
  if (!piShape) return;
  for (const l of listeners) l(piShape);
}

/** Stub AssistantMessage for fixture events that need a message object */
function stubAssistantMessage(stopReason: string, errorMessage?: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    stopReason,
    errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

function toPiShape(evt: FixtureEvent, aborted: boolean, toolChunks: Map<string, string>): { type: string; [k: string]: unknown } | null {
  switch (evt.type) {
    case 'agent_start':
      return { type: 'agent_start' };

    case 'message_start':
      // Real pi message_start has a message object, no top-level messageId
      return { type: 'message_start', message: stubAssistantMessage('toolUse') };

    case 'text_delta':
      return {
        type: 'message_update',
        message: stubAssistantMessage('toolUse'),
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: evt.delta, partial: stubAssistantMessage('toolUse') },
      };

    case 'thinking_delta':
      return {
        type: 'message_update',
        message: stubAssistantMessage('toolUse'),
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: evt.delta, partial: stubAssistantMessage('toolUse') },
      };

    case 'tool_start':
      return {
        type: 'tool_execution_start',
        toolCallId: evt.toolCallId,
        toolName: evt.name,
        args: evt.args ?? { command: evt.command },
      };

    case 'tool_chunk':
      // AgentService ignores tool_execution_update; skip emitting
      return null;

    case 'ask':
    case 'tool':
      // prompt 循环里单独处理（要 await 真实工具），走不到这里；switch 要穷尽。
      return null;

    case 'tool_end': {
      // Embed accumulated chunk text into the result so AgentService emits it at tool_execution_end
      const accumulated = toolChunks.get(evt.toolCallId) ?? '';
      return {
        type: 'tool_execution_end',
        toolCallId: evt.toolCallId,
        toolName: 'bash',
        result: { content: [{ type: 'text', text: accumulated }] },
        isError: evt.status === 'failed',
      };
    }

    case 'message_end': {
      // 把 fixture 声明的 toolCallIds 注入到 message.content —— 这是协议事实的载体：
      // 真实 pi 的 message_end 携带的 assistant message 的 content 里就包含本条 message
      // 的所有 toolCall（即使对应的 tool_execution_start 还没发出来）。
      // toolNames 与 toolCallIds 同序；缺省是 'bash'。批次里含 ask 时必须如实写出——
      // 并行判定看的就是这个名字。
      const content: Array<{ type: string; [k: string]: unknown }> = [];
      if (Array.isArray(evt.toolCallIds)) {
        evt.toolCallIds.forEach((id, i) => {
          content.push({ type: 'toolCall', id, name: evt.toolNames?.[i] ?? 'bash', arguments: {} });
        });
      }
      const msg = { ...stubAssistantMessage('stop'), content };
      return { type: 'message_end', message: msg };
    }

    case 'agent_end': {
      const reason = aborted ? 'aborted' : evt.reason;
      // Map fixture reason → pi stopReason
      let stopReason: string;
      if (reason === 'aborted') stopReason = 'aborted';
      else if (reason === 'error') stopReason = 'error';
      else stopReason = 'stop'; // 'completed' → 'stop'
      const msg = stubAssistantMessage(stopReason, evt.errorMessage);
      return { type: 'agent_end', messages: [msg] };
    }
  }
}
