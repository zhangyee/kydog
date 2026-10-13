import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XResearchEvidence } from './xResearchEvidence';
import { serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
import { fixture, post, readHtml } from '../../test-support/xResearchFixture';
import { createXResearchTool } from '../agent/xResearchTool';
import type { XResearchResult, XTextObservation } from './xResearchTypes';
const url = 'https://x.com/alice/status/123';
const report = '/tmp/x-research-topic-2026-10-12.md';
const citation = (u = url) => `Observed evidence [source](${u})`;
async function result() {
  const f = fixture([readHtml(post())]);
  const tool = createXResearchTool({
    browser: f.context.browser,
    threadId: 'thread',
    sources: f.context.sources,
    currentRunId: () => 'run',
  });
  const r = (
    await tool.execute(
      'call',
      {
        tabId: 'research-tab',
        read: {
          objective: 'read',
          targets: [{ url }],
          includeArticle: false,
          includeReplies: false,
        },
      },
      undefined,
      undefined,
      {} as never,
    )
  ).details!;
  if (r.operation !== 'read') throw Error('fixture');
  // These DTO mutation tests also cover schema2 history predating inventory.
  delete r.targets[0].root!.articlePreviewInventory;
  return r;
}
const entry = (_r: Awaited<ReturnType<typeof result>>) => ({
  entryObservationId: 'entry-real',
  parentPostId: '123',
  sourceUrl: url,
  targetUrl: 'https://x.com/articleauthor/status/456',
});
const history = (details: unknown) => ({
  type: 'message',
  id: 'entry-id',
  message: {
    role: 'toolResult',
    toolName: 'x_research',
    toolCallId: 'call',
    details,
    content: [],
    isError: false,
  },
});
it('persists exact diagnostic frame IDs and legacy no-diagnostic read through SDK file reopen and branch selection', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'kydog-x-diagnostic-sdk-'));
  try {
    const fresh=await result(), frame=fresh.targets[0].diagnostics?.initialFrame;
    expect(frame?.snapshotId).toMatch(/^xsnap_/);
    const old=structuredClone(fresh);
    delete old.targets[0].diagnostics;
    const manager=SessionManager.create(dir,dir);
    const base=manager.appendMessage({role:'user',content:'read history',timestamp:1});
    const record=(details:typeof fresh)=>{
      const payload=xResearchToolResult(serializeXResearchResult(details));
      return manager.appendMessage({role:'toolResult',toolName:'x_research',toolCallId:details.callId,content:payload.content,details:payload.details,isError:false,timestamp:2});
    };
    const freshId=record(fresh);
    manager.branch(base);
    const oldId=record(old);
    // The installed SDK defers its first JSONL flush until an assistant entry exists.
    manager.appendMessage({role:'assistant',content:[{type:'text',text:'ack'}],api:'openai-completions',provider:'openai',model:'fixture',stopReason:'stop',
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:3});
    const file=manager.getSessionFile();
    expect(file).toBeDefined();
    const reopened=SessionManager.open(file!);
    for(const [id,expected] of [[freshId,frame?.snapshotId],[oldId,undefined]] as const){
      reopened.branch(id);
      const messages=reopened.buildSessionContext().messages;
      const saved=messages.find(m=>m.role==='toolResult');
      expect(saved?.role).toBe('toolResult');
      if(saved?.role!=='toolResult') throw new Error('tool result missing from SDK branch');
      const details=saved.details as typeof fresh;
      expect(details.targets[0].diagnostics?.initialFrame?.snapshotId).toBe(expected);
      expect(JSON.parse(saved.content[0].type==='text'?saved.content[0].text:'{}').targets[0].diagnostics?.initialFrame?.snapshotId).toBe(expected);
      const ledger=new XResearchEvidence(dir,()=> 'restored-run');
      ledger.restore(reopened.getBranch());
      expect(ledger.guard(report,citation())).toEqual({createOnly:true});
    }
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
it('onlyProductionObservationsBecomeEvidence: same-container identity, no assistant/page/candidate authority', async () => {
  const r = await result(),
    ledger = new XResearchEvidence('/tmp', () => 'run');
  ledger.observe(r);
  expect(ledger.guard(report, citation())).toEqual({ createOnly: true });
  expect(ledger.observations).toHaveLength(1);
  for (const forged of [
    { type: 'message', message: { role: 'assistant', details: r } },
    {
      type: 'message',
      message: { role: 'toolResult', toolName: 'browser', details: r },
    },
    r,
    { type: 'compaction', details: r, retainedTail: [history(r).message] },
  ]) {
    ledger.restore([forged]);
    expect(() => ledger.guard(report, citation())).toThrow(/unobserved/);
  }
  ledger.restore([history(r)]);
  expect(ledger.guard(report, citation())).toEqual({ createOnly: true });
  expect(() =>
    ledger.guard(report, citation('https://x.com/WrongAuthor/status/123')),
  ).toThrow(/unobserved/);
  const bad = structuredClone(r);
  bad.targets[0].root!.author!.handle = 'WrongAuthor';
  ledger.restore([history(bad)]);
  expect(() => ledger.guard(report, citation())).toThrow(/unobserved/);
});
it('shortLaterPreviewDoesNotReplaceReadBody: exact observation provenance survives independent calls', async () => {
  const r = await result();
  r.targets[0].root!.text = 'full '.repeat(500);
  r.targets[0].root!.observationId = 'full-id';
  const ledger = new XResearchEvidence('/tmp', () => 'now');
  ledger.restore([history(r)]);
  const later = structuredClone(r);
  later.runId = 'now';
  later.callId = 'later';
  later.batchId = 'later-batch';
  later.targets[0].root!.observationId = 'short-id';
  later.targets[0].root!.text = 'short';
  ledger.observe(later);
  expect(
    ledger.observations.map((o) => [
      o.observationId,
      o.text.length,
      o.origin,
      o.runId,
    ]),
  ).toEqual([
    ['full-id', 2500, 'history', 'run'],
    ['short-id', 5, 'production', 'now'],
  ]);
  expect(
    ledger.sources
      .get('123')!
      .filter((s) => s.urlKind === 'permalink')
      .map((s) => s.observationId),
  ).toEqual(['full-id', 'short-id']);
  expect(ledger.guard(report, citation())).toEqual({ createOnly: true });
});
it('previewNeedsExactArticleAttempt: requested and parent navigation cannot stand in for the exact entry', async () => {
  const r = await result(),
    identity = entry(r);
  r.targets[0].root!.articlePreviews = [identity];
  const ledger = new XResearchEvidence('/tmp', () => 'run');
  const attempt = structuredClone(r);
  attempt.targets[0].article = {
    requested: true,
    entryObserved: true,
    actionAttempted: true,
    navigationStarted: false,
    bodyObserved: false,
    entry: null,
    entryIdentity: identity,
    body: null,
    barrier: { status: 'failed', reason: 'action denied', observationId: null },
  };
  ledger.observe(attempt);
  expect(
    ledger.guard(report, citation() + ' Article body unavailable.'),
  ).toEqual({ createOnly: true });
  for (const change of [
    { requested: true },
    { requested: true, navigationStarted: true },
    {
      requested: true,
      actionAttempted: true,
      entryIdentity: {
        ...identity,
        targetUrl: 'https://x.com/other/status/999',
      },
    },
  ]) {
    const incomplete = structuredClone(r);
    Object.assign(incomplete.targets[0].article, change);
    ledger.restore([history(incomplete)]);
    expect(() => ledger.guard(report, citation())).toThrow(
      /123.*entry-real|entry-real.*123/,
    );
  }
  const body = structuredClone(r);
  body.targets[0].article.body = {
    ...body.targets[0].root!,
    containerKind: 'article',
    postId: '456',
    sourceUrl: 'https://x.com/articleauthor/status/456',
    author: { handle: 'articleauthor', displayName: null, profileUrl: null },
    observationId: 'body-id',
    text: 'full article',
  };
  delete body.targets[0].article.body.articlePreviews;
  body.targets[0].article.bodyObserved = true;
  body.targets[0].article.entryIdentity = identity;
  ledger.restore([history(body)]);
  expect(ledger.guard(report, citation())).toEqual({ createOnly: true });
  expect(
    ledger.guard(report, citation('https://x.com/articleauthor/status/456')),
  ).toEqual({ createOnly: true });
  body.targets[0].article.body.author!.handle = 'alice';
  ledger.restore([history(body)]);
  expect(() =>
    ledger.guard(report, citation('https://x.com/articleauthor/status/456')),
  ).toThrow(/unobserved/);
  expect(() => ledger.guard(report, citation())).toThrow(/entry-real/);
});
it('validates quote and reply own identities without stitching author or URL from root', async () => {
  const r = await result(),
    ledger = new XResearchEvidence('/tmp', () => 'run');
  const other = (
    kind: 'quoted_post' | 'reply',
    id: string,
    handle: string,
  ): XTextObservation =>
    ({
      ...r.targets[0].root!,
      containerKind: kind,
      postId: id,
      sourceUrl: `https://x.com/${handle}/status/${id}`,
      author: { handle, displayName: null, profileUrl: null },
      observationId: id,
      ...(kind === 'reply'
        ? { directParent: { postId: '123', sourceUrl: url } }
        : {}),
    }) as XTextObservation;
  r.targets[0].quotedPosts = [other('quoted_post', '456', 'bob')];
  r.targets[0].replies.observations = [other('reply', '789', 'carol')];
  ledger.observe(r);
  for (const [id, handle] of [
    ['456', 'bob'],
    ['789', 'carol'],
  ]) {
    expect(
      ledger.guard(report, citation(`https://x.com/${handle}/status/${id}`)),
    ).toEqual({ createOnly: true });
    expect(() =>
      ledger.guard(report, citation(`https://x.com/alice/status/${id}`)),
    ).toThrow(/unobserved/);
  }
});
it('restores actual SDK active branch only and discards evidence from a previous restore', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.inMemory('/tmp');
  const r = await result();
  const base = manager.appendMessage({
    role: 'user',
    content: 'question',
    timestamp: 1,
  });
  manager.appendMessage(history(r).message as never);
  const ledger = new XResearchEvidence('/tmp', () => 'run');
  ledger.restore(manager.getBranch());
  expect(ledger.guard(report, citation())).toEqual({ createOnly: true });
  manager.branch(base);
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify(r) }],
    timestamp: 2,
  } as never);
  ledger.restore(manager.getBranch());
  expect(() => ledger.guard(report, citation())).toThrow(/unobserved/);
});
it('legacy attached body clears only the directly associated parent; parent navigation and stitched roots never clear it', () => {
  const p = {
    id: '123',
    url,
    author: { handle: 'alice' },
    text: 'preview',
    articlePreview: { title: 'old' },
    metrics: {},
    media: [],
    links: [],
  };
  const item = {
    postId: '123',
    root: p,
    replies: [],
    coverage: { replyCursorExhausted: true, truncated: false },
    article: {
      status: 'present',
      plainText: 'legacy body',
      blocks: [
        { type: 'paragraph', text: 'legacy body', entities: [], key: 'b' },
      ],
    },
    articleReadAttempted: true,
    errors: [],
  };
  const b = {
    schemaVersion: 1,
    operation: 'read',
    items: [item],
    status: 'partial',
    browserTabId: 'old',
    objective: 'old',
    errors: [],
  };
  const l = new XResearchEvidence('/tmp', () => 'new-run');
  l.restore([history(b)]);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  expect(l.sources.get('123')![0]).toMatchObject({
    sourceKind: 'legacy_x_graphql',
    runId: null,
    batchId: null,
    observationId: null,
    observedAt: null,
    callId: 'call',
    sessionEntryId: 'entry-id',
  });
  l.restore([
    history({
      ...b,
      items: [
        {
          ...item,
          article: { status: 'not_observed', reason: 'action_failed' },
        },
      ],
    }),
  ]);
  expect(() => l.guard(report, citation())).toThrow(/123/);
  const search = { ...b, operation: 'search', posts: [p], queries: [] };
  l.restore([
    history(search),
    history({ ...b, items: [{ ...item, root: undefined }] }),
  ]);
  expect(() => l.guard(report, citation())).toThrow(/123/);
});
it('citation parsing covers rendered Markdown references, HTML and plain text without filename-polluting ordinary files', async () => {
  const l = new XResearchEvidence('/tmp', () => 'run');
  l.observe(await result());
  for (const ext of ['md', 'txt', 'ts']) {
    const p = `/tmp/ordinary.${ext}`;
    expect(l.guard(p, 'ordinary contents')).toBeUndefined();
    expect(l.guard(p, citation())).toBeUndefined();
    for (const c of [
      '[x][ref]\n\n[ref]: https://x.com/WrongAuthor/status/123',
      '<a href="https://x.com/WrongAuthor/status/123">x</a>',
      'https://x.com/WrongAuthor/status/123',
    ])
      expect(() => l.guard(p, c)).toThrow(/unobserved/);
  }
  expect(
    l.guard('/tmp/x-research-not-a-report.txt', 'ordinary'),
  ).toBeUndefined();
});
it('refreshed href-less parent evidence permits an actual accurate-entry failure without upgrading earlier preview continuity', async () => {
  const r = await result(),
    old = { ...entry(r), entryObservationId: 'search-entry', targetUrl: null };
  const search: XResearchResult = {
    schemaVersion: 2,
    sourceKind: 'rendered_ui',
    operation: 'search',
    runId: 'run',
    callId: 'search-call',
    batchId: 'search-batch',
    browserTabId: 'tab',
    objective: 'search',
    status: 'observed',
    budgetUsage: r.budgetUsage,
    truncation: r.truncation,
    queries: [
      {
        query: { id: 'q', query: 'test', purpose: 'test', product: 'Top' },
        collectionTransitions: [],
        status: 'observed',
        posts: [{ ...r.targets[0].root!, articlePreviews: [old] }],
        stopReason: 'agent_stopped',
        budgetUsage: r.budgetUsage,
        location: null,
        barrier: null,
      },
    ],
  };
  const attempt = structuredClone(r);
  attempt.targets[0].article = {
    ...attempt.targets[0].article,
    entryObserved: true,
    actionAttempted: true,
    entryIdentity: { ...old, entryObservationId: 'read-entry' },
  };
  const ledger = new XResearchEvidence('/tmp', () => 'run');
  ledger.observe(search);
  ledger.observe(attempt);
  expect(
    ledger.guard(
      report,
      citation() + ' Body not available after access failure.',
    ),
  ).toEqual({ createOnly: true });
  expect(ledger.observations[0].articlePreviews).toEqual([old]);
  for (const mutate of [
    (a: typeof attempt) => {
      a.targets[0].article.actionAttempted = false;
      a.targets[0].article.requested = true;
    },
    (a: typeof attempt) => {
      a.targets[0].article.actionAttempted = false;
      a.targets[0].article.navigationStarted = true;
    },
    (a: typeof attempt) => {
      a.targets[0].root!.author!.handle = 'WrongAuthor';
    },
    (a: typeof attempt) => {
      a.targets[0].root!.sourceUrl = 'https://x.com/alice/status/999';
    },
    (a: typeof attempt) => {
      a.targets[0].root = null;
    },
  ]) {
    const bad = structuredClone(attempt);
    mutate(bad);
    ledger.restore([]);
    ledger.observe(search);
    ledger.observe(bad);
    expect(() => ledger.guard(report, citation())).toThrow(/search-entry/);
  }
  search.queries[0].posts[0].articlePreviews = [
    { ...old, targetUrl: 'https://x.com/bob/status/456' },
    {
      ...old,
      entryObservationId: 'second-entry',
      targetUrl: 'https://x.com/carol/status/789',
    },
  ];
  attempt.targets[0].article.entryIdentity = {
    ...old,
    entryObservationId: 'first-attempt',
    targetUrl: 'https://x.com/bob/status/456',
  };
  ledger.restore([]);
  ledger.observe(search);
  ledger.observe(attempt);
  expect(() => ledger.guard(report, citation())).toThrow(/second-entry.*789/);
});
it('preserves valid document aliases and omission facts, rejects mismatched root association or malformed previews', async () => {
  const r = await result(),
    l = new XResearchEvidence('/tmp', () => 'run');
  r.targets[0].root!.sourceUrl = url + '/history';
  r.targets[0].sourceUrl = null;
  r.targets[0].sourceUrlReference = 'root.sourceUrl';
  r.metadataOmissions = ['targets.0.sourceUrl (exact alias root.sourceUrl)'];
  l.observe(r);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  expect(l.guard(report, citation(url + '/history'))).toEqual({
    createOnly: true,
  });
  r.targets[0].documentSource!.rootObservationId = 'different';
  l.restore([history(r)]);
  expect(() => l.guard(report, citation())).toThrow(/unobserved/);
  r.targets[0].root!.articlePreviews = [
    { ...entry(r), sourceUrl: 'https://x.com/other/status/123' },
  ];
  l.restore([history(r)]);
  expect(() => l.guard(report, citation(url + '/history'))).toThrow(
    /unobserved/,
  );
});
it('attached legacy body remains citeable when its same-item parent has an empty preview, with independent identity still unknown', () => {
  const l = new XResearchEvidence('/tmp', () => 'run');
  const root = {
    id: '123',
    url,
    author: { handle: 'alice' },
    text: '',
    articlePreview: { title: 'preview' },
  };
  l.restore([
    history({
      schemaVersion: 1,
      operation: 'read',
      items: [
        {
          postId: '123',
          root,
          article: {
            status: 'present',
            plainText: 'actual body',
            blocks: [{ key: 'p', type: 'paragraph', text: 'actual body' }],
          },
        },
      ],
    }),
  ]);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  expect(l.legacyProjections[0].articles[0].independentIdentity).toBeNull();
});
it('legacy navigation hints resolve a fresh ID read without stamping legacy provenance onto rendered UI', async () => {
  const l = new XResearchEvidence('/tmp', () => 'new-run');
  l.restore([
    history({
      schemaVersion: 1,
      operation: 'search',
      posts: [
        { id: '123', url, author: { handle: 'alice' }, text: 'old body' },
      ],
    }),
  ]);
  const f = fixture([readHtml(post('123', 'alice', 'new rendered body'))]);
  const tool = createXResearchTool({
    browser: f.context.browser,
    threadId: 'thread',
    sources: l.sources,
    currentRunId: () => 'new-run',
    observeResult: (r) => l.observe(r),
  });
  const output = await tool.execute(
    'new-call',
    {
      tabId: 'research-tab',
      read: {
        objective: 'read',
        targets: [{ postId: '123' }],
        includeArticle: false,
        includeReplies: false,
      },
    },
    undefined,
    undefined,
    {} as never,
  );
  expect(f.open.mock.calls[0][0]).toBe(url);
  expect(output.details).toMatchObject({
    runId: 'new-run',
    callId: 'new-call',
    targets: [
      {
        root: {
          sourceKind: 'rendered_ui',
          sourceUrl: url,
          text: 'new rendered body',
        },
        documentSource: { runId: 'new-run', callId: 'new-call' },
      },
    ],
  });
  expect(l.currentRunObservations.map((o) => o.text)).toEqual([
    'new rendered body',
  ]);
  expect(l.observations.map((o) => [o.sourceKind, o.runId])).toEqual([
    ['legacy_x_graphql', null],
    ['rendered_ui', 'new-run'],
  ]);
  expect(l.sources.get('123')!.find((s) => 'sourceKind' in s)).toMatchObject({
    runId: null,
    callId: 'call',
    observedAt: null,
  });
});
it('a parent body moved into the Article slot is not an observed Article body', async () => {
  const r = await result();
  const e = entry(r);
  r.targets[0].root!.articlePreviews = [e];
  r.targets[0].article = {
    ...r.targets[0].article,
    entryObserved: true,
    entryIdentity: e,
    bodyObserved: true,
    body: {
      ...r.targets[0].root!,
      containerKind: 'article',
      postId: '456',
      sourceUrl: e.targetUrl,
      author: { handle: 'articleauthor', displayName: null, profileUrl: null },
      articlePreviews: undefined,
    },
  };
  const l = new XResearchEvidence('/tmp', () => 'run');
  l.observe(r);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  r.targets[0].article.body!.containerKind = 'root_post';
  l.restore([history(r)]);
  expect(() => l.guard(report, citation())).toThrow(/entry-real/);
  expect(() => l.guard(report, citation(e.targetUrl!))).toThrow(/unobserved/);
});
it('keeps named report creation no-overwrite even for an explicitly chosen absolute destination outside cwd', async () => {
  const l = new XResearchEvidence('/tmp/project', () => 'run');
  l.observe(await result());
  expect(
    l.guard('/tmp/project/x-research-topic-2026-10-12.md', citation()),
  ).toEqual({ createOnly: true });
  expect(
    l.guard('/tmp/elsewhere/x-research-topic-2026-10-12-2.md', citation()),
  ).toEqual({ createOnly: true });
  expect(l.guard('/tmp/elsewhere/ordinary.md', citation())).toBeUndefined();
});
it('a href-less entry with an actually observed matching Article body resolves a known target without inventing its href', async () => {
  const r = await result(),
    known = entry(r);
  r.targets[0].root!.articlePreviews = [known];
  r.targets[0].article = {
    ...r.targets[0].article,
    entryObserved: true,
    entryIdentity: {
      ...known,
      entryObservationId: 'href-less-read',
      targetUrl: null,
    },
    bodyObserved: true,
    body: {
      ...r.targets[0].root!,
      containerKind: 'article',
      postId: '456',
      sourceUrl: known.targetUrl,
      author: { handle: 'articleauthor', displayName: null, profileUrl: null },
      articlePreviews: undefined,
    },
  };
  const l = new XResearchEvidence('/tmp', () => 'run');
  l.observe(r);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  r.targets[0].article.body!.postId = '789';
  r.targets[0].article.body!.sourceUrl =
    'https://x.com/articleauthor/status/789';
  l.restore([history(r)]);
  expect(() => l.guard(report, citation())).toThrow(/entry-real.*456/);
});
it('document citation authority is canonical and private even when shared navigation hints have matching IDs', async () => {
  const r = await result();
  r.targets[0].root!.sourceUrl = url + '/history';
  const l = new XResearchEvidence('/tmp', () => 'run');
  l.sources.set('123', [structuredClone(r.targets[0].documentSource!)]);
  l.observe(r);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  const publicDocument = l.sources
    .get('123')!
    .find((s) => s.urlKind === 'document')!;
  const wrong = 'https://x.com/WrongAuthor/status/123';
  publicDocument.sourceUrl = wrong;
  // Private canonical alias survives public mutation; that mutation gains no authority.
  expect(() => l.guard(report, citation(wrong))).toThrow(/unobserved/);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  for (const [alias, canonical] of [
    [wrong, true],
    ['https://x.com/alice/status/999', true],
    [url, false],
  ] as const) {
    const candidate = structuredClone(r),
      hint = { ...r.targets[0].documentSource!, sourceUrl: alias };
    candidate.targets[0].documentSource = canonical
      ? structuredClone(hint)
      : null;
    l.restore([]);
    l.sources.set('123', [hint]);
    l.observe(candidate);
    expect(l.guard(report, citation(url + '/history'))).toEqual({
      createOnly: true,
    });
    expect(() => l.guard(report, citation(alias))).toThrow(/unobserved/);
  }
  // Restoration clears old canonical aliases too, even if a navigation hint is reinserted.
  l.restore([history(r)]);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  const absent = structuredClone(r);
  absent.targets[0].documentSource = null;
  l.restore([history(absent)]);
  l.sources.set('123', [structuredClone(r.targets[0].documentSource!)]);
  expect(() => l.guard(report, citation())).toThrow(/unobserved/);
});
it('legacy attached bodies exempt only their own same-item previews, never fresh known targets or sibling items', async () => {
  const root = {
    id: '123',
    url,
    author: { handle: 'alice' },
    text: '',
    articlePreview: { title: 'legacy preview' },
  };
  const item = {
    postId: '123',
    root,
    article: {
      status: 'present',
      plainText: 'legacy attached body',
      blocks: [{ key: 'p', type: 'paragraph', text: 'legacy attached body' }],
    },
  };
  const batch = { schemaVersion: 1, operation: 'read', items: [item] };
  const l = new XResearchEvidence('/tmp', () => 'run');
  l.restore([history(batch)]);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  const fresh = await result(),
    b = entry(fresh);
  fresh.targets[0].root!.articlePreviews = [b];
  l.observe(fresh);
  expect(() => l.guard(report, citation())).toThrow(/entry-real.*456/);
  const attempt = structuredClone(fresh);
  attempt.targets[0].article = {
    ...attempt.targets[0].article,
    entryObserved: true,
    actionAttempted: true,
    entryIdentity: b,
  };
  l.observe(attempt);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  const c = {
    ...b,
    entryObservationId: 'entry-C',
    targetUrl: 'https://x.com/carol/status/789',
  };
  fresh.targets[0].root!.articlePreviews = [b, c];
  l.observe(fresh);
  expect(() => l.guard(report, citation())).toThrow(/entry-C.*789/);
  const cAttempt = structuredClone(fresh);
  cAttempt.targets[0].article = {
    ...cAttempt.targets[0].article,
    entryObserved: true,
    actionAttempted: true,
    entryIdentity: c,
  };
  l.observe(cAttempt);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  // Same URL and author do not make two old read items the same attachment family.
  l.restore([history(batch)]);
  expect(l.guard(report, citation())).toEqual({ createOnly: true });
  l.restore([
    history({
      ...batch,
      items: [
        item,
        {
          ...item,
          root: { ...root, text: 'other preview' },
          article: { status: 'not_observed', reason: 'action_failed' },
        },
      ],
    }),
  ]);
  expect(() => l.guard(report, citation())).toThrow(
    /unknown \(legacy preview\)/,
  );
});

