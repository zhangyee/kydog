import { expect, it } from 'vitest';
import {
  canonicalizeXResearchResult,
  finalizeXResearchCollection,
  parseXResearchCanonical,
} from './xResearchCanonical';
import {
  fixture,
  post,
  readHtml,
  searchHtml,
  searchInput,
  stagedFixture,
} from '../../test-support/xResearchFixture';
import { searchX, searchResult } from './xResearchSearch';
import { readX } from './xResearchRead';

it('retains full public bodies, histories and collection facts without sharing mutable objects', async () => {
  const raw = await searchX(searchInput, fixture([searchHtml(post())]).context);
  const row = raw.queries[0];
  row.posts[0].text = '汉字😀\n'.repeat(240000);
  row.posts[0].truncation = {
    returned: row.posts[0].text.length,
    totalKnown: row.posts[0].text.length,
    truncated: false,
  };
  row.postObservations = [
    { ...structuredClone(row.posts[0]), observationId: 'history' },
  ];
  row.budgetBinding = [
    { dimension: 'posts', used: 500, limit: 500, origin: 'default' },
  ];
  row.sampleTruncation = { observed: 502, sampled: 500, omitted: 2 };
  row.collectionStop = {
    status: 'partial',
    stopReason: 'budget_reached',
    reason: null,
  };
  const canonical = canonicalizeXResearchResult(raw);
  expect(canonical).toEqual(raw);
  expect(
    parseXResearchCanonical(JSON.parse(JSON.stringify(canonical))),
  ).toEqual(raw);
  canonical.objective = 'changed';
  expect(raw.objective).toBe('research');
});

it('projects unknown private payloads before serialization and preserves Article identity', async () => {
  const raw = await readX(
    {
      tabId: 'research-tab',
      read: {
        objective: 'Article',
        targets: [{ url: 'https://x.com/alice/status/123' }],
        includeArticle: true,
        includeReplies: true,
        maxRepliesPerPost: 10,
        maxScrollsPerPost: 0,
        maxExpandActionsPerPost: 3,
      },
    },
    (await stagedFixture({ article: 'ok' })).context,
  );
  const entry = raw.targets[0].article.entry!;
  expect(entry.binding.snapshotId).toEqual(expect.any(String));
  const secret = {
    token: 'PRIVATE',
    callback: () => {},
    map: new WeakMap(),
    snapshot: { nodes: [] },
  };
  Object.assign(raw, { private: secret });
  Object.assign(raw.targets[0], { private: secret });
  Object.assign(raw.targets[0].root!, { private: secret });
  Object.assign(raw.targets[0].diagnostics!, { private: secret });
  const canonical = canonicalizeXResearchResult(raw);
  expect(canonical.operation).toBe('read');
  if (canonical.operation !== 'read') throw new Error('read expected');
  expect(canonical.targets[0].article.entryIdentity).toEqual({
    entryObservationId: entry.observationId,
    parentPostId: entry.parentPostId,
    sourceUrl: entry.sourceUrl,
    targetUrl: entry.targetUrl,
  });
  expect(canonical.targets[0].article.entry).toBeNull();
  expect(canonical.targets[0].article.body).toEqual(
    raw.targets[0].article.body,
  );
  expect(raw.targets[0].root!.articlePreviews).toHaveLength(1);
  expect(canonical.targets[0].root!.articlePreviews).toEqual(
    raw.targets[0].root!.articlePreviews,
  );
  expect(canonical.targets[0].diagnostics).toEqual(
    Object.fromEntries(
      Object.entries(raw.targets[0].diagnostics!).filter(
        ([key]) => key !== 'private',
      ),
    ),
  );
  expect(JSON.stringify(raw)).toContain('PRIVATE');
  expect(JSON.stringify(canonical)).not.toContain('PRIVATE');
  expect(parseXResearchCanonical(canonical)).toEqual(canonical);
});

