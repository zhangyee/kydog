import type { AskQuestion, RawAskQuestion } from '../../shared/askQuestion';

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
  if (raw.length < 1 || raw.length > 4) fail('questions 只能有 1–4 条');

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

    if (!Array.isArray(rq?.options) || rq.options.length < 2 || rq.options.length > 4) {
      fail(`${where} 的 options 只能有 2–4 个`);
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
