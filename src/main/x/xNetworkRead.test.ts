import { describe, expect, it, vi } from 'vitest';
import first from '../../test-support/fixtures/x-network/read-thread-0.json';
import next from '../../test-support/fixtures/x-network/read-thread-1.json';
import recency from '../../test-support/fixtures/x-network/read-thread-2.json';
import expanded from '../../test-support/fixtures/x-network/read-expanded-0.json';
import quoted from '../../test-support/fixtures/x-network/read-expanded-1.json';
import branch from '../../test-support/fixtures/x-network/read-expanded-2.json';
import terminal from '../../test-support/fixtures/x-network/read-expanded-3.json';
import {
  decodeXReadResponse,
  type XReadNetworkRequest,
} from './xNetworkSource';
import { XNetworkReadLease } from './xNetworkLease';
import type {
  BrowserNetworkEvent,
  BrowserNetworkRequest,
} from '../browser/networkResponses';
const provenance = {
  leaseId: 'lease',
  requestRef: 'request',
  navigationId: 'nav',
  documentEpoch: 2,
  routeRevision: 3,
  navigationSequence: 4,
  operation: 'TweetDetail',
  observedAt: '2026-10-15T00:00:00Z',
};
function request(
  f: {
    request: { focalTweetId: string; rankingMode: string; cursor?: string };
  },
  collectReplies = true,
): XReadNetworkRequest {
  return {
    provenance,
    postId: f.request.focalTweetId,
    inputCursor: f.request.cursor ?? null,
    branchKey: null,
    sortKey: f.request.rankingMode,
    collectReplies,
  };
}
describe('recorded read decoding', () => {
  it('keeps root and direct replies distinct from nested parent and unrelated identities', () => {
    const a = decodeXReadResponse(first.body, request(first));
    expect(a.root).toMatchObject({
      postId: '9100000000001',
      sourceKind: 'page_graphql',
      text: 'Captured read text 1',
    });
    expect(a.replies.length).toBeGreaterThan(30);
    expect(a.outputCursor).toBe(next.request.cursor);
    expect(a.end).toBe('unknown');
    expect(a.unsupported).toEqual([]);
    const b = decodeXReadResponse(next.body, request(next));
    expect(b.root).toBeNull();
    expect(b.replies.length).toBeGreaterThan(30);
    const c = decodeXReadResponse(expanded.body, request(expanded));
    expect(c.replies.find((p) => p.postId === '910000000000171')).toMatchObject(
      {
        directParent: { postId: '910000000000170' },
        conversationId: '910000000000169',
      },
    );
    expect(c.unscopedPosts.length).toBeGreaterThan(0);
    expect(c.replies.every((p) => p.containerKind === 'reply')).toBe(true);
  });
  it('decodes actual quotes, long notes and Article presence without merging them into replies', () => {
    const a = decodeXReadResponse(first.body, request(first));
    expect(a.quotedPosts.length).toBeGreaterThan(0);
    const b = decodeXReadResponse(quoted.body, request(quoted));
    expect(b.quotedPosts.length).toBe(3);
    expect(
      b.quotedPosts.some((p) => p.articlePreviewInventory?.unresolved === 1),
    ).toBe(true);
    for (const q of b.quotedPosts)
      expect(b.replies.some((p) => p.observationId === q.observationId)).toBe(
        false,
      );
  });
  it('does not touch nonroot text when replies are disabled; root and own quote stay independent', () => {
    expect(
      decodeXReadResponse(first.body, request(first)).replies.length,
    ).toBeGreaterThan(0);
    const changed = structuredClone(first.body) as any;
    for (const ins of changed.data.threaded_conversation_with_injections_v2
      .instructions)
      for (const e of ins.entries ?? [])
        for (const child of e.content.items ?? []) {
          const t = child.item.itemContent?.tweet_results?.result;
          if (t)
            Object.defineProperty(t.legacy, 'full_text', {
              get() {
                throw Error('nonroot text read');
              },
            });
        }
    const a = decodeXReadResponse(changed, request(first, false));
    expect(a.root?.text).toBe('Captured read text 1');
    expect(a.replies).toEqual([]);
    expect(a.unscopedPosts).toEqual([]);
  });
  it('retains both terminal and cursor evidence without turning Top or unknown context into end', () => {
    const a = decodeXReadResponse(terminal.body, {
      ...request(terminal),
      branchKey: 'ShowMoreThreads',
    });
    expect(a).toMatchObject({
      end: 'cursor_exhausted',
      terminationDirections: ['Bottom'],
      branchKey: 'ShowMoreThreads',
      sortKey: 'Relevance',
    });
    expect(a.outputCursor).toBeTruthy();
    expect(decodeXReadResponse(first.body, request(first)).end).toBe('unknown');
    expect(decodeXReadResponse(terminal.body, request(terminal)).end).toBe(
      'unknown',
    );
    expect(
      decodeXReadResponse(branch.body, request(branch)).continuationKind,
    ).toBe('ShowMoreThreads');
    expect(decodeXReadResponse(recency.body, request(recency)).sortKey).toBe(
      'Recency',
    );
  });
});
const location = {
  currentUrl: `https://x.com/ReadAuthor/status/${first.request.focalTweetId}`,
  documentEpoch: 2,
  routeRevision: 3,
  navigationSequence: 4,
  navigationEvent: 'did-navigate' as const,
  navigationType: 'cross_document' as const,
  navigationUrl: null,
};
function raw(
  variables: object = first.request,
  patch: Partial<BrowserNetworkRequest> = {},
): BrowserNetworkRequest {
  return {
    id: 'a',
    requestId: 'a',
    sessionId: null,
    isMainFrame: true,
    redirectIndex: 0,
    frameId: 'f',
    loaderId: 'l',
    navigationId: 'nav',
    location: { ...location },
    method: 'GET',
    url:
      'https://x.com/i/api/graphql/dynamic/TweetDetail?variables=' +
      encodeURIComponent(JSON.stringify(variables)),
    ...patch,
  };
}
function harness() {
  const events: BrowserNetworkEvent[] = [];
  const lease = new XNetworkReadLease(
    first.request.focalTweetId,
    location.currentUrl,
    true,
  );
  const source = {
    id: 's',
    tabId: 'tab',
    drain: vi.fn(async () => events.splice(0)),
    take: vi.fn(async () => {
      const e = events.shift();
      if (!e) throw Error('timeout');
      return e;
    }),
    close: vi.fn(async () => {}),
  };
  lease.bind(source);
  const emit = (r: BrowserNetworkRequest, body: object) =>
    events.push({
      kind: 'response',
      request: r,
      status: 200,
      retryAfterMs: null,
      body: JSON.stringify(body),
      bytes: 1,
      sha256: 'a'.repeat(64),
    });
  return { lease, source, events, emit };
}
it('accepts rootless exact continuation and rejects changed target/sort/source before new data admission', async () => {
  for (const patch of [
    { location: { ...location, routeRevision: 99 } },
    { navigationId: 'wrong' },
    { loaderId: 'wrong' },
    {
      location: {
        ...location,
        currentUrl: 'https://x.com/ReadAuthor/status/999',
      },
    },
  ]) {
    const h = harness();
    expect(h.lease.accepts(raw())).toBe(true);
    h.emit(raw(), first.body);
    const a = await h.lease.collect(location);
    expect(a.pages[0].root?.postId).toBe(first.request.focalTweetId);
    expect(h.lease.accepts(raw(next.request, { id: 'b' }))).toBe(true);
    h.emit(raw(next.request, { id: 'b' }), next.body);
    expect(
      (await h.lease.collect(location)).pages[0].replies.length,
    ).toBeGreaterThan(0);
    expect(
      h.lease.accepts(
        raw(
          {
            ...next.request,
            cursor: decodeXReadResponse(next.body, request(next)).outputCursor,
          },
          { id: 'bad', ...patch },
        ),
      ),
    ).toBe(false);
    expect(a.pages[0].root?.postId).toBe(first.request.focalTweetId);
  }
  for (const vars of [
    { ...next.request, focalTweetId: '999' },
    { ...next.request, rankingMode: 'Recency' },
    { ...next.request, cursor: 'wrong' },
  ]) {
    const h = harness();
    expect(h.lease.accepts(raw())).toBe(true);
    h.emit(raw(), first.body);
    expect((await h.lease.collect(location)).pages[0].root).toBeTruthy();
    expect(h.lease.accepts(raw(vars, { id: 'bad' }))).toBe(false);
  }
});
it('commits accepted read facts synchronously before cancellation and rejects late invalidated successors', async () => {
  const h = harness(),
    controller = new AbortController();
  let current = { ...location };
  const saved: string[] = [];
  expect(h.lease.accepts(raw())).toBe(true);
  h.emit(raw(), first.body);
  await h.lease.collect(
    location,
    controller.signal,
    () => current,
    (p) => {
      saved.push(p.root!.text);
      controller.abort();
    },
  );
  expect(saved).toEqual(['Captured read text 1']);
  const g = harness();
  expect(g.lease.accepts(raw())).toBe(true);
  g.emit(raw(), first.body);
  const a = await g.lease.collect(location);
  expect(a.pages[0].root).toBeTruthy();
  const r = raw(next.request, { id: 'b' });
  expect(g.lease.accepts(r)).toBe(true);
  g.source.take.mockImplementationOnce(async () => {
    current = { ...location, routeRevision: 99 };
    g.emit(r, next.body);
    return g.events.shift()!;
  });
  expect(
    await g.lease.collect(location, undefined, () => current),
  ).toMatchObject({ pages: [], failure: 'generation_changed' });
  expect(a.pages[0].root).toBeTruthy();
});

