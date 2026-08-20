import type { AskAnswer, AskQuestion, RawAskQuestion } from '../../shared/askQuestion';

/** 校验失败一律抛这个；工具层不 catch，让 pi 转成 error toolResult 回给模型。 */
export class AskValidationError extends Error {}

function fail(msg: string): never {
  throw new AskValidationError(msg);
}

function nonEmpty(v: unknown, field: string, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(`${where} 的 ${field} 不能为空`);
  return (v as string).trim();
}

/**
 * 校验模型提交的问题并按下标分配 id。
 * 纯函数：同样的输入永远得到同样的 id，可重放。
 */
export function validateQuestions(input: unknown): AskQuestion[] {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) fail('questions 必须是数组');
  // 题数上限 10：UI 是一题一屏、靠 cursor 翻页（QuestionComposer.tsx），加题只是
  // 多翻几屏，没有布局约束——10 是访谈深度的产品选择，不是技术上限。
  if (raw.length < 1 || raw.length > 10) fail('questions 只能有 1–10 条');

  const seenQuestions = new Set<string>();
  const out: AskQuestion[] = [];

  raw.forEach((item, qi) => {
    const rq = item as RawAskQuestion;
    const where = `第 ${qi + 1} 题`;

    const question = nonEmpty(rq?.question, 'question', where);
    if (seenQuestions.has(question)) fail(`${where} 的 question 与前面的重复：${question}`);
    seenQuestions.add(question);

    const header = nonEmpty(rq?.header, 'header', where);
    if (header.length > 12) fail(`${where} 的 header 不能超过 12 个字符：${header}`);

    // 选项上限 8：数字键快捷键选选项，QuestionComposer.tsx 用 1..N 选中第 N 项，
    // 第 N+1 个数字留给「其他」（聚焦自定义输入框）。到 8 时「其他」是 9，仍在
    // 单键范围内；再多一个「其他」就要按两位数的 10，单键按不出来——所以封顶 8。
    if (!Array.isArray(rq?.options) || rq.options.length < 2 || rq.options.length > 8) {
      fail(`${where} 的 options 只能有 2–8 个`);
    }

    const seenLabels = new Set<string>();
    let recommendedCount = 0;
    const options = rq.options.map((ro, oi) => {
      const label = nonEmpty(ro?.label, 'label', `${where} 第 ${oi + 1} 个选项`);
      if (seenLabels.has(label)) fail(`${where} 的 label 重复：${label}`);
      seenLabels.add(label);
      const description = nonEmpty(ro?.description, 'description', `${where} 第 ${oi + 1} 个选项`);
      if (ro.recommended === true) recommendedCount += 1;
      return {
        id: `q${qi}o${oi}`,
        label,
        description,
        ...(ro.recommended === true ? { recommended: true as const } : {}),
      };
    });
    if (recommendedCount > 1) fail(`${where} 只能有一个选项标记 recommended`);

    out.push({
      id: `q${qi}`,
      question,
      header,
      ...(rq.multiSelect === true ? { multiSelect: true as const } : {}),
      options,
    });
  });

  return out;
}

/**
 * 校验 renderer 提交上来的答案，并返回**规范化后**的副本。
 *
 * IPC 是运行时边界，不能相信 renderer 的自律。任一条不过就抛错，RPC 返回失败，
 * UI 保持打开让用户重来。
 *
 * 返回值而不是 void：`custom` 的 trim 结果必须留在这里、成为下游唯一认的形状。
 * 否则未 trim 的原文会一路落盘进 AskOutcome，「custom 存 trim 后的文本」这条
 * 就只能靠渲染层自觉——而这道边界存在的理由恰恰是不能靠它自觉。
 */
export function validateAnswers(questions: AskQuestion[], answers: AskAnswer[]): AskAnswer[] {
  if (!Array.isArray(answers)) fail('answers 必须是数组');

  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const normalized: AskAnswer[] = [];

  for (const a of answers) {
    const q = byId.get(a?.questionId);
    if (!q) fail(`未知的 questionId：${a?.questionId}`);
    if (seen.has(a.questionId)) fail(`questionId 重复：${a.questionId}`);
    seen.add(a.questionId);

    if (a.kind === 'skipped') { normalized.push({ questionId: q.id, kind: 'skipped' }); continue; }
    if (a.kind !== 'answered') fail(`未知的答案 kind：${(a as { kind?: string }).kind}`);

    if (!Array.isArray(a.optionIds)) fail(`${q.id} 的 optionIds 必须是数组`);
    // 非字符串的 custom 要当场拒绝，不能当空串放行：它会一路落盘，
    // 最后在渲染留痕卡片时 `custom.trim()` 崩掉。
    if (a.custom !== undefined && typeof a.custom !== 'string') {
      fail(`${q.id} 的 custom 必须是字符串`);
    }

    const validIds = new Set(q.options.map((o) => o.id));
    const seenOpts = new Set<string>();
    for (const oid of a.optionIds) {
      if (!validIds.has(oid)) fail(`optionId ${oid} 不属于 ${q.id}`);
      if (seenOpts.has(oid)) fail(`${q.id} 的 optionId 重复：${oid}`);
      seenOpts.add(oid);
    }

    const custom = a.custom?.trim() ?? '';
    if (!q.multiSelect) {
      if (a.optionIds.length > 1) fail(`${q.id} 是单选题，只能选一个`);
      if (a.optionIds.length > 0 && custom !== '') fail(`${q.id} 是单选题，选项与 custom 互斥`);
    }
    if (a.optionIds.length === 0 && custom === '') {
      fail(`${q.id} 至少要有一个选项或非空的 custom`);
    }

    normalized.push({
      questionId: q.id,
      kind: 'answered',
      optionIds: [...a.optionIds],
      ...(custom === '' ? {} : { custom }),
    });
  }

  // 依赖「questions 里 id 互异」：未知 id 与重复 id 都已在循环里拒掉，
  // 所以 seen ⊆ 全体 id 且无重复，size 相等即等价于每题都有终态。
  // 万一 id 不互异，|全体 id| < questions.length 会让这里恒为真——
  // 方向是安全的（恒拒绝），不会误放行。别改成 byId.size，那样反而会漏。
  if (seen.size !== questions.length) fail('提交时每道题都要有终态（已答或已跳过）');

  return normalized;
}
