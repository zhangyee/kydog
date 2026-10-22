import type { ResearchBudget } from '../../shared/webResearch';

/** Browser snapshots are cumulative document bytes, independent of HTTP transfer bytes. */
export class BrowserDomBudget {
  private total: number;
  private readonly sources: Map<string, number>;
  constructor(private readonly limits: ResearchBudget, taskBytes: number, sourceBytes: ReadonlyMap<string, number>) {
    if ([taskBytes, ...sourceBytes.values()].some((bytes) => !Number.isSafeInteger(bytes) || bytes < 0)) {
      throw new Error('invalid browser DOM usage');
    }
    this.sources = new Map(sourceBytes);
    this.total = Math.max(taskBytes, [...sourceBytes.values()].reduce((sum, bytes) => sum + bytes, 0));
  }
  remaining(sourceId: string): number {
    return Math.max(0, Math.min(this.limits.maxBytesPerSource - (this.sources.get(sourceId) ?? 0),
      this.limits.maxTotalBytes - this.total));
  }
  record(sourceId: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid browser DOM bytes');
    const source = (this.sources.get(sourceId) ?? 0) + bytes;
    if (source > this.limits.maxBytesPerSource) throw new Error('browser_source_dom_limit');
    if (this.total + bytes > this.limits.maxTotalBytes) throw new Error('browser_total_dom_limit');
    this.sources.set(sourceId, source); this.total += bytes;
  }
}