it('retains an unrecorded shape as a page fact instead of aborting the proven cursor chain', async () => {
  const malformed = (extra: object[], dropCursors = false) => {
    const body = structuredClone(first.body) as any;
    const instructions =
      body.data.threaded_conversation_with_injections_v2.instructions;
    for (const instruction of instructions) {
      if (!instruction.entries) continue;
      instruction.entries = instruction.entries.filter(
        (e: any) => !dropCursors || e.content?.entryType !== 'TimelineTimelineCursor',
      );
      instruction.entries.push(...structuredClone(extra));
    }
    return body;
  };
  const unrecorded = { content: { entryType: 'TimelineTimelineItem', itemContent: null } };
  const h = harness();
  expect(h.lease.accepts(raw())).toBe(true);
  h.emit(raw(), malformed([unrecorded]));
  const a = await h.lease.collect(location);
  expect(a.pages).toHaveLength(1);
  expect(a.pages[0].root?.postId).toBe(first.request.focalTweetId);
  expect(a.pages[0].unsupported).toContain('item_shape');
  expect(a.failure).toBeUndefined();
  const successor = raw(next.request, { id: 'b' });
  expect(h.lease.accepts(successor)).toBe(true);
  h.emit(successor, next.body);
  const b = await h.lease.collect(location);
  expect(b.pages[0].replies.length).toBeGreaterThan(0);
  // Same page without a usable cursor still fails closed on the cursor, not on the shape.
  const noCursor = harness();
  expect(noCursor.lease.accepts(raw())).toBe(true);
  noCursor.emit(raw(), malformed([unrecorded], true));
  const failed = await noCursor.lease.collect(location);
  expect(failed.pages[0].unsupported).toContain('item_shape');
  expect(failed.failure).toBe('cursor_not_advanced');
});

