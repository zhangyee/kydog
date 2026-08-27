import type { AskOutcome, AskQuestion } from '../../shared/askQuestion';

/**
 * 界面语言。与 settings.ui.locale 结构相同（'zh' | 'en'），但不直接 import
 * SettingsFile —— 本仓库对每个只关心 zh/en 二选一的模块都各自声明一个同构别名
 * （见 harness/templates.ts 的 HarnessLocale、skills/localeProjection.ts 的
 * SkillLocale），避免把纯文案模块和 shared/types 的完整 settings 形状耦合。
 */
export type AskLocale = 'zh' | 'en';

type AskCopy = {
  /** outcome.kind === 'cancelled' 时的整段文本 */
  cancelled: string;
  /** outcome.kind === 'aborted' 时的整段文本 */
  aborted: string;
  /** 单题被跳过（或 answers 里缺席）时的占位说明 */
  skipped: string;
  /** 列表最前面的表头 */
  header: string;
  /** 多选项 label 之间的连接符 */
  join: string;
  /** 选中项之后再接自由文本时的连接语 */
  customPrefix: string;
};

// 两份文案 + Record<AskLocale, ...> 查表，写法对齐 harness/templates.ts（量小，不必再拆文件）。
const COPY: Record<AskLocale, AskCopy> = {
  zh: {
    cancelled: '用户关闭了提问，未作回答。',
    aborted: '提问被中止，用户未作回答。',
    skipped: '（用户跳过了这一题）',
    header: '用户回答：',
    join: '、',
    customPrefix: '；另外用户补充：',
  },
  en: {
    cancelled: 'The user closed the prompt without answering.',
    aborted: 'The prompt was aborted; the user did not answer.',
    skipped: '(the user skipped this question)',
    header: "User's answers:",
    join: ', ',
    customPrefix: '; the user also added: ',
  },
};

/**
 * 把结果渲染成模型能读的文本。三种 outcome 各有各的说法，不合并。
 * 纯函数：locale 由调用方传入，这里不读 settings —— 这也是它能被直接测试的原因。
 */
export function renderOutcome(questions: AskQuestion[], outcome: AskOutcome, locale: AskLocale): string {
  const t = COPY[locale];
  if (outcome.kind === 'cancelled') return t.cancelled;
  if (outcome.kind === 'aborted') return t.aborted;

  const byId = new Map(outcome.answers.map((a) => [a.questionId, a]));
  const lines = questions.map((q) => {
    const a = byId.get(q.id);
    if (!a || a.kind === 'skipped') return `- ${q.question} → ${t.skipped}`;

    const labelById = new Map(q.options.map((o) => [o.id, o.label]));
    const picked = a.optionIds.map((id) => labelById.get(id) ?? id).join(t.join);
    const custom = typeof a.custom === 'string' ? a.custom.trim() : '';

    if (picked && custom) return `- ${q.question} → ${picked}${t.customPrefix}${custom}`;
    if (picked) return `- ${q.question} → ${picked}`;
    return `- ${q.question} → ${custom}`;
  });

  return [t.header, ...lines].join('\n');
}
