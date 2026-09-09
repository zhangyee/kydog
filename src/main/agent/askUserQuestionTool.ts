import { Type } from 'typebox';
import { validateQuestions } from './askValidate';
import { renderOutcome, type AskLocale } from './askAnswers';
import { questionBroker as defaultBroker, type QuestionBroker } from './questionBroker';
import { ASK_TOOL_NAME, type AskOutcome, type AskQuestion } from '../../shared/askQuestion';

/**
 * 工具 → AgentService 的上行通道。AgentService 实现这两个回调（它持有 runId
 * 和 activeMessageId），工具只管调，不 import AgentService，避免循环依赖。
 */
export type AskSharedState = {
  /**
   * `browserTabId` 是**人机交接口**（spec §4.5）：带上它，渲染层就展开浏览器侧栏
   * 并切到那个标签，让用户看着页面回答（CARSI 的验证码、人机验证都靠它）。
   *
   * 刻意**不在渲染层用「ask 发生时正好有 agent 焦点标签」去推断** —— 那是拿时间
   * 相关性当事实：`browser.agentFocus` 的熄灯信号与 `run.ask_start` 之间没有任何
   * 顺序保证，而 `browser_login` 的确认恰好发生在**进队列之前**（此刻还没有
   * 任何驱动帧握着那个标签，那个推断会推出 null）。
   */
  onOpened(toolCallId: string, questions: AskQuestion[], browserTabId?: string): void;
  onClosed(toolCallId: string, outcome: AskOutcome): void;
};

const OptionSchema = Type.Object({
  label: Type.String({ description: '1–5 个词的短标签' }),
  description: Type.String({ description: '这个选项意味着什么' }),
  recommended: Type.Optional(Type.Boolean({ description: '推荐项，每题至多一个' })),
});

const QuestionSchema = Type.Object({
  question: Type.String({ description: '完整问句' }),
  header: Type.String({ description: '不超过 12 个字符的短标签' }),
  multiSelect: Type.Optional(Type.Boolean({ description: '是否允许多选' })),
  // 8 是数字键快捷键的上限：QuestionComposer 用 1..N 选项，第 N+1 个数字留给「其他」，
  // 到 8 时「其他」是 9，仍在单键范围内。要再多必须先改快捷键方案。
  options: Type.Array(OptionSchema, { minItems: 2, maxItems: 8 }),
});

const ParamsSchema = Type.Object({
  // 题数没有布局约束：UI 一题一屏、靠 cursor 翻页，加题只是多翻几屏。
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 10 }),
  // 问的是「屏幕上这一页」时带上它，界面会展开浏览器侧栏并切到这个标签。
  // 值只能抄自浏览器工具结果头部那行「标签页: [tab_xxx] …」，不要自己编。
  browserTabId: Type.Optional(Type.String({
    description: '这道题是关于内置浏览器某个标签上的页面时，填那个标签的 id（tab_xxx）',
  })),
});

// 导出给 systemPrompt.ts：KyDog 走自定义系统提示词后，pi 不再渲染工具的
// promptGuidelines（见 systemPrompt.ts 顶部注释），得由我们自己搬进去。
export const ASK_GUIDELINES = [
  '遇到不可逆决策、多条同样合理的路径、或纯粹的口味问题时，用 ask_user_question 问用户，不要自己挑一个假设继续。',
  '自己查得到的事实、只有一个合理答案的问题，不要问。',
  'ask_user_question 必须单独调用，不能和其他工具放在同一批 tool call 里，否则整批都会被拒绝。',
];

/**
 * 每个 thread 一个实例。threadId 由闭包绑定——pi 的 execute 拿不到它。
 * broker 参数只为测试注入，生产代码用默认的单例。
 * locale 由调用方在 session 构造时快照传入（见 sessionFactory.ts），本函数不读 settings。
 */
export function createAskUserQuestionTool(
  threadId: string,
  shared: AskSharedState,
  locale: AskLocale,
  broker: QuestionBroker = defaultBroker,
) {
  return {
    name: ASK_TOOL_NAME,
    label: '提问',
    description: '在遇到需要用户决定的分叉点时暂停，向用户提出 1–10 个多选题并等待回答。',
    promptSnippet: 'ask_user_question — 停下来向用户提问（必须单独调用）',
    promptGuidelines: ASK_GUIDELINES,
    parameters: ParamsSchema,
    executionMode: 'sequential' as const,

    async execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      // 1. 校验 + 分配 id。失败直接抛，pi 转成 error toolResult，UI 从未打开。
      const questions = validateQuestions(params);

      // 2. 先注册 pending，3. 再通知 UI。顺序不能反：否则 UI 打开时 broker
      //    还没准备好，用户手快提交会被当成迟到消息丢弃。
      // 形状不对就当没给（**不抛**）：模型多写一个字段不该把整道题毙掉，而这个字段
      // 只影响界面切不切标签。真伪由渲染层按自己那份标签镜像判 —— 编一个不存在的
      // id 过来，那边找不到就只展开侧栏、不切标签。
      const raw = (params as { browserTabId?: unknown })?.browserTabId;
      const browserTabId = typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;

      const pending = broker.ask(threadId, toolCallId, questions, signal);
      shared.onOpened(toolCallId, questions, browserTabId);

      const outcome = await pending;
      shared.onClosed(toolCallId, outcome);

      return {
        content: [{ type: 'text' as const, text: renderOutcome(questions, outcome, locale) }],
        // questions 一并落盘：toolCall.arguments 里的是模型原始形状、没有 id，
        // 历史恢复要靠 details 里这份带 id 的才能和 answers 对齐。
        details: { ...outcome, questions },
        // 取消要让 pi 停下这一轮；中止时 signal 已经在终止循环，不必再设。
        ...(outcome.kind === 'cancelled' ? { terminate: true as const } : {}),
      };
    },
  };
}
