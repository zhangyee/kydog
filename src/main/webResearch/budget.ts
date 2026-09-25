import { DEFAULT_RESEARCH_BUDGET, type ResearchBudget, type ResearchUsage } from '../../shared/webResearch';
import { candidateKey } from './urlIdentity';

export { DEFAULT_RESEARCH_BUDGET };
export type BudgetFailure = 'candidate_limit' | 'fetch_limit' | 'total_byte_limit' |
  'source_byte_limit' | 'model_call_limit' | 'cancelled';
export type Reservation = { ok: true; newCandidate?: boolean } | { ok: false; reason: BudgetFailure };

/** Synchronous reservations are atomic within a ResearchRun's event loop. */
export class ResearchBudgetMeter {
  readonly usage: ResearchUsage = { candidates: 0, fetchesDispatched: 0, receivedBytes: 0, modelCalls: 0 };
  private readonly candidateKeys = new Set<string>();
  private readonly sourceBytes = new Map<string, number>();
  private cancelled = false;

  constructor(readonly limits: ResearchBudget) {}

  cancel(): void { this.cancelled = true; }

  reserveCandidate(rawUrl: string): Reservation {
    if (this.cancelled) return { ok: false, reason: 'cancelled' };
    const key = candidateKey(rawUrl);
    if (this.candidateKeys.has(key)) return { ok: true, newCandidate: false };
    if (this.usage.candidates >= this.limits.maxCandidates) return { ok: false, reason: 'candidate_limit' };
    this.candidateKeys.add(key);
    this.usage.candidates++;
    return { ok: true, newCandidate: true };
  }

  reserveFetch(): Reservation {
    if (this.cancelled) return { ok: false, reason: 'cancelled' };
    if (this.usage.fetchesDispatched >= this.limits.maxFetches) return { ok: false, reason: 'fetch_limit' };
    this.usage.fetchesDispatched++;
    return { ok: true };
  }

  reserveModelCall(): Reservation {
    if (this.cancelled) return { ok: false, reason: 'cancelled' };
    if (this.usage.modelCalls >= this.limits.maxModelCalls) return { ok: false, reason: 'model_call_limit' };
    this.usage.modelCalls++;
    return { ok: true };
  }

  reserveBytes(sourceId: string, amount: number): Reservation {
    if (this.cancelled) return { ok: false, reason: 'cancelled' };
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('invalid byte amount');
    const nextSource = (this.sourceBytes.get(sourceId) ?? 0) + amount;
    if (nextSource > this.limits.maxBytesPerSource) return { ok: false, reason: 'source_byte_limit' };
    if (this.usage.receivedBytes + amount > this.limits.maxTotalBytes) return { ok: false, reason: 'total_byte_limit' };
    this.sourceBytes.set(sourceId, nextSource);
    this.usage.receivedBytes += amount;
    return { ok: true };
  }
}