it('saves rootless pages once, retains proven history after invalidation, and binds reply budget at acceptance', async () => {
  const { readResult } = await import('./xResearchRead');
  const { acceptReadNetworkPage, savePostFrame } =
    await import('./xResearchReadStages');
  const { fixture, readHtml } =
    await import('../../test-support/xResearchFixture');
  const input = {
    tabId: 'tab',
    read: {
      objective: 'test',
      targets: [{ url: location.currentUrl }],
      includeArticle: false,
      includeReplies: true,
      maxRepliesPerPost: 40,
      maxScrollsPerPost: 2,
      maxExpandActionsPerPost: 0,
    },
  };
  const f = fixture([readHtml('')]);
  const row = readResult(input, f.context).targets[0];
  const a = decodeXReadResponse(first.body, request(first));
  const b = decodeXReadResponse(next.body, {
    ...request(next),
    provenance: { ...provenance, requestRef: 'next' },
  });
  const fact = (p: typeof a) => ({
    provenance: p.provenance,
    bytes: 1,
    sha256: 'a'.repeat(64),
    inputCursorRef: null,
    outputCursorRef: 'cursor',
    end: p.end,
    observed: p.posts.length,
    sampled: p.posts.length,
    omitted: 0,
    unsupported: [],
  });
  acceptReadNetworkPage(row, a, fact(a), input.read, f.context);
  expect(row.root?.text).toBe('Captured read text 1');
  expect(row.identity).toMatchObject({
    state: 'proven',
    postId: first.request.focalTweetId,
  });
  acceptReadNetworkPage(row, b, fact(b), input.read, f.context);
  expect(row.replies.observations).toHaveLength(40);
  expect(row.budgetBinding).toContainEqual({
    dimension: 'replies',
    limit: 40,
    used: 40,
    origin: 'explicit',
  });
  acceptReadNetworkPage(row, b, fact(b), input.read, f.context);
  expect(row.networkPages).toHaveLength(2);
  await f.open(location.currentUrl);
  const observed = await f.page.collect({
    stage: 'post',
    expectedUrl: location.currentUrl,
    postId: first.request.focalTweetId,
  });
  observed.network = { pages: [], proof: provenance };
  observed.identityProven = true;
  expect(savePostFrame(row, observed, input.read, f.context)).toBe(true);
  observed.identityProven = false;
  observed.network.failure = 'generation_changed';
  expect(savePostFrame(row, observed, input.read, f.context)).toBe(false);
  expect(row.root?.text).toBe('Captured read text 1');
  expect(row.identity?.state).toBe('proven');
});

it('rejects an unrecorded null item instead of silently treating it as wire evidence', () => {
  expect(decodeXReadResponse(first.body, request(first)).unsupported).toEqual(
    [],
  );
  const altered = structuredClone(first.body) as any;
  const entries =
    altered.data.threaded_conversation_with_injections_v2.instructions.find(
      (i: any) => i.entries,
    ).entries;
  entries.push({
    content: { entryType: 'TimelineTimelineItem', itemContent: null },
  });
  expect(decodeXReadResponse(altered, request(first)).unsupported).toContain(
    'item_shape',
  );
});

it('samples reply and independent source posts in wire order and never retains omitted-parent quotes', async () => {
  const { readResult } = await import('./xResearchRead');
  const { acceptReadNetworkPage } = await import('./xResearchReadStages');
  const { fixture } = await import('../../test-support/xResearchFixture');
  const page = decodeXReadResponse(expanded.body, request(expanded));
  const context = fixture([]).context;
  const limits = {
    objective: 'sample',
    targets: [{ postId: expanded.request.focalTweetId }],
    includeArticle: false,
    includeReplies: true,
    maxRepliesPerPost: 1,
    maxScrollsPerPost: 2,
    maxExpandActionsPerPost: 0,
  };
  const row = readResult({ tabId: 'tab', read: limits }, context).targets[0];
  const fact = {
    provenance: page.provenance,
    bytes: 1,
    sha256: 'a'.repeat(64),
    inputCursorRef: null,
    outputCursorRef: 'cursor',
    end: page.end,
    observed: 0,
    sampled: 0,
    omitted: 0,
    unsupported: [],
  };
  acceptReadNetworkPage(row, page, fact, limits, context);
  const saved = [
    ...row.replies.observations,
    ...(row.unscopedPosts?.observations ?? []),
  ];
  expect(saved.map((p) => p.observationId)).toEqual(
    page.sampleOrder!.slice(0, 1),
  );
  expect(row.sampleTruncation).toEqual({
    observed: page.sampleOrder!.length,
    sampled: 1,
    omitted: page.sampleOrder!.length - 1,
  });
  expect(fact).toMatchObject(row.sampleTruncation!);
  expect(row.budgetBinding).toContainEqual({
    dimension: 'replies',
    limit: 1,
    used: 1,
    origin: 'explicit',
  });
  // Repeated post IDs in different relation/body observations cannot collapse the
  // wire order back to replies-first partition order.
  const ordered = structuredClone(page);
  const replyA = { ...page.replies[0], observationId: 'reply-a' };
  const replyB = { ...page.replies[1], observationId: 'reply-b' };
  const independentA = {
    ...page.unscopedPosts[0],
    postId: replyA.postId!,
    observationId: 'independent-a',
  };
  ordered.replies = [replyA, replyB];
  ordered.unscopedPosts = [independentA];
  ordered.sampleOrder = [
    replyB.observationId,
    independentA.observationId,
    replyA.observationId,
  ];
  const orderedRow = readResult({ tabId: 'tab', read: limits }, context)
    .targets[0];
  acceptReadNetworkPage(orderedRow, ordered, { ...fact }, limits, context);
  expect(orderedRow.replies.observations.map((p) => p.observationId)).toEqual([
    'reply-b',
  ]);
  expect(orderedRow.sampleTruncation).toEqual({
    observed: 3,
    sampled: 1,
    omitted: 2,
  });
  // Derived pressure variant uses an actual quoted node owned by an omitted reply.
  const withQuotes = decodeXReadResponse(first.body, request(first));
  const all = readResult(
    {
      tabId: 'tab',
      read: {
        ...limits,
        targets: [{ postId: first.request.focalTweetId }],
        maxRepliesPerPost: 1000,
      },
    },
    context,
  ).targets[0];
  acceptReadNetworkPage(
    all,
    withQuotes,
    undefined,
    { ...limits, maxRepliesPerPost: 1000 },
    context,
  );
  expect(all.quotedPosts.length).toBeGreaterThan(0);
  const capped = readResult(
    {
      tabId: 'tab',
      read: { ...limits, targets: [{ postId: first.request.focalTweetId }] },
    },
    context,
  ).targets[0];
  acceptReadNetworkPage(capped, withQuotes, undefined, limits, context);
  expect(capped.quotedPosts).toEqual([]);
});

