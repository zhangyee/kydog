import { describe, expect, it } from 'vitest';
import type { SourceExtraction } from '../../shared/webResearch';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET, type WebResearchSourceState,
  type WebResearchTaskRecord, type WebResearchTaskSource } from '../../shared/webResearchTask';
import type { FetchResult } from './fetchSource';
import type { BodyResult } from './researchRun';
import { browserTrigger, buildTaskSnapshot, isOutstandingSource } from './taskState';

const source: WebResearchTaskSource = {
  sourceId: 'source-a', requestedUrl: 'https://entry.example/start',
  finalUrl: 'https://blog.csdn.net/author/article/details/1', status: 'failed',
  createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z', discoveries: [],
  passages: [{ sourceId: 'source-a', passageId: 'p1', ordinal: 1, text: 'Security verification required.' }],
};
const csdn521: FetchResult = {
  requestedUrl: 'https://entry.example/start', finalUrl: 'https://blog.csdn.net/author/article/details/1',
  status: 'http_error', statusCode: 521, redirectChain: [], bytes: new Uint8Array(), receivedBytes: 0,
};
const body: BodyResult = { status: 'needs_browser', passages: [], completeness: 'unknown' };
const barrier: SourceExtraction = { sourceId: 'source-a', status: 'failed', reason: 'needs_browser',
  claims: [], evidence: [], examinedPassageIds: ['p1'], gaps: [],
  barriers: [{ passageId: 'p1', quote: 'Security verification' }] };
const task: WebResearchTaskRecord = {
  researchRunId: 'run', threadId: 'thread', createdByRunId: 'agent', projectRoot: '/project',
  originalQuestion: 'Question?', createdAt: source.createdAt, updatedAt: source.updatedAt,
  revision: 7, status: 'running', angles: [], attempts: [], observationIds: [], discoveryCount: 3,
  budget: { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET },
  usage: { candidates: 2, fetchesDispatched: 2, receivedBytes: 113, modelCalls: 1 },
};

describe('browserTrigger', () => {
  it.each([
    { input: { fetch: { ...csdn521, status: 'needs_browser' as const } }, want: 'fetch_needs_browser' },
    { input: { body }, want: 'body_needs_browser' },
    { input: { fetch: csdn521 }, want: 'csdn_http_521' },
    { input: { extraction: barrier }, want: 'grounded_barrier' },
  ])('routes only exact browser facts: $want', ({ input, want }) => {
    expect(browserTrigger({ source, ...input })).toBe(want);
  });

  it('uses the actual final hostname and excludes unrelated failure facts', () => {
    expect(browserTrigger({ source, fetch: csdn521 })).toBe('csdn_http_521');
    for (const finalUrl of ['https://blog.csdn.net.evil.example/article', 'https://other.example/article', undefined]) {
      expect(browserTrigger({ source: { ...source, requestedUrl: csdn521.finalUrl! },
        fetch: { ...csdn521, requestedUrl: csdn521.finalUrl!, finalUrl } })).toBeUndefined();
    }
    for (const statusCode of [200, 404, 429]) {
      expect(browserTrigger({ source, fetch: { ...csdn521, statusCode } })).toBeUndefined();
    }
    for (const [status, reason] of [
      ['unsupported_media', 'pdf_not_supported'], ['network_error', 'unsafe_url'],
      ['network_error', 'request_failed'], ['unreadable', 'source_byte_limit'],
      ['unreadable', 'total_byte_limit'], ['unreadable', 'fetch_limit'],
    ] as const) {
      expect(browserTrigger({ source, fetch: { ...csdn521, status, reason, statusCode: undefined } })).toBeUndefined();
    }
    expect(browserTrigger({ source, body })).toBe('body_needs_browser');
    expect(browserTrigger({ source, body: { ...body, status: 'unsupported_media' } })).toBeUndefined();
  });

  it('requires a barrier quote grounded in this source and its matching passage', () => {
    expect(browserTrigger({ source, extraction: barrier })).toBe('grounded_barrier');
    for (const extraction of [
      { ...barrier, barriers: [] }, { ...barrier, barriers: undefined },
      { ...barrier, sourceId: 'unrelated-source' }, { ...barrier, reason: 'invalid_model_output' },
      { ...barrier, barriers: [{ passageId: 'missing', quote: 'Security verification' }] },
      { ...barrier, barriers: [{ passageId: 'p1', quote: 'invented challenge' }] },
      { ...barrier, barriers: [{ passageId: 'p1', quote: '' }] },
    ]) expect(browserTrigger({ source, extraction })).toBeUndefined();
    expect(browserTrigger({ source: { ...source, passages: [{ ...source.passages[0], sourceId: 'other' }] },
      extraction: barrier })).toBeUndefined();
  });

  it.each(['script_only_or_no_article', 'verification_widget', 'needs_browser'])('revives the exact legacy reason only on explicit resume: %s', (reason) => {
    const legacy = { ...source, reason };
    expect(browserTrigger({ source: legacy, legacyResume: true })).toBe('legacy_record');
    expect(browserTrigger({ source: legacy, legacyResume: false })).toBeUndefined();
    expect(browserTrigger({ source: { ...legacy, reason: `${reason} extra` }, legacyResume: true })).toBeUndefined();
  });

  it('uses saved CSDN status only on explicit legacy resume and actual final host', () => {
    const legacy = { ...source, statusCode: 521, reason: 'HTTP 521' };
    expect(browserTrigger({ source: legacy, legacyResume: true })).toBe('legacy_record');
    expect(browserTrigger({ source: legacy, legacyResume: false })).toBeUndefined();
    expect(browserTrigger({ source: { ...legacy, finalUrl: 'https://other.example/article',
      requestedUrl: source.finalUrl! }, legacyResume: true })).toBeUndefined();
  });
});

describe('buildTaskSnapshot', () => {
  it.each(['browser_queued', 'browser_reading', 'waiting_user'] as const)('keeps %s outstanding and out of processed totals at both task and site level', (status) => {
    const completed = { ...source, sourceId: 'completed', status: 'completed' as const };
    const waiting = { ...source, sourceId: 'waiting', status };
    const snapshot = buildTaskSnapshot(task, [completed, waiting]);
    expect(snapshot.counts).toMatchObject({ processed: 1, failed: 0, completed: 1, [status]: 1 });
    expect(snapshot.sites).toEqual([{ domain: 'blog.csdn.net', sourceCount: 2, processed: 1, iconAvailable: false }]);
    expect(isOutstandingSource('completed')).toBe(false);
    expect(isOutstandingSource(status)).toBe(true);
  });

  it('defaults new counters and DOM bytes while preserving old terminal states and HTTP usage', () => {
    const statuses: WebResearchSourceState[] = ['queued', 'fetching', 'extracting', 'completed', 'failed', 'cancelled', 'unprocessed'];
    const snapshot = buildTaskSnapshot(task, statuses.map((status) => ({ ...source, sourceId: status, status })));
    expect(snapshot.counts).toMatchObject({ processed: 4, failed: 1, cancelled: 1, unprocessed: 1,
      browser_queued: 0, browser_reading: 0, waiting_user: 0 });
    expect(snapshot.browserDomBytes).toBe(0);
    expect(snapshot.usage.receivedBytes).toBe(113);
    expect(buildTaskSnapshot({ ...task, browserDomBytes: 77 }, []).browserDomBytes).toBe(77);
    expect(statuses.map(isOutstandingSource)).toEqual([true, true, true, false, false, false, false]);
  });
});
