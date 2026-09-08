import { validateQuestions } from './askValidate';
import { questionBroker as defaultBroker, type QuestionBroker } from './questionBroker';
import type { AskSharedState } from './askUserQuestionTool';

/**
 * `browser_login` 的首次确认：spec §4.6 第 2 条那道是非题。
 *
 * **走现成的 ask broker，不新发明挂起机制。** 形状照 `askUserQuestionTool`
 * 一字不差：先 `broker.ask()` 注册 pending，**再** `shared.onOpened()` 通知 UI ——
 * 顺序反了的话 UI 打开时 broker 还没准备好，用户手快提交会被当成迟到消息丢弃。
 *
 * 与那个工具的唯一不同是**问题不是模型出的**：它是主进程按 `checkLoginHost` 的
 * 结论现拼的一道题。所以这里不收模型的任何输入，`toolCallId` 用的是
 * `browser_login` 自己那次调用的 id（UI 那一侧只要求它在本 thread 内唯一）。
 */

export type LoginConfirmArgs = {
  /** 要在上面填凭据的那个 host。**给用户看的核心事实就是它。** */
  host: string;
  /**
   * 要填的账号。**只到用户屏幕为止** —— 它不进工具结果、不进模型上下文
   * （`browser_login` 的返回值里一个字都没有它）。
   */
  username: string;
  institutionName: string;
};

/**
 * 用户点了「是」吗。
 *
 * `cancelled`（用户关掉了问题）与 `aborted`（按了停止）**一律当没确认** ——
 * 「没表态」不许被读成「同意」，押的是校园密码。
 */
export function createLoginAsk(
  threadId: string,
  shared: AskSharedState,
  broker: QuestionBroker = defaultBroker,
) {
  return async function ask(
    toolCallId: string,
    args: LoginConfirmArgs,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // 走 validateQuestions 而不是手写一份带 id 的结构：id 的分配规则只该有一处
    // （`q<i>o<j>`），而下面那句 `options[0].id` 是**结构地**取「第一个选项」，
    // 不写字面量 —— 写死 'q0o0' 的话，将来 id 规则一变，这里会静默地永远收到 false，
    // 也就是永远拒绝登录，而一条用例都不会红。
    const questions = validateQuestions({
      questions: [{
        question: `即将在 ${args.host} 上，用「${args.institutionName}」的账号 ${args.username} 填入密码并登录。`
          + `这个网址确实是「${args.institutionName}」自己的统一身份认证页吗？`,
        header: '确认登录页',
        options: [
          {
            label: '是，就在这里登录',
            description: `确认 ${args.host} 是本校的登录页。KyDog 会记住这个地址，以后不再问。`,
          },
          {
            label: '不是，别填',
            description: '不在这个页面填任何凭据。',
          },
        ],
      }],
    });
    const yesId = questions[0].options[0].id;

    const pending = broker.ask(threadId, toolCallId, questions, signal);
    shared.onOpened(toolCallId, questions);
    const outcome = await pending;
    shared.onClosed(toolCallId, outcome);

    if (outcome.kind !== 'answered') return false;
    const a = outcome.answers.find((x) => x.questionId === questions[0].id);
    return a?.kind === 'answered' && a.optionIds.includes(yesId);
  };
}

export type LoginAskFn = ReturnType<typeof createLoginAsk>;
