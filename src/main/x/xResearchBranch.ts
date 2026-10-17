import { z } from 'zod';
import {
  XResearchArtifactError,
  type XResearchArtifactStore,
} from './xResearchArtifacts';
import type { XArtifactRef, XArtifactFailureCode } from './xResearchTypes';

const envelope = z.object({
  type: z.literal('message'),
  message: z.object({
    role: z.literal('toolResult'),
    toolName: z.literal('x_research'),
    toolCallId: z.string().min(1),
    isError: z.literal(false),
    details: z.record(z.string(), z.unknown()),
  }),
});
/** 结果自己的落盘记录：旧平铺 details 的 `delivery` 与壳里 `result.delivery` 同一形状。 */
const deliverySchema = z.object({
  persistence: z.enum(['saved', 'failed']),
  failureCode: z.enum(['reference', 'path', 'read', 'write', 'integrity', 'canonical']).optional(),
});
/** 交付壳（`./xResearchTaskShell`，spec §4.5）：结果在 `delivery.result`，`submit` / `inspect` /
 *  `cancel` 的壳里没有 `delivery` —— 它们没有可恢复的结果。 */
const shellSchema = z.object({
  kind: z.literal('x_research'),
  delivery: z
    .object({
      deliveryCallId: z.string().min(1),
      submissionId: z.string().min(1),
      submitCallId: z.string().min(1),
      operation: z.enum(['search', 'read']),
      result: z.record(z.string(), z.unknown()),
    })
    .optional(),
});
const reasonOf = (error: unknown): XArtifactFailureCode =>
  error instanceof XResearchArtifactError ? error.code : 'read';

/** Hydrate only references on this exact branch; never scan siblings or rewrite JSONL.
 *  store 只要读：恢复链从不写工件（写只有任务根一个归属，见 `createXResearchThreadArtifactStore`）。 */
export async function hydrateXResearchBranch(
  entries: readonly unknown[],
  store: Pick<XResearchArtifactStore, 'read'>,
): Promise<{ entries: unknown[]; failures: { callId: string; reason: XArtifactFailureCode }[] }> {
  const copied = structuredClone(entries) as unknown[];
  const failures: { callId: string; reason: XArtifactFailureCode }[] = [];
  for (const entry of copied) {
    const parsed = envelope.safeParse(entry);
    if (!parsed.success) continue;
    const { message } = parsed.data;
    const { details } = message;
    const target = (entry as { message: { details: unknown } }).message;
    const shell = shellSchema.safeParse(details);
    if (shell.success) {
      const { delivery } = shell.data;
      if (!delivery) continue;
      const result = delivery.result;
      // 已经恢复过的那一份：工件里存的 canonical 既没有 `artifact` 也没有自己的 `delivery`
      // 字段（与平铺路径同一个判据），别把「已恢复」继续说成「没落盘」。
      if (result.artifact === undefined && result.delivery === undefined) continue;
      try {
        if (result.artifact === undefined) {
          // 没落盘的那一份：失败码由结果自己的 `delivery` 记着（旧路径同一判据）。
          const own = deliverySchema.safeParse(result.delivery);
          throw new XResearchArtifactError(
            own.success && own.data.persistence === 'failed'
              ? own.data.failureCode ?? 'write'
              : 'reference',
            'Full collection was not persisted',
          );
        }
        const ref = result.artifact as XArtifactRef;
        // `deliveryCallId` 是交付这一轮（= 这条工具结果），`result.callId` 是**提交**那一轮：两者
        // 不许混着用 —— 壳的完整性判据就是这两条连同 `batchId` 一起对得上。
        if (delivery.deliveryCallId !== message.toolCallId ||
            result.callId !== delivery.submitCallId ||
            result.operation !== delivery.operation ||
            !ref || ref.callId !== result.callId || ref.runId !== result.runId ||
            ref.batchId !== result.batchId || ref.operation !== result.operation) {
          throw new XResearchArtifactError(
            'reference',
            'Artifact does not belong to this tool result',
          );
        }
        target.details = { ...details, delivery: { ...delivery, result: await store.read(ref) } };
      } catch (error) {
        const reason = reasonOf(error);
        failures.push({ callId: message.toolCallId, reason });
        // 恢复不了也要留一行：交付副本还在，但它省略的 Article 义务已经说不清了。
        target.details = {
          ...details,
          delivery: { ...delivery, result: { ...result, restoration: { status: 'missing', reason } } },
        };
      }
      continue;
    }
    // 改造前的平铺 details：历史证据必须照旧恢复。
    const delivery = deliverySchema.safeParse(details.delivery);
    if (details.artifact === undefined && !delivery.success) continue;
    try {
      if (details.artifact === undefined) {
        throw new XResearchArtifactError(
          delivery.success && delivery.data.persistence === 'failed'
            ? delivery.data.failureCode ?? 'write'
            : 'reference',
          'Full collection was not persisted',
        );
      }
      const ref = details.artifact as XArtifactRef;
      if (!ref || details.callId !== message.toolCallId || ref.callId !== message.toolCallId ||
          ref.runId !== details.runId || ref.batchId !== details.batchId || ref.operation !== details.operation) {
        throw new XResearchArtifactError('reference', 'Artifact does not belong to this tool result');
      }
      target.details = await store.read(ref);
    } catch (error) {
      const reason = reasonOf(error);
      failures.push({ callId: message.toolCallId, reason });
      target.details = { ...details, restoration: { status: 'missing', reason } };
    }
  }
  return { entries: copied, failures };
}
