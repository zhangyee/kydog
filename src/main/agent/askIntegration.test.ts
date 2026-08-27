/**
 * ask_user_question × pi agent loop 的集成测试。
 *
 * 这里跑的是**真实的 pi agent loop**：`createAgentSession()` 造出真 session，
 * 然后把 `session.agent.streamFunction` 换成脚本化的假 provider（公开可写字段，
 * agent.d.ts 里 `streamFunction: StreamFn`），所以不联网、不需要 API 调用，
 * 但工具分发 / 事件顺序 / terminate / 批次调度全都是 pi 自己的代码。
 *
 * 存在的理由：ask 工具的设计建立在若干条 pi 行为上，而其它测试全用假 broker、
 * 假事件、fixture session，钉不住 pi 本身。升级 pi 时这个文件会先红。
 *
 * 不写用户目录：cwd / agentDir 都指向 os.tmpdir() 下的临时目录，modelRuntime 的
 * 凭据走内存 CredentialStore、modelsPath 给 null，够不着真实用户状态。
 * sessionManager 默认 inMemory；只有验证 jsonl 往返那条用真实文件，
 * 落在同一个临时目录里，afterEach 一起删掉。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AssistantMessage, Model, TextContent, ToolCall } from '@earendil-works/pi-ai';
import { createAskUserQuestionTool } from './askUserQuestionTool';
import { QuestionBroker } from './questionBroker';
import { createAskBatchExtension } from './askBatchExtension';
import { BATCH_BLOCK_REASON } from './askBatchGuard';
import { normalizePiMessages, type PiMessage } from './messageNormalizer';
import { ASK_TOOL_NAME, isAskOutcome, type AskQuestion } from '../../shared/askQuestion';

const THREAD = 'thread-1';
const SECOND_TURN = '第二轮才会出现的特征文本';

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 满足 Model 结构即可——streamFunction 被替换后它永远不会真的被调用。 */
const FAKE_MODEL = {
  id: 'fake', name: 'Fake', api: 'anthropic-messages', provider: 'anthropic',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000, maxTokens: 4096,
} as unknown as Model<'anthropic-messages'>;

const VALID_ASK_ARGS = {
  questions: [{
    question: '检索结果按什么排序？',
    header: '排序',
    options: [
      { label: '按时间', description: '最新的在前' },
      { label: '按引用', description: '引用多的在前', recommended: true },
    ],
  }],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'kydog-ask-int-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Turn = (TextContent | ToolCall)[];

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { type: 'toolCall', id, name, arguments: args as Record<string, unknown> };
}

function text(t: string): TextContent {
  return { type: 'text', text: t };
}

/** 一个 execute 里记录进出场的假工具，用来观察批次是并行还是串行。 */
function probeTool(name: string, log: string[], delayMs: number) {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: async () => {
      log.push(`${name}:start`);
      await sleep(delayMs);
      log.push(`${name}:end`);
      return { content: [{ type: 'text' as const, text: 'ok' }], details: {} };
    },
  };
}

type Harness = {
  session: any;
  broker: QuestionBroker;
  /** ask 的 UI 被打开时的回调——测试在这里提交 / 取消 / 中止。 */
  onOpened: (toolCallId: string, questions: AskQuestion[]) => void;
  opened: Array<{ toolCallId: string; questions: AskQuestion[] }>;
  closed: Array<{ toolCallId: string; outcome: unknown }>;
  events: Array<Record<string, any>>;
  log: string[];
  streamCalls: () => number;
  run: () => Promise<void>;
  messages: () => any[];
  toolResults: () => any[];
  assistantTexts: () => string[];
};

