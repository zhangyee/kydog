import { promises as fs } from 'node:fs';
import { createAskUserQuestionTool, type AskSharedState } from './askUserQuestionTool';
import type { AskLocale } from './askAnswers';
import { ASK_TOOL_NAME } from '../../shared/askQuestion';
import type { FixtureFile, FixtureEvent } from '../../../e2e/fixtures/fixture.types';

export type FakeSessionListener = (event: { type: string; [k: string]: unknown }) => void;

export type FakeAgentSession = {
  prompt: (content: string) => Promise<void>;
  abort: () => void;
  subscribe: (listener: FakeSessionListener) => () => void;
  cleanup: () => Promise<void>;
  state: { messages: unknown[] };
};

export async function createFixtureSession(
  fixturePath: string,
  askShared: AskSharedState,
  threadId: string,
  locale: AskLocale,
): Promise<FakeAgentSession> {
  const raw = await fs.readFile(fixturePath, 'utf8');
  const file = JSON.parse(raw) as FixtureFile;
  const listeners = new Set<FakeSessionListener>();
  let aborted = false;

  return {
    state: { messages: [] },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    abort() { aborted = true; },
    async cleanup() { listeners.clear(); },
    async prompt() {
      // Accumulate tool chunks so tool_end can embed them in result
      const toolChunks = new Map<string, string>();
      // 必须用真实 threadId：broker 按 threadId 索引 pending，
      // renderer 发来的 ask.submit / ask.cancel 带的就是它。
      const askTool = createAskUserQuestionTool(threadId, askShared, locale);
      for (const evt of file.events) {
        if (aborted && evt.type !== 'agent_end') continue;
        await new Promise((r) => setTimeout(r, evt.after_ms));

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

        // Accumulate chunks before emitting
        if (evt.type === 'tool_chunk') {
          toolChunks.set(evt.toolCallId, (toolChunks.get(evt.toolCallId) ?? '') + evt.chunk);
        }
        emit(listeners, evt, aborted, toolChunks);
        if (evt.type === 'agent_end') break;
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