it('keeps actual hidden-branch terminal facts while account context and live scope remain unknown', async () => {
  const { readResult } = await import('./xResearchRead');
  const { acceptReadNetworkPage } = await import('./xResearchReadStages');
  const { fixture } = await import('../../test-support/xResearchFixture');
  const url = `https://x.com/ReadAuthor/status/${expanded.request.focalTweetId}`,
    facts = { ...location, currentUrl: url };
  const lease = new XNetworkReadLease(expanded.request.focalTweetId, url, true);
  const events: BrowserNetworkEvent[] = [];
  lease.bind({
    id: 'source',
    tabId: 'tab',
    drain: async () => events.splice(0),
    take: async () => {
      throw Error('unused');
    },
    close: async () => {},
  });
  const context = fixture([]).context,
    limits = {
      objective: 'branch',
      targets: [{ url }],
      includeArticle: false,
      includeReplies: true,
      maxRepliesPerPost: 1000,
      maxScrollsPerPost: 1,
      maxExpandActionsPerPost: 0,
    };
  const row = readResult({ tabId: 'tab', read: limits }, context).targets[0];
  for (const [index, capture] of [
    expanded,
    quoted,
    branch,
    terminal,
  ].entries()) {
    const source = raw(capture.request, {
      id: 'page' + index,
      location: facts,
    });
    expect(lease.accepts(source), `page ${index}`).toBe(true);
    events.push({
      kind: 'response',
      request: source,
      status: 200,
      retryAfterMs: null,
      body: JSON.stringify(capture.body),
      bytes: 1,
      sha256: 'a'.repeat(64),
    });
    const batch = await lease.collect(facts, undefined, undefined, (p, f) =>
      acceptReadNetworkPage(row, p, f, limits, context),
    );
    expect(batch.pages).toHaveLength(1);
    expect(batch.pages[0].unsupported, `page ${index}`).toEqual([]);
  }
  expect(row.networkPages?.at(-1)).toMatchObject({
    end: 'cursor_exhausted',
    readContext: {
      accountContextId: null,
      branchKey: 'ShowMoreThreads',
      sortKey: 'Relevance',
      continuationKind: 'Bottom',
      terminationDirections: ['Bottom'],
    },
  });
  expect(row.replies.scope).toMatchObject({
    kind: 'network',
    extent: 'unknown',
    terminalRequestRef: null,
    context: {
      accountContextId: null,
      branchKey: 'ShowMoreThreads',
      sortKey: 'Relevance',
    },
  });
});

it('validates complete source scope and preserves old rendered UI end history without upgrading it', async () => {
  const { readResult } = await import('./xResearchRead');
  const { canonicalizeXResearchResult } = await import('./xResearchCanonical');
  const { fixture } = await import('../../test-support/xResearchFixture');
  const { XResearchEvidence } = await import('./xResearchEvidence');
  const context = fixture([]).context,
    limits = {
      objective: 'scope',
      targets: [{ postId: '123' }],
      includeArticle: false,
      includeReplies: true,
      maxRepliesPerPost: 2,
      maxScrollsPerPost: 1,
      maxExpandActionsPerPost: 0,
    };
  const result = readResult({ tabId: 'tab', read: limits }, context);
  expect(result.targets[0].replies.scope).toMatchObject({
    kind: 'network',
    rootPostId: null,
    context: { leaseId: null, accountContextId: null },
    extent: 'unknown',
  });
  expect(() => canonicalizeXResearchResult(result)).not.toThrow();
  const row = result.targets[0];
  row.replies.scope = {
    kind: 'network',
    rootPostId: '123',
    extent: 'cursor_exhausted',
    context: {
      leaseId: 'lease',
      accountContextId: 'future-proven-account-context',
      branchKey: 'ShowMoreThreads',
      sortKey: 'Relevance',
    },
    terminalRequestRef: 'request',
    stopReason: 'cursor_exhausted',
  };
  row.networkPages = [
    {
      provenance,
      bytes: 1,
      sha256: 'a'.repeat(64),
      inputCursorRef: 'cursor-in',
      outputCursorRef: 'cursor-out',
      end: 'cursor_exhausted',
      observed: 0,
      sampled: 0,
      omitted: 0,
      unsupported: [],
      readContext: {
        rootPostId: '123',
        accountContextId: 'future-proven-account-context',
        branchKey: 'ShowMoreThreads',
        sortKey: 'Relevance',
        continuationKind: 'Bottom',
        terminationDirections: ['Bottom'],
      },
    },
  ];
  expect(() => canonicalizeXResearchResult(result)).not.toThrow();
  for (const mutate of [
    (s: any) => (s.context.accountContextId = null),
    (s: any) => (s.context.leaseId = 'other'),
    (s: any) => (s.context.branchKey = 'other'),
    (s: any) => (s.context.sortKey = 'Recency'),
    (s: any) => (s.rootPostId = '999'),
    (s: any) => (s.terminalRequestRef = 'other'),
  ]) {
    const bad = structuredClone(result);
    mutate(bad.targets[0].replies.scope);
    expect(() => canonicalizeXResearchResult(bad)).toThrow();
  }
  const legacy = structuredClone(result);
  delete legacy.targets[0].networkPages;
  legacy.targets[0].replies.scope = {
    rootPostId: '123',
    branch: null,
    sort: null,
    displayedReplyCount: null,
    completeness: 'ui_scope_end_observed',
    stopReason: 'explicit_ui_end',
    endEvidence: {
      observationId: 'old-end',
      text: 'End of visible branch',
      sourceUrl: 'https://x.com/a/status/123',
      observedAt: 'then',
      rootPostId: '123',
      branch: null,
      sort: null,
    },
  };
  const restored = canonicalizeXResearchResult(legacy);
  if (restored.operation !== 'read') throw Error('read');
  expect(restored.targets[0].replies.scope).toMatchObject({
    completeness: 'ui_scope_end_observed',
  });
  expect(restored.targets[0].replies.scope).not.toHaveProperty('extent');
  const ledger = new XResearchEvidence('/tmp', () => 'run');
  ledger.restore([
    {
      type: 'message',
      id: 'history',
      message: {
        role: 'toolResult',
        toolName: 'x_research',
        toolCallId: 'call',
        details: legacy,
        content: [],
        isError: false,
      },
    },
  ]);
});

