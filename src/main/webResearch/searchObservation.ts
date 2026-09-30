import { randomUUID } from 'node:crypto';
import type { ExtractRow, ExtractResult } from '../browser/extract';
import type { SearchEngineId } from '../../shared/webResearch';
import type { SearchExecutionFacts, SearchExecutionPath, SearchObservation,
  SearchExecutionFailure, SearchObservationRow } from '../../shared/webResearchTask';

export type SearchObservationInput = {
  threadId: string;
  tabId: string;
  engineId: SearchEngineId;
  query: string;
  angleIds: string[];
  status?: SearchObservation['status'];
  executionPath: SearchExecutionPath;
  inputSubmitted: boolean;
  navigationConfirmed: boolean;
  resultsExtracted: boolean;
  executionFacts: SearchExecutionFacts;
  failure?: SearchExecutionFailure;
  searchPageUrl: string;
  rowTruncation: ExtractResult['rowTruncation'];
  rows: ExtractRow[];
};

function httpUrl(raw: string, base?: string): string | undefined {
  // Search result URLs may be absolute or explicitly relative. Bare link text is
  // not a URL reference, even when new URL(text, base) accepts it as a path.
  if (base && !/^(?:https?:\/\/|\/|\.\.?\/|\?)/i.test(raw.trim())) return undefined;
  try {
    const url = new URL(raw, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export const ENGINE_HOST: Record<SearchEngineId, string> = {
  google: 'google.com', bing: 'bing.com', duckduckgo: 'duckduckgo.com', baidu: 'baidu.com',
};

export function hostBelongsToEngine(rawUrl: string, engineId: SearchEngineId): boolean {
  const host = new URL(rawUrl).hostname.toLowerCase();
  const engineHost = ENGINE_HOST[engineId];
  return host === engineHost || host.endsWith(`.${engineHost}`);
}

/** Record actual IAB extraction, keeping engine-owned tracking links unresolved. */
export function makeSearchObservation(input: SearchObservationInput): SearchObservation {
  const searchPageUrl = httpUrl(input.searchPageUrl);
  const startUrl = httpUrl(input.executionFacts.startUrl);
  const endUrl = httpUrl(input.executionFacts.endUrl);
  if (!searchPageUrl || !input.query.trim() || !input.angleIds.length ||
    input.angleIds.some((id) => !id.trim())) throw new Error('invalid search observation');
  if (!startUrl || !endUrl) throw new Error('invalid search execution facts');
  const host = new URL(searchPageUrl).hostname;
  const engineHost = ENGINE_HOST[input.engineId];
  if (host !== engineHost && !host.endsWith(`.${engineHost}`)) throw new Error('search engine page mismatch');
  const rows: SearchObservationRow[] = [];
  for (const row of input.rows) {
    const rawHref = row.url ?? row.href ?? row.link;
    if (!rawHref || rawHref.includes('…[截断')) continue;
    const resolved = httpUrl(rawHref, searchPageUrl);
    if (!resolved) continue;
    const observedTarget = row.targetUrl ? httpUrl(row.targetUrl, searchPageUrl) : undefined;
    const target = observedTarget && !hostBelongsToEngine(observedTarget, input.engineId)
      ? observedTarget : !hostBelongsToEngine(resolved, input.engineId) ? resolved : undefined;
    rows.push({ rawHref, targetUrl: target, title: row.title ?? undefined,
      snippet: row.snippet ?? undefined });
  }
  const status = input.status === 'results' && rows.length === 0
    ? 'extraction_error' : input.status ?? (rows.length ? 'results' : 'extraction_error');
  if (status !== 'results' && rows.length) throw new Error('non-result observation contains rows');
  return { observationId: randomUUID(), threadId: input.threadId, tabId: input.tabId,
    engineId: input.engineId, attemptId: randomUUID(), query: input.query,
    searchPageUrl, angleIds: [...input.angleIds], status, createdAt: new Date().toISOString(),
    executionPath: input.executionPath, inputSubmitted: input.inputSubmitted,
    navigationConfirmed: input.navigationConfirmed, resultsExtracted: input.resultsExtracted,
    executionFacts: { ...input.executionFacts, startUrl, endUrl,
      successfulWaits: input.executionFacts.successfulWaits.map((wait) => ({ ...wait })) },
    ...(input.failure ? { failure: { ...input.failure } } : {}),
    rowTruncation: input.rowTruncation, rows };
}

/** The requested URL must be the saved row's href; the final URL comes from IAB navigation. */
export function confirmSearchTarget(observation: SearchObservation, resultIndex: number,
  requestedUrl: string, finalUrl: string): SearchObservation {
  const row = observation.rows[resultIndex];
  if (!row) throw new Error('search result not found');
  const raw = httpUrl(row.rawHref, observation.searchPageUrl);
  if (!raw || httpUrl(requestedUrl) !== raw) throw new Error('requested URL does not match observed href');
  const final = httpUrl(finalUrl);
  if (!final || hostBelongsToEngine(final, observation.engineId)) {
    throw new Error('IAB did not observe a target destination');
  }
  const rows = [...observation.rows];
  rows[resultIndex] = { ...row, targetUrl: final };
  return { ...observation, rows };
}