async function makeHarness(opts: {
  turns: Turn[];
  extraTools?: any[];
  /** true 时装上批次独占扩展（生产形态）；false 时是裸 pi，用来观察 pi 自己的调度。 */
  batchGuard?: boolean;
  log?: string[];
  /** 给了就写真实 jsonl（与 sessionFactory 生产形态同一个构造器）；否则 inMemory。 */
  sessionFile?: string;
}): Promise<Harness> {
  const dir = tmpDir();
  const pi = await import('@earendil-works/pi-coding-agent');

  const broker = new QuestionBroker();
  const opened: Harness['opened'] = [];
  const closed: Harness['closed'] = [];
  const log = opts.log ?? [];

  const h: Harness = {
    session: undefined,
    broker,
    onOpened: () => {},
    opened,
    closed,
    events: [],
    log,
    streamCalls: () => 0,
    run: async () => {},
    messages: () => [],
    toolResults: () => [],
    assistantTexts: () => [],
  };

  const askTool = createAskUserQuestionTool(THREAD, {
    onOpened(toolCallId, questions) {
      opened.push({ toolCallId, questions });
      h.onOpened(toolCallId, questions);
    },
    onClosed(toolCallId, outcome) {
      closed.push({ toolCallId, outcome });
    },
  }, 'zh', broker);

  // session.prompt() 在开流之前先要求 provider 有 auth（hasConfiguredAuth），
  // 这一步跟 streamFunction 被不被替换无关，所以假 key 还是得给。0.83 去掉了
  // AuthStorage，等价物是喂一个内存 CredentialStore 的 ModelRuntime。
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('anthropic', async () => ({ type: 'api_key', key: 'test-key' }));
  // modelsPath: null —— 不去读 ~/.pi/agent/models.json，保持不碰用户状态。
  const modelRuntime = await pi.ModelRuntime.create({ credentials, modelsPath: null });

  const extensionFactories = opts.batchGuard ? [createAskBatchExtension().factory] : [];
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories,
  });
  await resourceLoader.reload();

  const { session } = await pi.createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: FAKE_MODEL,
    modelRuntime,
    sessionManager: opts.sessionFile
      ? pi.SessionManager.open(opts.sessionFile)
      : pi.SessionManager.inMemory(dir),
    resourceLoader,
    noTools: 'builtin',
    customTools: [askTool as any, ...(opts.extraTools ?? [])],
  });

  let turnIndex = 0;
  session.agent.streamFunction = ((model: any, _context: unknown, options: any) => {
    turnIndex += 1;
    const stream = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      role: 'assistant', content: [], api: model.api, provider: model.provider,
      model: model.id, usage: ZERO_USAGE, stopReason: 'stop', timestamp: Date.now(),
    };
    stream.push({ type: 'start', partial: base });
    // StreamFn 的契约：失败/中止不能抛，要编码进流里。中止后 loop 还会再调一次。
    if (options?.signal?.aborted) {
      stream.push({
        type: 'error',
        reason: 'aborted',
        error: { ...base, stopReason: 'aborted', errorMessage: 'aborted' },
      });
      return stream;
    }
    const content = opts.turns[turnIndex - 1] ?? [text('(脚本已耗尽)')];
    const hasToolCall = content.some((c) => c.type === 'toolCall');
    const message: AssistantMessage = {
      ...base, content, stopReason: hasToolCall ? 'toolUse' : 'stop',
    };
    stream.push({ type: 'done', reason: hasToolCall ? 'toolUse' : 'stop', message });
    return stream;
  }) as any;

  session.subscribe((e: any) => h.events.push(e));

  h.session = session;
  h.streamCalls = () => turnIndex;
  h.run = async () => {
    await session.prompt('开始');
    await session.agent.waitForIdle();
  };
  h.messages = () => session.agent.state.messages as any[];
  h.toolResults = () => h.messages().filter((m) => m.role === 'toolResult');
  h.assistantTexts = () => h.messages()
    .filter((m) => m.role === 'assistant')
    .flatMap((m: any) => m.content as any[])
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => c.text as string);

  return h;
}

/** 把每题的第一个选项选上，构造一份合法答案。 */
function answerFirstOption(questions: AskQuestion[]) {
  return questions.map((q) => ({
    questionId: q.id,
    kind: 'answered' as const,
    optionIds: [q.options[0].id],
  }));
}