it('caps accepted pages cumulatively across leases before retaining any excess root or body version', async () => {
  const { readResult } = await import('./xResearchRead');
  const { acceptReadNetworkPage } = await import('./xResearchReadStages');
  const { fixture } = await import('../../test-support/xResearchFixture');
  const context = fixture([]).context;
  const limits = {
    objective: 'page cap',
    targets: [{ postId: first.request.focalTweetId }],
    includeArticle: false,
    includeReplies: false,
    maxRepliesPerPost: 0,
    maxScrollsPerPost: 2,
    maxExpandActionsPerPost: 0,
  };
  const row = readResult({ tabId: 'tab', read: limits }, context).targets[0],
    original = decodeXReadResponse(first.body, request(first, false));
  for (let index = 0; index < 1002; index++) {
    const proof = {
      ...provenance,
      leaseId: index < 500 ? 'first-lease' : 'returned-lease',
      requestRef: 'page' + index,
    };
    const page = {
      ...original,
      provenance: proof,
      root: {
        ...original.root!,
        observationId: 'root' + index,
        networkProvenance: proof,
        text: 'version ' + index,
      },
    };
    acceptReadNetworkPage(
      row,
      page,
      {
        provenance: proof,
        bytes: 1,
        sha256: 'a'.repeat(64),
        inputCursorRef: null,
        outputCursorRef: 'cursor' + index,
        end: 'unknown',
        observed: 0,
        sampled: 0,
        omitted: 0,
        unsupported: [],
      },
      limits,
      context,
    );
  }
  expect(row.networkPages).toHaveLength(1000);
  expect(row.root?.text).toBe('version 999');
  expect(row.bodyObservations).toHaveLength(999);
  expect(row.budgetBinding).toContainEqual({
    dimension: 'network_pages',
    limit: 1000,
    used: 1000,
    origin: 'safety',
  });
  expect(JSON.stringify(row)).not.toContain('version 1000');
});

it('mixed read keeps ordinary bodies in the network domain and Article bodies in the DOM domain', async () => {
  const { stagedFixture } = await import('../../test-support/xResearchFixture');
  const { readX } = await import('./xResearchRead');
  const { canonicalizeXResearchResult } = await import('./xResearchCanonical');
  const f = await stagedFixture({ article: 'ok' });
  const result = await readX(
    {
      tabId: 'tab',
      read: {
        objective: 'domains',
        targets: [{ url: 'https://x.com/alice/status/123' }],
        includeArticle: true,
        includeReplies: false,
        maxRepliesPerPost: 0,
        maxScrollsPerPost: 0,
        maxExpandActionsPerPost: 1,
      },
    },
    f.context,
  );
  expect(result.sourceKind).toBe('mixed');
  expect(() => canonicalizeXResearchResult(result)).not.toThrow();
  for (const alter of [
    (r: typeof result) => {
      r.targets[0].root!.sourceKind = 'rendered_ui';
    },
    (r: typeof result) => {
      r.targets[0].article.body!.sourceKind = 'page_graphql';
    },
    (r: typeof result) => {
      r.targets[0].bodyObservations = [
        { ...r.targets[0].root!, containerKind: 'article' },
      ];
    },
  ]) {
    const wrong = structuredClone(result);
    alter(wrong);
    expect(() => canonicalizeXResearchResult(wrong)).toThrow();
  }
});

it('projects read provenance and network page omission counts without changing source scope or sampled bodies', async () => {
  const { readX } = await import('./xResearchRead');
  const { fixture, post, readHtml } =
    await import('../../test-support/xResearchFixture');
  const { serializeXResearchResult } = await import('./xResearchOutput');
  const result = await readX(
    {
      tabId: 'tab',
      read: {
        objective: 'pages',
        targets: [{ url: 'https://x.com/alice/status/123' }],
        includeArticle: false,
        includeReplies: true,
        maxRepliesPerPost: 2,
        maxScrollsPerPost: 0,
        maxExpandActionsPerPost: 0,
      },
    },
    fixture([readHtml(post() + post('456', 'bob', 'reply'))]).context,
  );
  const row = result.targets[0];
  row.networkPages = Array.from({ length: 1000 }, (_, i) => ({
    provenance: { ...provenance, requestRef: 'p' + i },
    bytes: 200000,
    sha256: 'a'.repeat(64),
    inputCursorRef: 'in' + i,
    outputCursorRef: 'out' + i,
    end: 'unknown' as const,
    observed: 1,
    sampled: 1,
    omitted: 0,
    unsupported: [],
    readContext: {
      rootPostId: '123',
      accountContextId: null,
      branchKey: null,
      sortKey: 'Relevance',
      continuationKind: 'Bottom',
      terminationDirections: [],
    },
  }));
  const positive = serializeXResearchResult({
    ...result,
    targets: [{ ...row, networkPages: row.networkPages.slice(0, 1) }],
  });
  expect(positive.result.targets[0].networkPages).toHaveLength(1);
  const delivered = serializeXResearchResult({
    ...result,
    objective: 'x'.repeat(600000),
  });
  expect(delivered.result.targets[0].networkPagesOmitted).toBe(1000);
  expect(delivered.result.targets[0].networkPages).toBeUndefined();
  expect(delivered.result.targets[0].replies.scope).toEqual(row.replies.scope);
  const model = JSON.parse(delivered.text).targets[0];
  expect(model.networkPageCount).toBe(1000);
  expect(model.identity).toEqual(row.identity);
  expect(model.replies.observations[0]).toMatchObject({
    conversationId: '123',
    directParent: { postId: '123' },
    networkProvenance: row.replies.observations[0].networkProvenance,
  });
});

