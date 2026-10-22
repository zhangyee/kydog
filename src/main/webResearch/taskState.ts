import type { SourceExtraction } from '../../shared/webResearch';
import type { BrowserTrigger, WebResearchSourceState, WebResearchTaskRecord,
  WebResearchTaskSnapshot, WebResearchTaskSource } from '../../shared/webResearchTask';
import type { FetchResult } from './fetchSource';
import type { BodyResult } from './researchRun';

export type { BrowserTrigger } from '../../shared/webResearchTask';

function isCsdn521(finalUrl: string | undefined, statusCode: number | undefined): boolean {
  if (statusCode !== 521 || !finalUrl) return false;
  try {
    const url = new URL(finalUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === 'blog.csdn.net';
  } catch { return false; }
}

/** Route only observed browser requirements; legacy failures require explicit resume. */
export function browserTrigger(input: {
  source: WebResearchTaskSource; fetch?: FetchResult; body?: BodyResult;
  extraction?: SourceExtraction; legacyResume?: boolean;
}): BrowserTrigger | undefined {
  const { source, fetch, body, extraction } = input;
  if (fetch?.status === 'needs_browser') return 'fetch_needs_browser';
  if (body?.status === 'needs_browser') return 'body_needs_browser';
  if (fetch && isCsdn521(fetch.finalUrl, fetch.statusCode)) return 'csdn_http_521';
  if (extraction?.sourceId === source.sourceId && extraction.reason === 'needs_browser' &&
    extraction.barriers?.some((barrier) => barrier.quote.length > 0 && source.passages.some((passage) =>
      passage.sourceId === source.sourceId && passage.passageId === barrier.passageId &&
      passage.text.includes(barrier.quote)))) return 'grounded_barrier';
  if (input.legacyResume && (['script_only_or_no_article', 'verification_widget', 'needs_browser']
    .includes(source.reason ?? '') || isCsdn521(source.finalUrl, source.statusCode))) return 'legacy_record';
  return undefined;
}

export function isOutstandingSource(status: WebResearchSourceState): boolean {
  return status === 'queued' || status === 'fetching' || status === 'extracting' ||
    status === 'browser_queued' || status === 'browser_reading' || status === 'waiting_user';
}

export function buildTaskSnapshot(task: WebResearchTaskRecord, sources: Iterable<WebResearchTaskSource>): WebResearchTaskSnapshot {
  const all = [...sources].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sourceId.localeCompare(b.sourceId));
  const counts = { discoveries: task.discoveryCount ?? all.reduce((n, s) => n + s.discoveries.length, 0),
    sources: all.length, queued: 0, fetching: 0, extracting: 0, completed: 0,
    browser_queued: 0, browser_reading: 0, waiting_user: 0,
    failed: 0, cancelled: 0, unprocessed: 0, processed: 0, evidenceReady: 0,
    irrelevant: 0, claims: 0, evidence: 0 };
  const siteMap = new Map<string, WebResearchTaskSnapshot['sites'][number]>();
  for (const source of all) {
    counts[source.status]++;
    if (source.status === 'completed' || source.status === 'failed' || source.status === 'cancelled' ||
      source.status === 'unprocessed') counts.processed++;
    counts.claims += source.extraction?.claims.length ?? 0;
    counts.evidence += source.extraction?.evidence.length ?? 0;
    if (source.status === 'completed' && source.extraction?.evidence.some((evidence) =>
      evidence.verification === 'grounded')) counts.evidenceReady++;
    else if (source.status === 'completed' && source.extraction?.status === 'irrelevant') counts.irrelevant++;
    try {
      const domain = new URL(source.finalUrl ?? source.requestedUrl).hostname.toLowerCase();
      const current = siteMap.get(domain) ?? { domain, sourceCount: 0, processed: 0, iconAvailable: false };
      current.sourceCount++;
      if (source.status === 'completed' || source.status === 'failed' || source.status === 'cancelled' ||
        source.status === 'unprocessed') current.processed++;
      current.iconAvailable ||= Boolean(source.siteIconUrl);
      siteMap.set(domain, current);
    } catch { /* source URLs were validated before enqueue; tolerate legacy records */ }
  }
  return { researchRunId: task.researchRunId, threadId: task.threadId,
    originalQuestion: task.originalQuestion, revision: task.revision,
    status: task.status, statusReason: task.statusReason, reportPath: task.reportPath,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
    budget: { ...task.budget }, usage: { ...task.usage }, browserDomBytes: task.browserDomBytes ?? 0, counts,
    sites: [...siteMap.values()].sort((a, b) => a.domain.localeCompare(b.domain)) };
}
