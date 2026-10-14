import { describe, expect, it } from 'vitest';
import { parseXResearchInput } from './xResearchInput';

const search = { objective: '查证论文讨论', queries: [{ id: 'q1', query: 'paper', purpose: '作者讨论', product: 'Latest' }] };
const read = { objective: '读取来源', targets: [{ postId: '123' }] };

describe('parseXResearchInput', () => {
  // Removing strict per-level validation must fail here, including the positive control.
  it('rejectsMixedAndLegacyInputs', () => {
    expect(parseXResearchInput({ search }).search?.objective).toBe('查证论文讨论');
    expect(parseXResearchInput({ tabId: 'tab-2', read }).read?.targets).toEqual([{ postId: '123' }]);
    for (const raw of [
      { search, read, tabId: 'tab-2' }, {}, null, [],
      { search: { ...search, tabId: 'nested' } }, { tabId: 'tab', read: { ...read, tabId: 'nested' } },
      ...['cursor', 'maxPages', 'operation', 'mystery'].flatMap((key) => [
        { search, [key]: 1 }, { search: { ...search, [key]: 1 } }, { tabId: 'tab', read: { ...read, [key]: 1 } },
      ]),
      { search: { ...search, objective: ' ' } }, { tabId: 'tab', read: { ...read, objective: '' } },
      { search: { ...search, queries: [search.queries[0], search.queries[0]] } },
      { search: { ...search, queries: [{ ...search.queries[0], extra: 1 }] } },
      { search: { ...search, queries: [{ ...search.queries[0], product: 'People' }] } },
      { search: { ...search, queries: [{ ...search.queries[0], query: '' }] } },
      { search: { ...search, queries: [] } }, { read }, { tabId: ' ', read },
      { tabId: 'tab', read: { ...read, includeArticle: 'true' } },
      { tabId: 'tab', read: { ...read, targets: [{ postId: '1', url: 'https://x.com/a/status/1' }] } },
      { tabId: 'tab', read: { ...read, targets: [{ postId: '1', extra: 1 }] } },
      { tabId: 'tab', read: { ...read, targets: [{ postId: '-1' }] } },
      { tabId: 'tab', read: { ...read, targets: [] } },
    ]) expect(() => parseXResearchInput(raw)).toThrow();
  });

  it('usesUiBudgets', () => {
    expect(parseXResearchInput({ search })).toEqual({ search: { ...search, maxPostsPerQuery: 30, maxScrollsPerQuery: 6 } });
    expect(parseXResearchInput({ tabId: 'tab', read })).toEqual({ tabId: 'tab', read: { ...read, includeArticle: true, includeReplies: true, maxRepliesPerPost: 30, maxScrollsPerPost: 6, maxExpandActionsPerPost: 6 } });
    expect(parseXResearchInput({ search: { ...search, maxPostsPerQuery: 4, maxScrollsPerQuery: 1 } }).search).toMatchObject({ maxPostsPerQuery: 4, maxScrollsPerQuery: 1 });
    expect(parseXResearchInput({ tabId: 'tab', read: { ...read, includeReplies: false, maxRepliesPerPost: 2, maxScrollsPerPost: 1, maxExpandActionsPerPost: 3 } }).read).toMatchObject({ includeReplies: false, maxRepliesPerPost: 2, maxScrollsPerPost: 1, maxExpandActionsPerPost: 3 });
    for (const [field, max] of [['maxPostsPerQuery', 100], ['maxScrollsPerQuery', 20]] as const) {
      expect(parseXResearchInput({ search: { ...search, [field]: max } }).search?.[field]).toBe(max);
      expect(parseXResearchInput({ search: { ...search, [field]: 0 } }).search?.[field]).toBe(0);
      for (const value of [max + 1, -1, 1.5, NaN, Infinity, '6', null]) expect(() => parseXResearchInput({ search: { ...search, [field]: value } })).toThrow();
    }
    for (const [field, max] of [['maxRepliesPerPost', 100], ['maxScrollsPerPost', 20], ['maxExpandActionsPerPost', 20]] as const) {
      expect(parseXResearchInput({ tabId: 'tab', read: { ...read, [field]: max } }).read?.[field]).toBe(max);
      expect(parseXResearchInput({ tabId: 'tab', read: { ...read, [field]: 0 } }).read?.[field]).toBe(0);
      for (const value of [max + 1, -1, 1.5, NaN, Infinity, '6', null]) expect(() => parseXResearchInput({ tabId: 'tab', read: { ...read, [field]: value } })).toThrow();
    }
    const queries = Array.from({ length: 6 }, (_, i) => ({ ...search.queries[0], id: `q${i}` }));
    expect(parseXResearchInput({ search: { ...search, queries } }).search?.queries).toHaveLength(6);
    expect(() => parseXResearchInput({ search: { ...search, queries: [...queries, { ...queries[0], id: 'q7' }] } })).toThrow();
    const targets = Array.from({ length: 20 }, (_, i) => ({ postId: `${i + 1}` }));
    expect(parseXResearchInput({ tabId: 'tab', read: { ...read, targets, includeReplies: false, includeArticle: false } }).read).toMatchObject({ targets, includeReplies: false, includeArticle: false });
    expect(() => parseXResearchInput({ tabId: 'tab', read: { ...read, targets: [...targets, { postId: '21' }] } })).toThrow();
  });

  it('validatesExplicitPostSourcesWithoutGeneratingUrlsFromIds', () => {
    for (const url of ['https://x.com/alice/status/123', 'https://twitter.com/i/web/status/123', 'https://x.com/alice/status/123/photo/1?s=20']) {
      expect(parseXResearchInput({ tabId: 'tab', read: { ...read, targets: [{ url }] } }).read?.targets).toEqual([{ url }]);
    }
    expect(parseXResearchInput({ tabId: 'tab', read }).read?.targets).toEqual([{ postId: '123' }]);
    for (const url of ['http://x.com/a/status/1', 'https://x.com.evil/a/status/1', 'https://evil.com/a/status/1', 'https://user:password@x.com/a/status/1', 'https://x.com:444/a/status/1', 'https://x.com/search?q=a', 'https://x.com/a/status/no', 'not a url']) {
      expect(() => parseXResearchInput({ tabId: 'tab', read: { ...read, targets: [{ url }] } })).toThrow();
    }
  });
});


it('uses the official public identity boundary before I/O without rewriting literal input',()=>{
  const handle='Ab_0123456789xy', maximum='18446744073709551615';
  const parse=(url:string)=>parseXResearchInput({tabId:'tab',read:{...read,targets:[{url}]}});
  for(const route of ['', '/', '/history', '/history/', '/photo/1', '/video/2/']) {
    const url=`https://twitter.com/${handle}/status/${maximum}${route}?s=20`;
    expect(parse(url).read?.targets).toEqual([{url}]);
    expect(()=>parse(url.replace(handle,handle+'z'))).toThrow();
    expect(()=>parse(url.replace(maximum,'18446744073709551616'))).toThrow();
  }
  for(const url of ['https://X.com/a/status/0','https://x.com/i/web/status/1/history','https://x.com/i/web/status/1/photo/9']) expect(parse(url).read?.targets).toEqual([{url}]);
  for(const value of [maximum,'0','00001']) expect(parseXResearchInput({tabId:'tab',read:{...read,targets:[{postId:value}]}}).read?.targets).toEqual([{postId:value}]);
  for(const value of ['18446744073709551616','0'.repeat(21),'-1']) expect(()=>parseXResearchInput({tabId:'tab',read:{...read,targets:[{postId:value}]}})).toThrow();
});
