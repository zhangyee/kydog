import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { expect, it } from 'vitest';
import { readX } from './xResearchRead';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XResearchEvidence } from './xResearchEvidence';
import { serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
import { fixture, stagedFixture, post, readHtml } from '../../test-support/xResearchFixture';
import { createXResearchRunner } from './xResearchRunner';
import { parseXResearchWork } from './xResearchInput';
import { XResearchScopeLedger } from './xResearchScopeFacts';
import type { XResearchResult, XSourceReference, XTextObservation } from './xResearchTypes';
const url = 'https://x.com/alice/status/123';
const report = '/tmp/x-research-topic-2026-10-12.md';
const citation = (u = url) => `Observed evidence [source](${u})`;

/** 一份真结果走生产的工作体（runner）：旧的非动作式工具已删，采集的唯一入口就是它。
 *  `observe` 在这里手动调用 —— 生产上它挂在交付（`wait`）那条路上（可引用 = 已交付）。 */
async function collect(
  f: ReturnType<typeof fixture>,
  raw: Record<string, unknown>,
  deps: { callId: string; runId: string; sources?: Map<string, XSourceReference[]>; observe?(result: XResearchResult): void },
): Promise<XResearchResult> {
  const work = parseXResearchWork(raw);
  if (!('read' in work)) throw new Error('read work expected');
  const tabId = raw.tabId;
  if (typeof tabId !== 'string') throw new Error('tabId expected');
  const ledger = new XResearchScopeLedger();
  const runner = createXResearchRunner({
    browserFor: () => f.context.browser,
    contextFor: () => ({
      sources: deps.sources ?? f.context.sources,
      scopePrior: (runId) => ledger.prior(runId),
      currentRunId: () => deps.runId,
    }),
    artifacts: () => tempXArtifactStore(),
  });
  const result = await runner({ read: work.read }, {
    threadId: 'thread', researchRunId: 'research', submissionId: 'submission',
    batchId: 'batch', runId: deps.runId, submitCallId: deps.callId,
    signal: new AbortController().signal,
    tabBinding: { get: () => tabId, set: () => undefined },
    onProgress: () => undefined,
  });
  deps.observe?.(result);
  return result;
}

async function result() {
  const f = fixture([readHtml(post())]);
  const r = await collect(f, {
    tabId: 'research-tab',
    read: { objective: 'read', targets: [{ url }], includeArticle: false, includeReplies: false },
  }, { callId: 'call', runId: 'run' });
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
    const fresh=await result();
    const physical=await readX({tabId:'research-tab',read:{objective:'source diagnostics',targets:[{url}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:1}},(await stagedFixture({semanticLabels:true})).context);
    fresh.targets[0].diagnostics=physical.targets[0].diagnostics;
    const frame=fresh.targets[0].diagnostics?.firstAdmittedFrame;
    expect(frame?.sourceRootState).toMatchObject({root:{connection:'connected'},identity:{coordinates:'same'}});
    expect(frame?.replyUiInventory?.capture).toMatchObject({state:'checked',nodes:[{text:'Show replies'},{text:'initial 回复'}]});
    expect(fresh.targets[0].diagnostics?.terminalFrame?.replyUiInventory?.capture).toMatchObject({state:'checked',nodes:[{text:'Show replies'},{text:'initial 回复'}]});
    expect(frame?.snapshotId).toMatch(/^xsnap_/);
    const old=structuredClone(fresh);
    old.sourceKind='rendered_ui';old.targets[0].root!.sourceKind='rendered_ui';delete old.targets[0].root!.networkProvenance;delete old.targets[0].identity;delete old.targets[0].networkPages;old.targets[0].replies.scope={rootPostId:'123',branch:null,sort:null,displayedReplyCount:null,completeness:'unknown',endEvidence:null,stopReason:'agent_stopped'};
    delete old.targets[0].diagnostics;
    const {retainReadBody}=await import('./xResearchReadStages');
    const current=fresh.targets[0].root!;
    for(let i=0;i<100;i++)retainReadBody(fresh.targets[0],{...structuredClone(current),observationId:`sdk-history-${i}`,text:'历史'.repeat(2000),truncation:{returned:4000,totalKnown:4000,truncated:false}});
    retainReadBody(fresh.targets[0],{...structuredClone(current),observationId:'sdk-gap',text:'old',truncation:{returned:3,totalKnown:3,truncated:false},articlePreviewInventory:{scope:'collection',observed:0,retained:0,omitted:0,unresolved:1}});
    const manager=SessionManager.create(dir,dir);
    const base=manager.appendMessage({role:'user',content:'read history',timestamp:1});
    const payloads=new Map<string,ReturnType<typeof xResearchToolResult>>();
    const record=(details:typeof fresh)=>{
      const payload=xResearchToolResult(serializeXResearchResult(details));
      const id=manager.appendMessage({role:'toolResult',toolName:'x_research',toolCallId:details.callId,content:payload.content,details:payload.details,isError:false,timestamp:2});
      payloads.set(id,payload);return id;
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
      expect(saved.details).toEqual(payloads.get(id)!.details);
      expect(saved.content).toEqual(payloads.get(id)!.content);
      const details=saved.details as typeof fresh;
      expect(details.targets[0].root!.text).toBe(current.text);
      if(expected){
        expect(details.targets[0].bodyObservationsOmitted).toBeGreaterThan(0);
        expect(details.targets[0].articlePreviewObservations).toContainEqual(expect.objectContaining({observationId:'sdk-gap',articlePreviewInventory:{scope:'collection',observed:0,retained:0,omitted:0,unresolved:1}}));
      }
      expect(details.targets[0].diagnostics?.firstAdmittedFrame?.snapshotId).toBe(expected);
      expect(details.targets[0].diagnostics?.firstAdmittedFrame?.sourceRootState).toEqual(expected?frame?.sourceRootState:undefined);
      expect(JSON.stringify({...details,objective:'collectionKey'})).toMatch(/__kydogXRootState|collectionKey|permissionNamespace/);
      expect(JSON.stringify(details)).not.toMatch(/__kydogXRootState|collectionKey|permissionNamespace/);
      expect(JSON.parse(saved.content[0].type==='text'?saved.content[0].text:'{}').targets[0].diagnostics?.firstAdmittedFrame?.snapshotId).toBe(expected);
      const ledger=new XResearchEvidence(dir,()=> 'restored-run');
      ledger.restore(reopened.getBranch());
      if(expected){
        const plain=new XResearchEvidence(dir,()=> 'restored-run');plain.observe(old);expect(plain.guard(report,citation())).toEqual({createOnly:true});
        expect(()=>ledger.guard(report,citation())).toThrow(/inventory is unknown/);
        const qualified=await readX({tabId:'research-tab',read:{objective:'resolve gap',targets:[{url}],includeArticle:true,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:3}},(await stagedFixture({article:'ok'})).context);
        ledger.observe(qualified);expect(ledger.guard(report,citation())).toEqual({createOnly:true});
      }else expect(ledger.guard(report,citation())).toEqual({createOnly:true});
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
    sourceKind: 'rendered_ui',networkProvenance:undefined,
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
  body.sourceKind='mixed';
  ledger.restore([history(body)]);
  expect(ledger.guard(report, citation())).toEqual({ createOnly: true });
  expect(
    ledger.guard(report, citation('https://x.com/articleauthor/status/456')),
  ).toEqual({ createOnly: true });
  body.targets[0].article.body.author!.handle = 'alice';
  body.sourceKind='mixed';
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
    sourceKind: 'page_graphql',
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
it('legacy navigation hints resolve a fresh ID read without stamping legacy provenance onto network reads', async () => {
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
  const collected = await collect(f, {
    tabId: 'research-tab',
    read: { objective: 'read', targets: [{ postId: '123' }], includeArticle: false, includeReplies: false },
  }, { callId: 'new-call', runId: 'new-run', sources: l.sources, observe: (r) => l.observe(r) });
  const output = { details: collected };
  expect(f.open.mock.calls[0][0]).toBe(url);
  expect(output.details).toMatchObject({
    runId: 'new-run',
    callId: 'new-call',
    targets: [
      {
        root: {
          sourceKind: 'page_graphql',
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
    ['page_graphql', 'new-run'],
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
      sourceKind: 'rendered_ui',networkProvenance:undefined,
      containerKind: 'article',
      postId: '456',
      sourceUrl: e.targetUrl,
      author: { handle: 'articleauthor', displayName: null, profileUrl: null },
      articlePreviews: undefined,
    },
  };
  r.sourceKind='mixed';
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
      sourceKind: 'rendered_ui',networkProvenance:undefined,
      containerKind: 'article',
      postId: '456',
      sourceUrl: known.targetUrl,
      author: { handle: 'articleauthor', displayName: null, profileUrl: null },
      articlePreviews: undefined,
    },
  };
  r.sourceKind='mixed';
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

async function rootlessEvidence(body=post('456','bob','fresh own body')) {
  return readX({tabId:'research-tab',read:{objective:'rootless',targets:[{url}],includeArticle:false,includeReplies:true,maxRepliesPerPost:30,maxScrollsPerPost:1,maxExpandActionsPerPost:0}},fixture([readHtml(body)]).context);
}
it('unscoped source role authorizes only its own nonempty body and survives actual SDK branch restore',async()=>{
  const preview=post('789','carol','preview body').replace('</article>','<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/writer">@writer</a></div><div data-testid="article-cover-image">Article</div></div></article>');
  const r=await rootlessEvidence(post('456','bob','fresh own body')+preview);
  const own='https://x.com/bob/status/456';
  expect(r.targets[0].unscopedPosts?.observations[0]).toMatchObject({containerKind:'unscoped_post',relationToTarget:'unproven',observedContainer:'post'});
  const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(r);
  expect(ledger.guard(report,citation(own))).toEqual({createOnly:true});
  expect(ledger.observations[0]).toMatchObject({containerKind:'unscoped_post',relationToTarget:'unproven',observedContainer:'post'});
  expect(ledger.sources.get('456')).toEqual([expect.objectContaining({rootObservationId:null,query:null,sourceUrl:own})]);
  expect(()=>ledger.guard(report,citation())).toThrow(/unobserved/);
  for(const requested of [false,undefined]){
    const wrong=structuredClone(r);
    Object.assign(wrong.targets[0].replies,{requested});
    ledger.restore([history(wrong)]);expect(()=>ledger.guard(report,citation(own))).toThrow(/unobserved/);
  }
  for(const slot of ['root','quotedPosts','replies','article'] as const){
    const wrong=structuredClone(r),row=wrong.targets[0],p=row.unscopedPosts!.observations[0];delete row.unscopedPosts;
    if(slot==='root') row.root=p as never;
    if(slot==='quotedPosts') row.quotedPosts=[p as never];
    if(slot==='replies') row.replies.observations=[p as never];
    if(slot==='article'){row.article.body=p as never;row.article.bodyObserved=true;}
    ledger.restore([history(wrong)]);expect(()=>ledger.guard(report,citation(own))).toThrow(/unobserved/);
  }
  // Displaced independent versions now use the existing body history field;
  // role and reply-domain policy still apply to that exact historical item.
  const historyOnly=structuredClone(r),historyRow=historyOnly.targets[0];
  historyRow.bodyObservations=[historyRow.unscopedPosts!.observations[0]];delete historyRow.unscopedPosts;
  ledger.restore([history(historyOnly)]);expect(ledger.guard(report,citation(own))).toEqual({createOnly:true});
  expect(ledger.observations.find(p=>p.sourceUrl===own)).toMatchObject({containerKind:'unscoped_post',relationToTarget:'unproven'});
  const malformedHistory=structuredClone(historyOnly);malformedHistory.targets[0].bodyObservations={} as never;
  expect(()=>ledger.restore([history(malformedHistory)])).not.toThrow();expect(()=>ledger.guard(report,citation(own))).toThrow(/unobserved/);
  for(const requested of [false,undefined]){
    const disabled=structuredClone(historyOnly);Object.assign(disabled.targets[0].replies,{requested});
    ledger.restore([history(disabled)]);expect(()=>ledger.guard(report,citation(own))).toThrow(/unobserved/);
  }
  for(const field of ['relationToTarget','observedContainer','sourceUrl','text'] as const){
    const wrong=structuredClone(r),p=wrong.targets[0].unscopedPosts!.observations[0];
    Object.assign(p,{[field]:field==='relationToTarget'?'reply':field==='observedContainer'?'quote':field==='sourceUrl'?url:''});
    ledger.restore([history(wrong)]);expect(()=>ledger.guard(report,citation(own))).toThrow(/unobserved/);
  }
  const {SessionManager}=await import('@earendil-works/pi-coding-agent');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kydog-unscoped-sdk-'));
  try{
    const manager=SessionManager.create(dir,dir),base=manager.appendMessage({role:'user',content:'source',timestamp:1});
    const payload=xResearchToolResult(serializeXResearchResult(r));
    const fresh=manager.appendMessage({role:'toolResult',toolName:'x_research',toolCallId:'call',...payload,isError:false,timestamp:2});
    manager.branch(base);
    const falsePayload=structuredClone(payload);
    if(falsePayload.details.operation!=='read')throw new Error('expected read');
    falsePayload.details.targets[0].replies.requested=false;
    const disabled=manager.appendMessage({role:'toolResult',toolName:'x_research',toolCallId:'call',...falsePayload,isError:false,timestamp:2});
    manager.branch(base);
    const sibling=manager.appendMessage({role:'assistant',content:[{type:'text',text:JSON.stringify(payload)}],api:'openai-completions',provider:'openai',model:'fixture',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:3});
    const reopened=SessionManager.open(manager.getSessionFile()!);
    reopened.branch(fresh);ledger.restore(reopened.getBranch());
    expect(ledger.guard(report,citation(own))).toEqual({createOnly:true});
    expect(ledger.observations[0]).toMatchObject({origin:'history',relationToTarget:'unproven',observedContainer:'post'});
    expect(()=>ledger.guard(report,citation('https://x.com/carol/status/789'))).toThrow(/inventory is unknown/);
    reopened.branch(disabled);ledger.restore(reopened.getBranch());
    expect(()=>ledger.guard(report,citation(own))).toThrow(/unobserved/);
    reopened.branch(sibling);ledger.restore(reopened.getBranch());
    ledger.sources.set('456',[{urlKind:'permalink',sourceUrl:own,observationId:'fake',rootObservationId:null,observedAt:'now',containerKind:'unscoped_post',runId:'run',callId:'call',batchId:'batch',queryId:null,query:null,purpose:null,product:null}]);
    expect(()=>ledger.guard(report,citation(own))).toThrow(/unobserved/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
it('unscoped preview obligations survive missing bodies and resolve only in a later exact parent family',async()=>{
  const cover='<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/writer">@writer</a></div><div data-testid="article-cover-image">Article</div></div>';
  const parent=(id:string,name:string,text:string)=>post(id,name,text).replace('</article>',cover+'</article>');
  const old=await rootlessEvidence(post('456','bob','old A')+post('789','carol','old B'));
  const fresh=await rootlessEvidence(parent('456','bob','preview A')+parent('789','carol',''));
  expect(fresh.targets[0].unscopedPosts?.previewGaps).toHaveLength(2);
  const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(old);
  for(const own of ['https://x.com/bob/status/456','https://x.com/carol/status/789'])expect(ledger.guard(report,citation(own))).toEqual({createOnly:true});
  // Retention omits every new body; mandatory exact-parent facts still prohibit both old bodies.
  const trimmed=structuredClone(fresh);trimmed.targets[0].unscopedPosts!.observations=[];trimmed.targets[0].unscopedPosts!.inventory.retained=0;trimmed.targets[0].unscopedPosts!.inventory.omitted=trimmed.targets[0].unscopedPosts!.inventory.observed;
  ledger.observe(trimmed);
  for(const own of ['https://x.com/bob/status/456','https://x.com/carol/status/789'])expect(()=>ledger.guard(report,citation(own))).toThrow(/inventory is unknown/);
  const attempt=await readX({tabId:'research-tab',read:{objective:'accurate parent',targets:[{url:'https://x.com/bob/status/456'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(parent('456','bob','parent body'))]).context);
  attempt.targets[0].article.actionAttempted=true;
  const samePacket=structuredClone(trimmed);samePacket.targets.push(attempt.targets[0]);
  ledger.restore([history(old),history(samePacket)]);
  expect(()=>ledger.guard(report,citation('https://x.com/bob/status/456'))).toThrow(/inventory is unknown/);
  ledger.observe(attempt);
  expect(ledger.guard(report,citation('https://x.com/bob/status/456'))).toEqual({createOnly:true});
  expect(()=>ledger.guard(report,citation('https://x.com/carol/status/789'))).toThrow(/inventory is unknown/);
});


it('canonical parsing rejects forged inventory bindings and diagnostic labels never grant citations',async()=>{
  const valid=await result(),ledger=new XResearchEvidence('/tmp',()=> 'run');
  expect(valid.targets[0].diagnostics?.initialFrame?.replyUiInventory?.capture.state).toBe('checked');
  for(const change of [
    (r:typeof valid)=>r.targets[0].diagnostics!.initialFrame!.regionNodeId!++,
    (r:typeof valid)=>r.targets[0].diagnostics!.firstAdmittedFrame!.sourceEndDetector='implemented' as never,
    (r:typeof valid)=>r.targets[0].diagnostics!.terminalFrame!.replyUiInventory!.capture={state:'checked'} as never,
  ]){
    ledger.restore([history(valid)]);expect(ledger.guard(report,citation())).toEqual({createOnly:true});
    const bad=structuredClone(valid);
    for(const key of ['initialFrame','firstAdmittedFrame','terminalFrame'] as const)bad.targets[0].diagnostics![key]=structuredClone(valid.targets[0].diagnostics![key]);
    change(bad);ledger.restore([history(bad)]);
    expect(()=>ledger.guard(report,citation())).toThrow(/unobserved/);
  }
  const f=fixture([readHtml(post()+'<div role="status">End of conversation https://x.com/other/status/999</div>')]);
  const diagnostic=await readX({tabId:'tab',read:{objective:'read',targets:[{url}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},f.context);
  ledger.restore([history(diagnostic)]);expect(ledger.guard(report,citation())).toEqual({createOnly:true});
  expect(()=>ledger.guard(report,citation('https://x.com/other/status/999'))).toThrow(/unobserved/);
});

it('retains validated network provenance in production and restored evidence alongside rendered UI history',async()=>{
 const {searchX}=await import('./xResearchSearch');const {searchHtml}=await import('../../test-support/xResearchFixture');
 const f=fixture([searchHtml(post())]);
 const network=await searchX({search:{objective:'source',queries:[{id:'q',query:'test',purpose:'test',product:'Top'}],maxPostsPerQuery:1,maxScrollsPerQuery:0}},f.context);
 const provenance=network.queries[0].posts[0].networkProvenance!;
 const ledger=new XResearchEvidence('/tmp',()=>network.runId);ledger.observe(network);
 expect(ledger.observations[0]).toMatchObject({sourceKind:'page_graphql',networkProvenance:provenance});
 const old=await result();old.sourceKind='rendered_ui';old.targets[0].root!.sourceKind='rendered_ui';delete old.targets[0].root!.networkProvenance;delete old.targets[0].identity;delete old.targets[0].networkPages;old.targets[0].replies.scope={rootPostId:'123',branch:null,sort:null,displayedReplyCount:null,completeness:'unknown',endEvidence:null,stopReason:'agent_stopped'};ledger.restore([history(network),history(old)]);
 expect(ledger.observations.find(p=>p.sourceKind==='page_graphql')).toMatchObject({origin:'history',networkProvenance:provenance});
 const rendered=ledger.observations.find(p=>p.sourceKind==='rendered_ui');expect(rendered).toBeDefined();expect(rendered).not.toHaveProperty('networkProvenance');
});

it('restores rendered UI end as historical UI evidence and rejects a mismatched network end upgrade',async()=>{
 const r=await result();r.sourceKind='rendered_ui';const row=r.targets[0];row.root!.sourceKind='rendered_ui';delete row.root!.networkProvenance;delete row.identity;delete row.networkPages;
 row.replies.scope={rootPostId:'123',branch:null,sort:null,displayedReplyCount:null,completeness:'ui_scope_end_observed',stopReason:'explicit_ui_end',endEvidence:{observationId:'historic-ui-end',text:'Visible branch end',sourceUrl:url,observedAt:'2026-10-12T00:00:00Z',rootPostId:'123',branch:null,sort:null}};
 const ledger=new XResearchEvidence('/tmp',()=> 'restored');ledger.restore([history(r)]);expect(ledger.guard(report,citation())).toEqual({createOnly:true});expect(ledger.observations[0]).toMatchObject({sourceKind:'rendered_ui',origin:'history'});
 const {XResearchScopeLedger}=await import('./xResearchScopeFacts');const scopes=new XResearchScopeLedger();scopes.restore([history(r)]);expect(scopes.prior('run').withCurrent(r).read.replyScopeCounts).toEqual({ui_scope_end_observed:1});
 const invalid=structuredClone(r);invalid.targets[0].replies.scope={kind:'network',rootPostId:'123',extent:'cursor_exhausted',context:{leaseId:'invented',accountContextId:null,branchKey:'ShowMoreThreads',sortKey:'Relevance'},terminalRequestRef:'historic-ui-end',stopReason:'cursor_exhausted'};
 ledger.restore([history(invalid)]);expect(()=>ledger.guard(report,citation())).toThrow(/unobserved/);
});
