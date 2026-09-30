import { describe, expect, it } from 'vitest';
import { makeSearchObservation, confirmSearchTarget } from './searchObservation';

const input = { threadId: 'thread', tabId: 'tab', engineId: 'bing' as const,
  query: 'architecture', angleIds: ['a'], searchPageUrl: 'https://www.bing.com/search?q=architecture',
  executionPath: 'search_url' as const, inputSubmitted: true, navigationConfirmed: true,
  resultsExtracted: true, executionFacts: {
    startUrl: 'https://www.bing.com/search?q=architecture',
    endUrl: 'https://www.bing.com/search?q=architecture', successfulWaits: [],
  },
  rowTruncation: { truncated: false, returned: 2, totalKnown: 2 },
  rows: [{ title: 'Tracked', url: 'https://www.bing.com/ck/a?id=1', snippet: 'snippet' },
    { title: 'Direct', url: 'https://docs.example/guide', snippet: 'guide' }] };

describe('IAB search observation', () => {
  it('rejects labeling a Bing page as a Google search', () => {
    expect(() => makeSearchObservation({ ...input, engineId: 'google' })).toThrow('engine');
  });
  it('keeps a search-engine tracking href unresolved while retaining an external direct href', () => {
    const observation = makeSearchObservation(input);
    expect(observation).toMatchObject({
      executionPath: 'search_url', inputSubmitted: true, navigationConfirmed: true,
      resultsExtracted: true, executionFacts: {
        startUrl: 'https://www.bing.com/search?q=architecture',
        endUrl: 'https://www.bing.com/search?q=architecture', successfulWaits: [],
      },
    });
    expect(observation.rows[0]).toMatchObject({ rawHref: 'https://www.bing.com/ck/a?id=1' });
    expect(observation.rows[0].targetUrl).toBeUndefined();
    expect(observation.rows[1].targetUrl).toBe('https://docs.example/guide');
  });

  it('keeps Baidu tracking links unresolved across http/https origin differences', () => {
    const observation = makeSearchObservation({ ...input, engineId: 'baidu',
      searchPageUrl: 'https://www.baidu.com/s?wd=architecture', rows: [
        { title: 'Tracked', url: 'http://www.baidu.com/link?url=opaque' },
        { title: 'Observed engine redirect', url: '/link?url=two',
          targetUrl: 'https://www.baidu.com/link?url=two' },
        { title: 'Direct', url: 'https://docs.example/guide' },
      ], rowTruncation: { truncated: false, returned: 3, totalKnown: 3 } });
    expect(observation.rows.map((row) => row.targetUrl)).toEqual([
      undefined, undefined, 'https://docs.example/guide',
    ]);
  });

  it('does not turn extracted link text into a result URL', () => {
    const valid = makeSearchObservation({ ...input, rows: [
      { title: 'Tracked', url: '/ck/a?id=1' },
    ] });
    expect(valid.status).toBe('results');
    expect(valid.rows).toHaveLength(1);
    expect(valid.rows[0].rawHref).toBe('/ck/a?id=1');

    const invalid = makeSearchObservation({ ...input, status: 'results', rows: [
      { title: 'The starting point for learning TypeScript',
        url: 'The starting point for learning TypeScript\n\nTypeScript\nhttps://www.typescriptlang.org › docs' },
    ] });
    expect(invalid.rows).toHaveLength(0);
    expect(invalid.status).toBe('extraction_error');
  });

  it('accepts only the IAB-opened tracking link destination for its exact row', () => {
    const observation = makeSearchObservation(input);
    expect(() => confirmSearchTarget(observation, 0, 'https://wrong.example/', 'https://docs.example/final'))
      .toThrow('requested URL');
    expect(() => confirmSearchTarget(observation, 0, 'https://www.bing.com/ck/a?id=1',
      'https://www.bing.com/ck/a?id=1')).toThrow('destination');
    const confirmed = confirmSearchTarget(observation, 0, 'https://www.bing.com/ck/a?id=1',
      'https://docs.example/final');
    expect(confirmed.rows[0].targetUrl).toBe('https://docs.example/final');
    expect(confirmed.rows[0].rawHref).toBe('https://www.bing.com/ck/a?id=1');
  });

  it('does not confirm a search-engine-owned destination on another scheme or subdomain', () => {
    const observation = makeSearchObservation(input);
    expect(() => confirmSearchTarget(observation, 0, 'https://www.bing.com/ck/a?id=1',
      'http://cn.bing.com/ck/a?id=1')).toThrow('destination');
  });

  it('rejects execution facts containing a non-http start or end URL', () => {
    expect(() => makeSearchObservation({ ...input, executionFacts: {
      ...input.executionFacts, startUrl: 'file:///tmp/search.html',
    } })).toThrow('execution');
    expect(() => makeSearchObservation({ ...input, executionFacts: {
      ...input.executionFacts, endUrl: 'javascript:alert(1)',
    } })).toThrow('execution');
  });
});
