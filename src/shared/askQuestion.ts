/** 工具名。主进程分派、批次判定、历史恢复都靠它，不要散落字面量。 */
export const ASK_TOOL_NAME = 'ask_user_question';

/** 模型提交的形状：没有 id。模型不可信，id 一律由主进程分配。 */
export type RawAskOption = {
  label: string;
  description: string;
  recommended?: boolean;
};

export type RawAskQuestion = {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: RawAskOption[];
};

/** 主进程分配 id 后的形状。下游只认这个。 */
export type AskOption = RawAskOption & { id: string };

export type AskQuestion = {
  id: string;
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskOption[];
};

export type AskAnswer =
  | { questionId: string; kind: 'answered'; optionIds: string[]; custom?: string }
  | { questionId: string; kind: 'skipped' };

export type AskOutcome =
  | { kind: 'answered'; answers: AskAnswer[] }
  | { kind: 'cancelled' }
  | { kind: 'aborted' };

/**
 * 历史恢复时用来判断 toolResult 的 details 是不是合法 AskOutcome。
 * 校验失败 / 批次非法留下的 error toolResult 的 details 是 `{}`，
 * 必须被这个守卫挡住，否则会造出无效的 ask block。
 */
export function isAskOutcome(v: unknown): v is AskOutcome {
  if (!v || typeof v !== 'object') return false;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === 'cancelled' || kind === 'aborted') return true;
  if (kind !== 'answered') return false;
  return Array.isArray((v as { answers?: unknown }).answers);
}