it('refuses the branch cursor a dispatched reply-expansion introduces without revoking the lease', async () => {
  const h = harness();
  expect(h.lease.accepts(raw())).toBe(true);
  h.emit(raw(), first.body);
  expect((await h.lease.collect(location)).proof).toBeDefined();
  // A DOM expansion can answer with a continuation the decoded page never announced
  // (its entry was skipped as an unrecorded shape). Refuse that one reply…
  h.lease.expectBranchContinuation();
  expect(h.lease.accepts(raw({ ...next.request, cursor: 'branch-only-cursor' }, { id: 'branch' }))).toBe(false);
  await expect(h.lease.collect(location)).resolves.toBeDefined();
  // …and the proven chain is still usable for the real successor.
  expect(h.lease.accepts(raw(next.request, { id: 'b' }))).toBe(true);
  h.emit(raw(next.request, { id: 'b' }), next.body);
  expect((await h.lease.collect(location)).pages[0].replies.length).toBeGreaterThan(0);
});

it('observed own-target sort changes and incompatible source cursors revoke current authority but retain accepted history', async () => {
  for (const changed of [
    { ...next.request, rankingMode: 'Recency' },
    { ...next.request, rankingMode: 'Unknown' },
    { focalTweetId: first.request.focalTweetId, cursor: next.request.cursor },
    { ...next.request, cursor: 'other-branch' },
    { ...first.request },
  ]) {
    const h = harness();
    expect(h.lease.accepts(raw())).toBe(true);
    h.emit(raw(), first.body);
    const accepted = await h.lease.collect(location);
    expect(accepted.proof).toBeDefined();
    expect(h.lease.accepts(raw(changed, { id: 'changed' }))).toBe(false);
    await expect(h.lease.collect(location)).rejects.toMatchObject({
      code: 'x.invalid_page',
    });
    expect(accepted.pages[0].root?.text).toBe('Captured read text 1');
  }
  const unrelated = harness();
  expect(unrelated.lease.accepts(raw())).toBe(true);
  unrelated.emit(raw(), first.body);
  expect((await unrelated.lease.collect(location)).proof).toBeDefined();
  expect(
    unrelated.lease.accepts(
      raw({ ...next.request, focalTweetId: '999' }, { id: 'other' }),
    ),
  ).toBe(false);
  expect((await unrelated.lease.collect(location)).proof).toBeDefined();
});

async function retentionCase() {
  const { readResult } = await import('./xResearchRead');
  const { fixture } = await import('../../test-support/xResearchFixture');
  const context = fixture([]).context;
  const source = decodeXReadResponse(first.body, request(first));
  const limits = {
    objective: 'retention',
    targets: [{ url: source.root!.sourceUrl! }],
    includeArticle: true,
    includeReplies: true,
    maxRepliesPerPost: 10,
    maxScrollsPerPost: 0,
    maxExpandActionsPerPost: 0,
  };
  const result = readResult({ tabId: 'tab', read: limits }, context);
  let sequence = 0;
  const page = (leaseId = 'lease') =>
    ({
      ...source,
      provenance: {
        ...source.provenance,
        leaseId,
        requestRef: 'retention-' + sequence++,
      },
      root: null,
      replies: [],
      unscopedPosts: [],
      quotedPosts: [],
      posts: [],
      sampleOrder: [],
      quoteParents: {},
    }) as import('./xNetworkSource').XNetworkReadPage;
  const body = (
    id: string,
    kind: 'root_post' | 'reply' | 'quoted_post' | 'unscoped_post',
    observationId: string,
    p: import('./xNetworkSource').XNetworkProvenance,
  ) =>
    ({
      ...source.root!,
      postId: id,
      sourceUrl: `https://x.com/ReadAuthor/status/${id}`,
      author: { handle: 'ReadAuthor', displayName: null, profileUrl: null },
      observationId,
      containerKind: kind,
      networkProvenance: p,
      text: observationId,
      truncation: {
        returned: observationId.length,
        totalKnown: observationId.length,
        truncated: false,
      },
      articlePreviews: [],
      ...(kind === 'reply'
        ? {
            directParent: { postId: source.root!.postId!, sourceUrl: null },
            conversationId: source.root!.postId!,
          }
        : {}),
      ...(kind === 'unscoped_post'
        ? { relationToTarget: 'unproven', observedContainer: 'post' }
        : {}),
    }) as
      | import('./xResearchTypes').XTextObservation
      | import('./xResearchTypes').XUnscopedPost;
  return {
    context,
    source,
    limits,
    result,
    row: result.targets[0],
    page,
    body,
  };
}