describe('ask_user_question × pi agent loop', () => {
  it('tool_execution_end 早于 toolResult 的 message_end', async () => {
    const h = await makeHarness({ turns: [[toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS)]] });
    h.onOpened = (toolCallId, questions) => {
      setTimeout(() => h.broker.submit(THREAD, toolCallId, answerFirstOption(questions)), 0);
    };
    await h.run();

    const execEnd = h.events.findIndex(
      (e) => e.type === 'tool_execution_end' && e.toolCallId === 'tc-ask',
    );
    const resultEnd = h.events.findIndex(
      (e) => e.type === 'message_end' && e.message?.role === 'toolResult' && e.message?.toolCallId === 'tc-ask',
    );

    expect(execEnd).toBeGreaterThanOrEqual(0);
    expect(resultEnd).toBeGreaterThanOrEqual(0);
    // 设计据此：tool_execution_end 时 toolResult 还没落盘，不能在那里假定已有结果。
    expect(execEnd).toBeLessThan(resultEnd);
  }, 20_000);

  it('取消返回 terminate: true 时 agent loop 早停，模型没有第二轮', async () => {
    const h = await makeHarness({
      turns: [[toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS)], [text(SECOND_TURN)]],
    });
    h.onOpened = (toolCallId) => {
      setTimeout(() => h.broker.cancel(THREAD, toolCallId), 0);
    };
    await h.run();

    expect(h.closed[0].outcome).toEqual({ kind: 'cancelled' });
    expect(h.toolResults()[0].details).toMatchObject({ kind: 'cancelled' });
    expect(h.streamCalls()).toBe(1);
    expect(h.assistantTexts().join('\n')).not.toContain(SECOND_TURN);
  }, 20_000);

  it('正常提交不设 terminate，模型继续第二轮', async () => {
    const h = await makeHarness({
      turns: [[toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS)], [text(SECOND_TURN)]],
    });
    h.onOpened = (toolCallId, questions) => {
      setTimeout(() => h.broker.submit(THREAD, toolCallId, answerFirstOption(questions)), 0);
    };
    await h.run();

    expect(h.streamCalls()).toBe(2);
    expect(h.assistantTexts().join('\n')).toContain(SECOND_TURN);
    const details = h.toolResults()[0].details;
    expect(details.kind).toBe('answered');
    expect(isAskOutcome(details)).toBe(true);
  }, 20_000);

  it('中止时 details 是 { kind: "aborted" } 而不是空对象', async () => {
    const h = await makeHarness({
      turns: [[toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS)], [text(SECOND_TURN)]],
    });
    h.onOpened = () => {
      // 跟生产一致：AgentService 调的是 session.abort()。
      setTimeout(() => void h.session.abort(), 0);
    };
    await h.run();

    expect(h.closed[0].outcome).toEqual({ kind: 'aborted' });
    const tr = h.toolResults()[0];
    // broker 走 resolve 不走 reject——reject 会被 pi catch 成 details: {} 的 error 结果。
    expect(tr.isError).toBe(false);
    expect(tr.details.kind).toBe('aborted');
    expect(isAskOutcome(tr.details)).toBe(true);
    expect(Array.isArray(tr.details.questions)).toBe(true);
    expect(h.assistantTexts().join('\n')).not.toContain(SECOND_TURN);
  }, 20_000);

  it('参数非法产生 error toolResult，且 details 是空对象', async () => {
    // header 超过 12 字符：过得了 typebox schema，过不了 validateQuestions。
    const badArgs = {
      questions: [{
        ...VALID_ASK_ARGS.questions[0],
        header: '这个标题明显超过了十二个字符的限制',
      }],
    };
    const h = await makeHarness({
      turns: [[toolCall('tc-bad', ASK_TOOL_NAME, badArgs)], [text(SECOND_TURN)]],
    });
    await h.run();

    expect(h.opened).toHaveLength(0);
    const tr = h.toolResults()[0];
    expect(tr.isError).toBe(true);
    // 这条钉住「details 不能当 AskOutcome 用」：历史恢复必须靠 isAskOutcome 守卫。
    expect(tr.details).toEqual({});
    expect(isAskOutcome(tr.details)).toBe(false);
    // 没有 terminate，所以模型照样有第二轮（错误会回给模型让它改）。
    expect(h.streamCalls()).toBe(2);
  }, 20_000);

  it('schema 层非法（questions 为空数组）同样是 details: {} 的 error toolResult', async () => {
    const h = await makeHarness({
      turns: [[toolCall('tc-empty', ASK_TOOL_NAME, { questions: [] })], [text(SECOND_TURN)]],
    });
    await h.run();

    expect(h.opened).toHaveLength(0);
    const tr = h.toolResults()[0];
    expect(tr.isError).toBe(true);
    expect(tr.details).toEqual({});
  }, 20_000);

  // 历史路径（session jsonl → normalizePiMessages）唯一的地基：details 必须原样
  // 穿过落盘和读回。messageNormalizer.test.ts 的 ask 用例全都手写 details，等于
  // 假设了这条往返成立；pi 哪天改成只持久化 content/isError，所有历史里的 ask
  // 卡片会静默退化成 unanswered，而那边一条都不会红。
  it('details 穿过 session jsonl 的往返，历史恢复还原成 answered', async () => {
    const sessionFile = path.join(tmpDir(), `${THREAD}.jsonl`);
    const h = await makeHarness({
      sessionFile,
      turns: [[toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS)], [text(SECOND_TURN)]],
    });
    let asked: AskQuestion[] = [];
    h.onOpened = (toolCallId, questions) => {
      asked = questions;
      setTimeout(() => h.broker.submit(THREAD, toolCallId, answerFirstOption(questions)), 0);
    };
    await h.run();

    const written = h.toolResults()[0].details;
    expect(written.kind).toBe('answered');
    expect(existsSync(sessionFile)).toBe(true);

    // 重新打开同一个 jsonl。createAgentSession 恢复历史走的也是 buildSessionContext，
    // 所以这就是生产重启后 loadHistory 拿到的那份 messages。
    const pi = await import('@earendil-works/pi-coding-agent');
    const reopened = pi.SessionManager.open(sessionFile);
    const messages = reopened.buildSessionContext().messages as any[];
    const reread = messages.find((m) => m.role === 'toolResult' && m.toolCallId === 'tc-ask');
    expect(reread).toBeDefined();
    expect(reread.details).toEqual(written);

    const blocks = normalizePiMessages(messages as PiMessage[])
      .filter((m): m is Extract<typeof m, { role: 'assistant' }> => m.role === 'assistant')
      .flatMap((m) => m.blocks);
    expect(blocks.find((b) => b.kind === 'ask')).toEqual({
      kind: 'ask',
      toolCallId: 'tc-ask',
      questions: asked,
      status: 'answered',
      answers: answerFirstOption(asked),
    });
  }, 20_000);

  describe('批次独占（装了 askBatchExtension）', () => {
    it('[其它工具, ask] 里两个 execute 都不跑', async () => {
      const write = probeTool('fake_write', [], 0);
      const writeSpy = vi.fn(write.execute);
      const h = await makeHarness({
        batchGuard: true,
        extraTools: [{ ...write, execute: writeSpy }],
        turns: [[
          toolCall('tc-w', 'fake_write', {}),
          toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS),
        ], [text(SECOND_TURN)]],
      });
      await h.run();

      expect(writeSpy).not.toHaveBeenCalled();
      expect(h.opened).toHaveLength(0);
      const texts = h.toolResults().map((m) => m.content[0].text);
      expect(texts).toEqual([BATCH_BLOCK_REASON, BATCH_BLOCK_REASON]);
      expect(h.toolResults().every((m) => m.isError)).toBe(true);
    }, 20_000);

    it('[ask, 其它工具] 顺序反过来也一样', async () => {
      const write = probeTool('fake_write', [], 0);
      const writeSpy = vi.fn(write.execute);
      const h = await makeHarness({
        batchGuard: true,
        extraTools: [{ ...write, execute: writeSpy }],
        turns: [[
          toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS),
          toolCall('tc-w', 'fake_write', {}),
        ], [text(SECOND_TURN)]],
      });
      await h.run();

      expect(writeSpy).not.toHaveBeenCalled();
      expect(h.opened).toHaveLength(0);
      expect(h.toolResults().map((m) => m.content[0].text))
        .toEqual([BATCH_BLOCK_REASON, BATCH_BLOCK_REASON]);
    }, 20_000);

    it('两个 ask 同批也全部拒绝', async () => {
      const h = await makeHarness({
        batchGuard: true,
        turns: [[
          toolCall('tc-a1', ASK_TOOL_NAME, VALID_ASK_ARGS),
          toolCall('tc-a2', ASK_TOOL_NAME, VALID_ASK_ARGS),
        ], [text(SECOND_TURN)]],
      });
      await h.run();

      expect(h.opened).toHaveLength(0);
      expect(h.toolResults().map((m) => m.content[0].text))
        .toEqual([BATCH_BLOCK_REASON, BATCH_BLOCK_REASON]);
    }, 20_000);

    it('对照组：不装守卫时 pi 自己不拦，同一批两个 execute 都会跑', async () => {
      const write = probeTool('fake_write', [], 0);
      const writeSpy = vi.fn(write.execute);
      const h = await makeHarness({
        batchGuard: false,
        extraTools: [{ ...write, execute: writeSpy }],
        turns: [[
          toolCall('tc-w', 'fake_write', {}),
          toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS),
        ], [text(SECOND_TURN)]],
      });
      h.onOpened = (toolCallId, questions) => {
        setTimeout(() => h.broker.submit(THREAD, toolCallId, answerFirstOption(questions)), 0);
      };
      await h.run();

      // 批次独占完全是 KyDog 自己的守卫带来的，pi 没有这条规则。
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(h.opened).toHaveLength(1);
    }, 20_000);

    it('单独调用 ask 不受守卫影响', async () => {
      const h = await makeHarness({
        batchGuard: true,
        turns: [[toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS)], [text(SECOND_TURN)]],
      });
      h.onOpened = (toolCallId, questions) => {
        setTimeout(() => h.broker.submit(THREAD, toolCallId, answerFirstOption(questions)), 0);
      };
      await h.run();

      expect(h.opened).toHaveLength(1);
      expect(h.toolResults()[0].isError).toBe(false);
    }, 20_000);
  });

  describe('sequential 传染整批（裸 pi，不装守卫）', () => {
    it('对照组：两个普通工具同批是并行的', async () => {
      const log: string[] = [];
      const h = await makeHarness({
        log,
        extraTools: [probeTool('slow', log, 40), probeTool('quick', log, 1)],
        turns: [[toolCall('tc-s', 'slow', {}), toolCall('tc-q', 'quick', {})], [text('done')]],
      });
      await h.run();

      // 并行：quick 在 slow 还没结束时就跑完了。
      expect(log).toEqual(['slow:start', 'quick:start', 'quick:end', 'slow:end']);
    }, 20_000);

    it('批次里有 ask（executionMode: sequential）时整批串行', async () => {
      const log: string[] = [];
      const h = await makeHarness({
        log,
        extraTools: [probeTool('slow', log, 40)],
        turns: [[
          toolCall('tc-s', 'slow', {}),
          toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS),
        ], [text('done')]],
      });
      h.onOpened = (toolCallId, questions) => {
        log.push('ask:opened');
        setTimeout(() => h.broker.submit(THREAD, toolCallId, answerFirstOption(questions)), 0);
      };
      await h.run();

      // 串行：slow 完全跑完之后 ask 才开始。并行的话 ask:opened 会插在 slow:end 之前。
      expect(log).toEqual(['slow:start', 'slow:end', 'ask:opened']);
    }, 20_000);

    it('terminate 只在整批都 terminate 时才早停——所以批次独占是取消能停下来的前提', async () => {
      const log: string[] = [];
      const h = await makeHarness({
        log,
        extraTools: [probeTool('slow', log, 1)],
        turns: [[
          toolCall('tc-s', 'slow', {}),
          toolCall('tc-ask', ASK_TOOL_NAME, VALID_ASK_ARGS),
        ], [text(SECOND_TURN)]],
      });
      h.onOpened = (toolCallId) => {
        setTimeout(() => h.broker.cancel(THREAD, toolCallId), 0);
      };
      await h.run();

      // ask 自己确实返回了 terminate，但同批的 slow 没有，于是 loop 照常进入第二轮。
      expect(h.closed[0].outcome).toEqual({ kind: 'cancelled' });
      expect(h.streamCalls()).toBe(2);
      expect(h.assistantTexts().join('\n')).toContain(SECOND_TURN);
    }, 20_000);
  });
});