it('an omitted or unresolved collection inventory stays unknown despite one genuine selected-entry attempt',async()=>{
 const r=await result();
 r.targets[0].root!.articlePreviews=[entry(r)];
 r.targets[0].article={...r.targets[0].article,entryIdentity:entry(r),entryObserved:true,actionAttempted:true};
 const l=new XResearchEvidence('/tmp',()=> 'run');
 r.targets[0].root!.articlePreviewInventory={scope:'collection',observed:1,retained:1,omitted:0,unresolved:0};
 l.observe(r);expect(l.guard(report,citation())).toEqual({createOnly:true});
 for(const gap of [{observed:2,retained:1,omitted:1,unresolved:0},{observed:1,retained:1,omitted:0,unresolved:1}]){
  const incomplete=structuredClone(r);incomplete.targets[0].root!.observationId='actual-gap';incomplete.targets[0].root!.articlePreviewInventory={scope:'collection',...gap};
  l.observe(incomplete);expect(()=>l.guard(report,citation())).toThrow('inventory');
  l.observe(r);expect(l.guard(report,citation())).toEqual({createOnly:true});
 }
});

it('tab restoration follows only ordered true canonical branch results, never legacy, mismatched calls or timestamps',async()=>{
 const {latestXResearchTab}=await import('./xResearchEvidence');const r=await result();
 expect(latestXResearchTab([history(r)])).toBe('research-tab');
 for(const invalid of [
  {...history(r),message:{...history(r).message,isError:true,details:{...r,browserTabId:'wrong'}}},
  {...history(r),message:{...history(r).message,toolCallId:'different-call',details:{...r,browserTabId:'wrong'}}},
  history({...r,schemaVersion:1,browserTabId:'wrong'}),
  history({...r,sourceKind:'legacy_x_graphql',browserTabId:'wrong'}),
 ])expect(latestXResearchTab([history(r),invalid])).toBe('research-tab');
 const later={...history({...r,browserTabId:'actually-later'}),timestamp:'1900-01-01T00:00:00Z'};
 expect(latestXResearchTab([{...history(r),timestamp:'2100-01-01T00:00:00Z'},later])).toBe('actually-later');
 expect(latestXResearchTab([])).toBeUndefined();
});