it('accepts a pre-navigation empty result and rejects malformed public fields', async () => {
  const empty = searchResult(searchInput, fixture([]).context);
  expect(empty.browserTabId).toBe('');
  expect(parseXResearchCanonical(empty)).toEqual(empty);
  const raw = await readX(
    {
      tabId: 'tab',
      read: {
        objective: 'read',
        targets: [{ url: 'https://x.com/alice/status/123' }],
        includeArticle: false,
        includeReplies: false,
        maxRepliesPerPost: 0,
        maxScrollsPerPost: 0,
        maxExpandActionsPerPost: 0,
      },
    },
    fixture([readHtml(post())]).context,
  );
  expect(parseXResearchCanonical(raw)).toMatchObject({ operation: 'read' });
  for (const mutate of [
    (v: typeof raw) => {
      v.targets[0].root!.containerKind = 'reply';
    },
    (v: typeof raw) => {
      v.targets[0].budgetUsage.scrolls = -1;
    },
    (v: typeof raw) => {
      v.targets[0].replies.scope.completeness = 'ui_scope_end_observed';
    },
    (v: typeof raw) => {
      v.targets[0].root!.articlePreviewInventory = {
        scope: 'collection',
        observed: 2,
        retained: 0,
        omitted: 0,
        unresolved: 0,
      };
    },
  ]) {
    const bad = structuredClone(raw);
    mutate(bad);
    expect(() => parseXResearchCanonical(bad)).toThrow();
  }
});

it('retains historical serialized scope aggregates with sparse count maps', async () => {
  const { serializeXResearchResult } = await import('./xResearchOutput');
  const raw = await searchX(searchInput, fixture([searchHtml(post())]).context);
  // Historical v2 predates collectionStop/delivery. Keep that compatibility path explicit.
  for (const row of raw.queries) delete row.collectionStop;
  const history = serializeXResearchResult(raw).result;
  expect(history.reportScopeFacts!.totalRows).toBe(1);
  expect(parseXResearchCanonical(history)).toEqual(history);
});

it('preserves declared direct Article provenance without retaining private native capabilities', async () => {
  const raw = await readX(
    {
      tabId: 'research-tab',
      read: {
        objective: 'read',
        targets: [{ url: 'https://x.com/alice/status/123' }],
        includeArticle: true,
        includeReplies: false,
        maxRepliesPerPost: 0,
        maxScrollsPerPost: 0,
        maxExpandActionsPerPost: 3,
      },
    },
    (await stagedFixture({ article: 'ok' })).context,
  );
  const body = raw.targets[0].article.body!;
  const provenance = {
    kind: 'direct_open' as const,
    navigationId: 'actual-navigation',
    bodyObservationId: body.observationId,
    sourceUrl: body.sourceUrl!,
    nativeIdentity: {
      kind: 'owned_analytics' as const,
      href: '/bob/status/456/analytics',
      documentGeneration: '1:1:3',
    },
  };
  raw.targets[0].article.provenance = structuredClone(provenance);
  Object.assign(raw.targets[0].article.provenance.nativeIdentity!, {
    permission: 'PRIVATE-NATIVE',
    callback: () => {},
  });
  expect(JSON.stringify(raw)).toContain('PRIVATE-NATIVE');
  const canonical = canonicalizeXResearchResult(raw);
  if (canonical.operation !== 'read') throw new Error('read expected');
  expect(canonical.targets[0].article.provenance).toEqual(provenance);
  expect(JSON.stringify(canonical)).not.toContain('PRIVATE-NATIVE');
});

it('finalizes full sampled body units before delivery, preserving unknown source totals', async()=>{
 const raw=await readX({tabId:'tab',read:{objective:'units',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post('123','alice','汉😀'))]).context);
 const root=raw.targets[0].root!;
 raw.targets[0].bodyObservations=[{...structuredClone(root),observationId:'history',text:'old',truncation:{returned:3,totalKnown:5,truncated:true}}];
 const finalized=finalizeXResearchCollection(raw);
 expect(finalized.truncation).toEqual({returned:6,totalKnown:8,truncated:true});
 expect(raw.truncation).toEqual({returned:0,totalKnown:0,truncated:false});
 raw.truncation={returned:0,totalKnown:null,truncated:true};
 expect(finalizeXResearchCollection(raw).truncation).toEqual({returned:6,totalKnown:null,truncated:true});
 raw.truncation={returned:0,totalKnown:0,truncated:false};
 root.truncation.totalKnown=null;
 expect(finalizeXResearchCollection(raw).truncation).toEqual({returned:6,totalKnown:null,truncated:true});
});

it('preserves explicit aggregate unknown independently of truncation when every body total is known',async()=>{
 const raw=await readX({tabId:'tab',read:{objective:'unknown aggregate',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post('123','alice','汉😀'))]).context);
 expect(raw.targets[0].root!.truncation).toEqual({returned:3,totalKnown:3,truncated:false});
 expect(finalizeXResearchCollection(raw).truncation).toEqual({returned:3,totalKnown:3,truncated:false});
 raw.truncation={returned:0,totalKnown:null,truncated:false};
 expect(finalizeXResearchCollection(raw).truncation).toEqual({returned:3,totalKnown:null,truncated:false});
});
