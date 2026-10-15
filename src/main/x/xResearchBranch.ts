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
const deliverySchema = z.object({
  persistence: z.enum(['saved', 'failed']),
  failureCode: z.enum(['reference', 'path', 'read', 'write', 'integrity', 'canonical']).optional(),
});

/** Hydrate only references on this exact branch; never scan siblings or rewrite JSONL. */
export async function hydrateXResearchBranch(
  entries: readonly unknown[],
  store: XResearchArtifactStore,
): Promise<{ entries: unknown[]; failures: { callId: string; reason: XArtifactFailureCode }[] }> {
  const copied = structuredClone(entries) as unknown[];
  const failures: { callId: string; reason: XArtifactFailureCode }[] = [];
  for (const entry of copied) {
    const parsed = envelope.safeParse(entry);
    if (!parsed.success) continue;
    const { message } = parsed.data;
    const { details } = message;
    const delivery = deliverySchema.safeParse(details.delivery);
    if (details.artifact === undefined && !delivery.success) continue;
    const target = (entry as { message: { details: unknown } }).message;
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
      const reason = error instanceof XResearchArtifactError ? error.code : 'read';
      failures.push({ callId: message.toolCallId, reason });
      target.details = { ...details, restoration: { status: 'missing', reason } };
    }
  }
  return { entries: copied, failures };
}