it('preserves immutable wire Article presence and positive native audit through later zero and repeated saves', async () => {
  const { acceptReadNetworkPage, savePostFrame } =
    await import('./xResearchReadStages');
  const { canonicalizeXResearchResult } = await import('./xResearchCanonical');
  const { XResearchEvidence } = await import('./xResearchEvidence');
  const { tempXArtifactStore } =
    await import('../../test-support/xArtifactStore');
  const c = await retentionCase(),
    p = c.page();
  p.root = c.body(c.row.postId!, 'root_post', 'wire-root', p.provenance) as any;
  p.root!.articlePreviewInventory = {
    scope: 'collection',
    observed: 0,
    retained: 0,
    omitted: 0,
    unresolved: 1,
  };
  const original = structuredClone(p.root);
  acceptReadNetworkPage(c.row, p, undefined, c.limits, c.context);
  const parent = {
    postId: c.row.postId!,
    sourceUrl: p.root!.sourceUrl!,
    authorHandle: 'ReadAuthor',
  };
  const entry = {
    observationId: 'native-entry',
    parentPostId: parent.postId,
    sourceUrl: parent.sourceUrl,
    targetUrl: 'https://x.com/bob/status/456',
    author: { handle: 'bob', displayName: null, profileUrl: null },
    label: 'Article',
    binding: { nodeId: 1, index: 1, snapshotId: 'snap', generation: 'gen' },
  };
  const frame = {
    state: null,
    identityProven: true,
    network: { pages: [], proof: p.provenance },
    entries: [entry],
    entryParents: new WeakMap([[entry, parent]]),
    articleParentInventories: new Map([
      [0, { ...parent, observedEntries: 1, unresolvedEntries: 0 }],
    ]),
    location: {
      current: {
        redacted: false,
        origin: 'https://x.com',
        path: `/ReadAuthor/status/${parent.postId}`,
      },
    },
    snapshot: { url: parent.sourceUrl },
  } as unknown as import('./xObservation').XPageObservation;
  expect(savePostFrame(c.row, frame, c.limits, c.context)).toBe(true);
  expect(c.row.root!.articlePreviews).toHaveLength(1);
  expect(p.root).toEqual(original);
  const positive = JSON.stringify(c.row);
  savePostFrame(c.row, frame, c.limits, c.context);
  expect(JSON.stringify(c.row)).toBe(positive);
  frame.entries = [];
  (frame as any).articleParentInventories = new Map([
    [0, { ...parent, observedEntries: 0, unresolvedEntries: 0 }],
  ]);
  savePostFrame(c.row, frame, c.limits, c.context);
  const once = JSON.stringify(c.row);
  savePostFrame(c.row, frame, c.limits, c.context);
  expect(JSON.stringify(c.row)).toBe(once);
  expect(p.root).toEqual(original);
  const canonical = canonicalizeXResearchResult(c.result),
    store = tempXArtifactStore();
  const persisted = await store.read(await store.write(canonical));
  const ledger = new XResearchEvidence('/tmp', () => c.context.runId);
  ledger.restore([
    {
      type: 'message',
      id: 'saved',
      message: {
        role: 'toolResult',
        toolName: 'x_research',
        toolCallId: 'call',
        details: persisted,
        content: [],
        isError: false,
      },
    },
  ]);
  expect(
    ledger.observations.find((p) => p.postId === parent.postId)?.text,
  ).toBe('wire-root');
  expect(() =>
    ledger.guard('/tmp/report.md', `[source](${parent.sourceUrl})`),
  ).toThrow(/Article/);
  expect([
    ...(c.row.root!.articlePreviews ?? []),
    ...(c.row.articlePreviewObservations ?? []).flatMap(
      (p) => p.articlePreviews,
    ),
  ]).toContainEqual(
    expect.objectContaining({ entryObservationId: 'native-entry' }),
  );
});

it('retains displaced unscoped bodies and empty-body Article gaps through canonical artifact restoration', async () => {
  const { acceptReadNetworkPage } = await import('./xResearchReadStages');
  const { canonicalizeXResearchResult } = await import('./xResearchCanonical');
  const { XResearchEvidence } = await import('./xResearchEvidence');
  const { tempXArtifactStore } =
    await import('../../test-support/xArtifactStore');
  const c = await retentionCase(),
    a = c.page();
  a.root = c.body(c.row.postId!, 'root_post', 'root', a.provenance) as any;
  const old = c.body(
    '456',
    'unscoped_post',
    'original independent body',
    a.provenance,
  ) as import('./xResearchTypes').XUnscopedPost;
  old.articlePreviewInventory = {
    scope: 'collection',
    observed: 0,
    retained: 0,
    omitted: 0,
    unresolved: 1,
  };
  const empty = {
    ...old,
    postId: '457',
    sourceUrl: 'https://x.com/ReadAuthor/status/457',
    observationId: 'empty-gap',
    text: '',
    truncation: { returned: 0, totalKnown: 0, truncated: false },
  };
  a.unscopedPosts = [old, empty];
  a.sampleOrder = [old.observationId, empty.observationId];
  acceptReadNetworkPage(c.row, a, undefined, c.limits, c.context);
  expect(c.row.unscopedPosts!.previewGaps.map((g) => g.sourceUrl)).toEqual([
    old.sourceUrl,
    empty.sourceUrl,
  ]);
  const b = c.page();
  b.unscopedPosts = [
    c.body('456', 'unscoped_post', 'replacement body', b.provenance) as any,
    c.body(
      '457',
      'unscoped_post',
      'later independent body',
      b.provenance,
    ) as any,
  ];
  b.sampleOrder = b.unscopedPosts.map((p) => p.observationId);
  acceptReadNetworkPage(c.row, b, undefined, c.limits, c.context);
  expect(c.row.bodyObservations).toContainEqual(
    expect.objectContaining({
      containerKind: 'unscoped_post',
      observationId: old.observationId,
      text: old.text,
      relationToTarget: 'unproven',
    }),
  );
  expect(c.row.unscopedPosts!.previewGaps.map((g) => g.sourceUrl)).toEqual([
    old.sourceUrl,
    empty.sourceUrl,
  ]);
  const canonical = canonicalizeXResearchResult(c.result),
    store = tempXArtifactStore();
  const { serializeXResearchResult } = await import('./xResearchOutput');
  const projected = serializeXResearchResult({
    ...canonical,
    objective: 'x'.repeat(600000),
  });
  expect(
    JSON.parse(projected.text).targets[0].bodyObservations[0],
  ).toMatchObject({
    containerKind: 'unscoped_post',
    relationToTarget: 'unproven',
    observedContainer: 'post',
    text: old.text,
  });
  const saved = await store.read(await store.write(canonical));
  const ledger = new XResearchEvidence('/tmp', () => c.context.runId);
  ledger.restore([
    {
      type: 'message',
      id: 'saved',
      message: {
        role: 'toolResult',
        toolName: 'x_research',
        toolCallId: 'call',
        details: saved,
        content: [],
        isError: false,
      },
    },
  ]);
  expect(
    ledger.observations.filter((p) => p.postId === '456').map((p) => p.text),
  ).toEqual(expect.arrayContaining([old.text, 'replacement body']));
  expect(
    ledger.observations.find((p) => p.observationId === old.observationId),
  ).toMatchObject({
    containerKind: 'unscoped_post',
    relationToTarget: 'unproven',
    origin: 'history',
  });
  for (const url of [old.sourceUrl, empty.sourceUrl])
    expect(() => ledger.guard('/tmp/report.md', `[source](${url})`)).toThrow(
      /Article inventory/,
    );
});

it('requires this page retained parent for quotes across same-lease repeats and unproved Article-return leases', async () => {
  const { acceptReadNetworkPage } = await import('./xResearchReadStages');
  const { XResearchEvidence } = await import('./xResearchEvidence');
  const { canonicalizeXResearchResult } = await import('./xResearchCanonical');
  for (const lease of ['lease', 'article-return']) {
    const c = await retentionCase(),
      a = c.page();
    a.root = c.body(c.row.postId!, 'root_post', 'root', a.provenance) as any;
    a.replies = [c.body('456', 'reply', 'first reply', a.provenance) as any];
    a.sampleOrder = a.replies.map((p) => p.observationId);
    acceptReadNetworkPage(c.row, a, undefined, c.limits, c.context);
    expect(c.row.replies.observations[0].postId).toBe('456');
    const b = c.page(lease);
    b.replies = [c.body('456', 'reply', 'new reply', b.provenance) as any];
    b.quotedPosts = [
      c.body('789', 'quoted_post', 'fresh quote', b.provenance) as any,
    ];
    b.sampleOrder = b.replies.map((p) => p.observationId);
    b.quoteParents = { [b.quotedPosts[0].observationId]: '456' };
    acceptReadNetworkPage(c.row, b, undefined, c.limits, c.context);
    const ledger = new XResearchEvidence('/tmp', () => c.context.runId);
    ledger.observe(canonicalizeXResearchResult(c.result));
    if (lease === 'lease') {
      expect(c.row.quotedPosts).toHaveLength(1);
      expect(c.context.sources.get('789')).toBeDefined();
      expect(ledger.observations.some((p) => p.postId === '789')).toBe(true);
    } else {
      expect(c.row.quotedPosts).toHaveLength(0);
      expect(c.context.sources.get('789')).toBeUndefined();
      expect(ledger.observations.some((p) => p.postId === '789')).toBe(false);
      expect(c.row.sampleTruncation).toEqual({
        observed: 2,
        sampled: 1,
        omitted: 1,
      });
      expect(c.row.root!.text).toBe('root');
    }
  }
});

it('keeps an observed Article identity in distinct entries after subsequent source acceptance', async () => {
  const { acceptReadNetworkPage } = await import('./xResearchReadStages');
  for (const sameAsRoot of [false, true]) {
    const c = await retentionCase(), first = c.page();
    first.root = c.body(c.row.postId!, 'root_post', 'root', first.provenance) as import('./xResearchTypes').XTextObservation;
    acceptReadNetworkPage(c.row, first, undefined, c.limits, c.context);
    const baseline = c.row.budgetUsage.distinctEntries;
    const articleId = sameAsRoot ? c.row.postId! : '654';
    c.row.article.body = {...c.body(articleId, 'root_post', 'article', first.provenance), containerKind:'article', sourceKind:'rendered_ui'};
    c.row.article.bodyObserved = true;
    const next = c.page(); next.provenance = {...next.provenance, requestRef:'after-article'};
    acceptReadNetworkPage(c.row, next, undefined, c.limits, c.context);
    expect(c.row.budgetUsage.distinctEntries).toBe(baseline + (sameAsRoot ? 0 : 1));
    expect(c.row.article.body.postId).toBe(articleId);
  }
});


it('preserves the recorded three-page Recency chain across sequential and queued consumption', async () => {
  const pages = [recency, (await import('../../test-support/fixtures/x-network/read-thread-3.json')).default,
    (await import('../../test-support/fixtures/x-network/read-thread-4.json')).default];
  const results: string[][] = [];
  for (const queued of [false, true, 'reverse']) {
    const h = harness(); const seen: string[] = [];
    for (const [i, page] of pages.entries()) {
      const r = raw(page.request, {id: String(i)});
      expect(h.lease.accepts(r)).toBe(true);
      if(queued!=='reverse' || i!==1)h.emit(r, page.body);
      if(queued==='reverse' && i===2)h.emit(raw(pages[1].request,{id:'1'}),pages[1].body);
      if (i === 0 || !queued || i === 2) {
        const batch = await h.lease.collect(location);
        expect(batch.failure).toBeUndefined();
        seen.push(...batch.pages.map(p => JSON.stringify([p.inputCursor,p.outputCursor,p.posts.map(post=>[post.postId,post.text])])));
      }
    }
    expect(h.lease.pageFacts).toHaveLength(3); results.push(seen);
    expect(h.lease.accepts(raw({...pages[2].request,cursor:'wrong'}, {id:'wrong'}))).toBe(false);
    await expect(h.lease.collect(location)).rejects.toThrow('cursor_chain_mismatch');
  }
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
});


it('bounds unresolved captures without delivering unproved pages or reviving native authority',async()=>{
  const h=harness();expect(h.lease.accepts(raw())).toBe(true);
  for(let i=1;i<1000;i++)expect(h.lease.accepts(raw({...first.request,cursor:'unresolved-'+i},{id:String(i)}))).toBe(true);
  expect(h.lease.accepts(raw({...first.request,cursor:'beyond-cap'},{id:'overflow'}))).toBe(false);
  h.emit(raw(),first.body);
  const saved:string[]=[];
  const batch=await h.lease.collect(location,undefined,undefined,p=>saved.push(p.root!.text));
  expect(saved).toEqual(['Captured read text 1']);
  expect(batch).toMatchObject({failure:'cursor_chain_mismatch',pending:false});
  expect(h.lease.pageFacts).toHaveLength(1);
  expect(h.lease.actionSignal.aborted).toBe(true);
});
