import { publicXArticleEntryIdentity } from './xResearchCanonical';
import { reportScopeFacts, type XResearchScopePrior } from './xResearchScopeFacts';
import { projectActionDiagnostics } from './xActionDiagnostics';
import { replyUiFrameSchema } from './xReplyUiInventory';
import { sourceRootStateSchema } from './xDomSource';
import {
  X_MAX_ARTICLE_IDENTITY_HREF_UNITS,
  X_MAX_HANDLE_UNITS,
  X_MAX_POST_ID_UNITS,
  X_MAX_SOURCE_URL_UNITS,
} from './xResearchIdentity';
import {
  X_RESEARCH_MAX_OUTPUT_BYTES,
  type XResearchResult,
  type XTextObservation,
  type XUnscopedPost,
  type XCollectionTransition,
} from './xResearchTypes';

export interface XSerializedResult<
  T extends XResearchResult = XResearchResult,
> {
  result: T;
  text: string;
}
export function xResearchToolResult(value: XSerializedResult): {
  content: { type: 'text'; text: string }[];
  details: XResearchResult;
} {
  return {
    content: [{ type: 'text', text: value.text }],
    details: value.result,
  };
}
function texts(result: XResearchResult): (XTextObservation | XUnscopedPost)[] {
  return result.operation === 'search'
    ? result.queries.flatMap((q) => [...q.posts,...(q.postObservations??[])])
    : result.targets.flatMap((t) => [
        ...(t.root ? [t.root] : []),
        ...(t.bodyObservations ?? []),
        ...t.quotedPosts,
        ...(t.article.body ? [t.article.body] : []),
        ...t.replies.observations,
        ...(t.unscopedPosts?.observations ?? []),
      ]);
}
// Preserve the observation's own Article obligations, even when its primary
// candidate is later omitted. Identity validation remains the evidence ledger's job.
function protectedSearchHistory(p: XTextObservation): boolean {
  return !!p.articlePreviews?.length || !!p.articlePreviewInventory &&
    (p.articlePreviewInventory.omitted > 0 || p.articlePreviewInventory.unresolved > 0);
}
function body(p: XTextObservation | XUnscopedPost) {
  return {
    ...(p.articlePreviewInventory ? {articlePreviewInventory:p.articlePreviewInventory}:{}),
    ...(p.articlePreviews ? { articlePreviews: p.articlePreviews } : {}),
    observationId: p.observationId,
    postId: p.postId,
    sourceUrl: p.sourceUrl,
    authorHandle: p.author?.handle ?? null,
    containerKind: p.containerKind,
    ...(p.containerKind==='unscoped_post'?{relationToTarget:p.relationToTarget,observedContainer:p.observedContainer}:{}),
    ...(p.containerKind === 'reply' ? { directParent: p.directParent } : {}),
    text: p.text,
    truncation: p.truncation,
  };
}
function documentSourceProjection(
  result: XResearchResult,
  t: Extract<XResearchResult, { operation: 'read' }>['targets'][number],
  index: number,
) {
  const source = t.documentSource;
  if (!source) return null;
  const rootObservationId = source.rootObservationId;
  // This reference points to a literal URL already visible in this SAME model row.
  if (
    t.root &&
    rootObservationId === t.root.observationId &&
    source.sourceUrl === t.root.sourceUrl
  ) {
    return { rootObservationId, sourceUrlReference: 'root.sourceUrl' as const };
  }
  if (
    result.contentMetadataOmissions?.includes(
      `targets.${index}.documentSource.sourceUrl`,
    )
  ) {
    return { rootObservationId, sourceUrlInCanonicalDetails: true };
  }
  return { rootObservationId, sourceUrl: source.sourceUrl };
}
function compactModelDocumentLocations(result: XResearchResult): void {
  if (result.operation !== 'read') return;
  const omitted = (result.contentMetadataOmissions ??= []);
  result.targets.forEach((t, index) => {
    if (
      !t.documentSource ||
      (t.root &&
        t.documentSource.rootObservationId === t.root.observationId &&
        t.documentSource.sourceUrl === t.root.sourceUrl)
    )
      return;
    const path = `targets.${index}.documentSource.sourceUrl`;
    if (!omitted.includes(path)) omitted.push(path);
  });
}
/** Only original request prose is omitted from model content. Every retained
 * body carries its own observed identity; details are not a model-visible source. */
function projection(result: XResearchResult) {
  const base = {
    contentProjection: 'x_research_projection_v1',
    requestReferences:
      'indices refer to original arguments; observed body identities are included here',
    schemaVersion: 2,
    sourceKind: result.sourceKind,
    operation: result.operation,
    browserTabId: result.browserTabId,
    callId: result.callId,
    batchId: result.batchId,
    runId: result.runId,
    status: result.status,
    reportScopeFacts: result.reportScopeFacts,
    ...(result.reportRunScopeFacts ? {reportRunScopeFacts: result.reportRunScopeFacts} : {}),
    budgetUsage: result.budgetUsage,
    truncation: result.truncation,
    metadataOmissions: result.metadataOmissions ?? [],
    contentMetadataOmissions: result.contentMetadataOmissions ?? [],
  };
  if (result.operation === 'search')
    return {
      ...base,
      queries: result.queries.map((q, index) => ({
        queryIndex: index,
        ...(q.diagnostics?{diagnostics:q.diagnostics}:{}),
        product: q.query.product,
        status: q.status,
        stopReason: q.stopReason,
        budgetUsage: q.budgetUsage,
        posts: q.posts.map(body),
        ...(q.postObservations?{postObservations:q.postObservations.map(body)}:{}),
        ...(q.postObservationsOmitted?{postObservationsOmitted:q.postObservationsOmitted}:{}),
        barrier: q.barrier,
        collectionTransitions: q.collectionTransitions,
      })),
    };
  return {
    ...base,
    targets: result.targets.map((t, index) => ({
      targetIndex: index,
      ...(t.unscopedPosts?{unscopedPosts:{...t.unscopedPosts,observations:t.unscopedPosts.observations.map(body)}}:{}),
      ...(t.articlePreviewObservations?{articlePreviewObservations:t.articlePreviewObservations}:{}),
      ...(t.inventoryAuditOmitted?{inventoryAuditOmitted:t.inventoryAuditOmitted}:{}),
      inputKind: t.inputKind,
      inputUrlRedacted: t.inputUrlRedacted,
      postId: t.postId,
      status: t.status,
      reason: t.reason,
      ...(t.diagnostics ? {diagnostics:t.diagnostics} : {}),
      stopReason: t.stopReason,
      budgetUsage: t.budgetUsage,
      root: t.root ? body(t.root) : null,
      quotedPosts: t.quotedPosts.map(body),
      ...(t.bodyObservations ? {bodyObservations: t.bodyObservations.map(body)} : {}),
      ...(t.bodyObservationsOmitted ? {bodyObservationsOmitted: t.bodyObservationsOmitted} : {}),
      article: {
        ...(t.article.provenance ? {provenance:t.article.provenance} : {}),
        ...(t.article.entryIdentity
          ? { entryIdentity: t.article.entryIdentity }
          : {}),
        requested: t.article.requested,
        entryObserved: t.article.entryObserved,
        actionAttempted: t.article.actionAttempted,
        navigationStarted: t.article.navigationStarted,
        bodyObserved: t.article.bodyObserved,
        body: t.article.body ? body(t.article.body) : null,
        barrier: t.article.barrier,
      },
      replies: {
        requested: t.replies.requested,
        observations: t.replies.observations.map(body),
        scope: t.replies.scope,
      },
      documentSource: documentSourceProjection(result, t, index),
      barrier: t.barrier,
      collectionTransitions: t.collectionTransitions,
    })),
  };
}
/** Fixed points include both JSON escaping and the decimal byte counters. */
function measure<T extends XResearchResult>(
  result: T,
  projected = false,
  prior?: XResearchScopePrior,
): XSerializedResult<T> {
  result.reportScopeFacts = reportScopeFacts(result);
  if (prior) result.reportRunScopeFacts = prior.withCurrent(result);
  else delete result.reportRunScopeFacts;
  const rows = result.operation === 'search' ? result.queries : result.targets;
  for (;;) {
    const projectedRows = projected
      ? result.operation === 'search'
        ? (projection(result) as { queries: unknown[] }).queries
        : (projection(result) as { targets: unknown[] }).targets
      : null;
    let changed = false;
    rows.forEach((row, index) => {
      const json = JSON.stringify(row),
        model = JSON.stringify(projectedRows?.[index] ?? row);
      const bytes =
        Buffer.byteLength(json, 'utf8') +
        Buffer.byteLength(JSON.stringify(model), 'utf8') -
        2;
      if (bytes !== row.budgetUsage.outputBytes) {
        row.budgetUsage.outputBytes = bytes;
        changed = true;
      }
    });
    if (!changed) break;
  }
  for (;;) {
    const text = JSON.stringify(projected ? projection(result) : result);
    const bytes = Buffer.byteLength(
      JSON.stringify(xResearchToolResult({ result, text })),
      'utf8',
    );
    if (bytes === result.budgetUsage.outputBytes) return { result, text };
    result.budgetUsage.outputBytes = bytes;
  }
}
const emptySafe = () => ({
  origin: null,
  path: null,
  q: null,
  f: null,
  fragment: null,
  redacted: true,
});
function compactMetadata(result: XResearchResult): void {
  const omitted = (result.metadataOmissions ??= []);
  const mark = (path: string) => {
    if (!omitted.includes(path)) omitted.push(path);
  };
  const rows = result.operation === 'search' ? result.queries : result.targets;
  rows.forEach((row, index) => {
    const prefix = `${result.operation === 'search' ? 'queries' : 'targets'}.${index}`;
    if (row.location) {
      row.location.requested = emptySafe();
      mark(`${prefix}.location.requested`);
      if (row.location.committed) {
        row.location.committed = null;
        mark(`${prefix}.location.committed`);
      }
      if (row.location.subsequent) {
        row.location.subsequent = null;
        mark(`${prefix}.location.subsequent`);
      }
    }
    for (const [n, t] of row.collectionTransitions.entries()) {
      t.before.location = emptySafe();
      t.after.location = emptySafe();
      mark(`${prefix}.collectionTransitions.${n}.locations`);
    }
    if (row.barrier) {
      row.barrier.reason = 'omitted_due_output_budget';
      mark(`${prefix}.barrier.reason`);
    }
  });
  if (result.operation === 'read')
    result.targets.forEach((t, index) => {
      const prefix = `targets.${index}`;
      if (t.article.location) {
        t.article.location.requested = emptySafe();
        mark(`${prefix}.article.location.requested`);
        if (t.article.location.committed) {
          t.article.location.committed = null;
          mark(`${prefix}.article.location.committed`);
        }
        if (t.article.location.subsequent) {
          t.article.location.subsequent = null;
          mark(`${prefix}.article.location.subsequent`);
        }
      }
      if (t.article.barrier) {
        t.article.barrier.reason = 'omitted_due_output_budget';
        mark(`${prefix}.article.barrier.reason`);
      }
      if (t.article.body?.author) {
        if (t.article.body.author.profileUrl !== null) {
          t.article.body.author.profileUrl = null;
          mark(`${prefix}.article.body.author.profileUrl`);
        }
        if (t.article.body.author.displayName !== null) {
          t.article.body.author.displayName = null;
          mark(`${prefix}.article.body.author.displayName`);
        }
      }
      if (t.root?.author) {
        if (t.root.author.profileUrl !== null) {
          t.root.author.profileUrl = null;
          mark(`${prefix}.root.author.profileUrl`);
        }
        if (t.root.author.displayName !== null) {
          t.root.author.displayName = null;
          mark(`${prefix}.root.author.displayName`);
        }
      }
      // Exact equality, not URL normalization. This alias loses no source fact.
      if (t.root && t.sourceUrl !== null && t.sourceUrl === t.root.sourceUrl) {
        t.sourceUrl = null;
        t.sourceUrlReference = 'root.sourceUrl';
        mark(`${prefix}.sourceUrl (exact alias root.sourceUrl)`);
      }
      if (t.article.entry) {
        t.article.entry = null;
        mark(`${prefix}.article.entry`);
      }
    });
}
/** Admissibility sizes a required-state representation, not max100 optional
 * candidates/replies. Source identity strings follow the shared official public identity
 * boundary. UUID/ISO/counter sizes follow production generators. This
 * sizing-only object is never returned, remembered or treated as evidence. */
export function assertXRequestFits(original: XResearchResult, prior?: XResearchScopePrior): void {
  const state = structuredClone(original);
  if (!state.browserTabId) state.browserTabId = 'tab_00000000'; // actual tab_<UUID slice8> format
  const uuid = '00000000-0000-0000-0000-000000000000',
    date = '0'.repeat(27);
  const rows = state.operation === 'search' ? state.queries : state.targets;
  const transition = (
    stage: 'search' | 'post' | 'article',
  ): XCollectionTransition => ({
    stage,
    before: {
      location: emptySafe(),
      documentEpoch: Number.MAX_SAFE_INTEGER,
      routeRevision: Number.MAX_SAFE_INTEGER,
      navigationSequence: Number.MAX_SAFE_INTEGER,
      navigationEvent: 'did-navigate-in-page',
    },
    after: {
      location: emptySafe(),
      documentEpoch: Number.MAX_SAFE_INTEGER,
      routeRevision: Number.MAX_SAFE_INTEGER,
      navigationSequence: Number.MAX_SAFE_INTEGER,
      navigationEvent: 'did-navigate-in-page',
    },
    relation: {
      origin: 'different',
      path: 'different',
      postId: 'different',
      query: 'different',
      product: 'different',
      fragment: 'different',
    },
    rereadRequested: true,
    outcome: 'same_url_generation_changed',
  });
  rows.forEach((row) => {
    row.status = 'action_required';
    row.stopReason = 'navigation_failed';
    row.budgetUsage = {
      scrolls: 20,
      expandActions: 20,
      distinctEntries: 100,
      outputBytes: X_RESEARCH_MAX_OUTPUT_BYTES,
    };
    row.barrier = {
      status: 'action_required',
      reason: 'omitted_due_output_budget',
      observationId: uuid,
    };
    row.location = {
      committedNavigationOutcome: 'ok_same_document',
      requested: emptySafe(),
      committed: null,
      subsequent: null,
      relation: {
        origin: 'different',
        path: 'different',
        postId: 'different',
        query: 'different',
        product: 'different',
        fragment: 'different',
      },
      documentGeneration: '0'.repeat(50),
      navigationEvent: 'did-navigate-in-page',
    };
    row.collectionTransitions = [
      transition(state.operation === 'search' ? 'search' : 'post'),
      transition(state.operation === 'search' ? 'search' : 'post'),
    ];
  });
  if (state.operation === 'read')
    state.targets.forEach((t) => {
      const phases: NonNullable<XCollectionTransition['navigationPhase']>[] = t
        .article.requested
        ? ['initial_post', 'article', 'article', 'return_post', 'return_post']
        : ['initial_post', 'initial_post'];
      t.collectionTransitions = phases.map((navigationPhase) => ({
        ...transition(navigationPhase === 'article' ? 'article' : 'post'),
        navigationPhase,
        navigationId: uuid,
      }));
      if (t.article.requested) {
        t.article.location = structuredClone(t.location!);
        t.article.barrier = structuredClone(t.barrier);
      }
      t.reason = 'collection_failed:browser.not_dispatchable';
      const id = t.postId;
      // Source protocol limits are shared with the decoder; prose has a separate bound.
      const handleUnits = id ? X_MAX_HANDLE_UNITS : 0;
      if (id && handleUnits >= 1) {
        t.root = {
          observationId: uuid,
          sourceKind: 'rendered_ui',
          sourceUrl: 'u'.repeat(X_MAX_SOURCE_URL_UNITS),
          author: {
            handle: 'a'.repeat(handleUnits),
            displayName: 'd',
            profileUrl: 'p',
          },
          text: '',
          observedAt: date,
          truncation: { returned: 0, totalKnown: 4000, truncated: true },
          containerKind: 'root_post',
          postId: id,
        };
        t.sourceUrl = t.root.sourceUrl;
        t.replies.scope.rootPostId = id;
        t.documentSource = {
          urlKind: 'document',
          sourceUrl: 'v'.repeat(X_MAX_SOURCE_URL_UNITS),
          observationId: uuid,
          rootObservationId: uuid,
          observedAt: date,
          containerKind: 'root_post',
          runId: state.runId,
          callId: state.callId,
          batchId: state.batchId,
          queryId: null,
          query: null,
          purpose: null,
          product: null,
        };
      }
      if (t.article.requested && t.root) {
        t.article.provenance={kind:'direct_open',navigationId:uuid,bodyObservationId:uuid,sourceUrl:'w'.repeat(X_MAX_SOURCE_URL_UNITS),nativeIdentity:{kind:'owned_analytics',href:'w'.repeat(X_MAX_ARTICLE_IDENTITY_HREF_UNITS),documentGeneration:`${Number.MAX_SAFE_INTEGER}:${Number.MAX_SAFE_INTEGER}:${Number.MAX_SAFE_INTEGER}`}};
        t.article.body = {
          ...structuredClone(t.root),
          containerKind: 'article',
          postId: '1'.repeat(X_MAX_POST_ID_UNITS),
          sourceUrl: 'w'.repeat(X_MAX_SOURCE_URL_UNITS),
          author: {
            handle: 'b'.repeat(X_MAX_HANDLE_UNITS),
            displayName: 'd',
            profileUrl: 'p',
          },
        };
      }
      // This local clone is ONLY an exact envelope-size probe. These maximum-width
      // strings are never serialized as a result, returned, or given to a source ledger.
      // Include both copies required when a preview and attempted entry are retained.
      if (t.root) {
        const sizingIdentity = {
          entryObservationId: uuid,
          parentPostId: id!,
          sourceUrl: t.root.sourceUrl!,
          targetUrl: t.article.body?.sourceUrl ?? t.root.sourceUrl!,
        };
        t.root.articlePreviews = [sizingIdentity];
        t.root.articlePreviewInventory={scope:'collection',observed:100,retained:1,omitted:99,unresolved:100};
        t.bodyObservationsOmitted=Number.MAX_SAFE_INTEGER;
        t.inventoryAuditOmitted={count:Number.MAX_SAFE_INTEGER,first:{observationId:uuid,postId:t.root.postId!,sourceUrl:t.root.sourceUrl!,authorHandle:t.root.author!.handle!}};
        t.article.entryIdentity = sizingIdentity;
      }
      if(t.replies.requested) t.unscopedPosts={observations:[],
        collection:{snapshotId:`xsnap_${uuid}`,document:{epoch:Number.MAX_SAFE_INTEGER,routeRevision:Number.MAX_SAFE_INTEGER,navigationSequence:Number.MAX_SAFE_INTEGER,generation:'g'.repeat(32)},location:{origin:'https://twitter.com',path:'p'.repeat(X_MAX_SOURCE_URL_UNITS),q:null,f:null,fragment:null,redacted:false}},
        inventory:{scope:'collection',observed:100,retained:0,omitted:100,sourceInventoryTruncated:true,excludedNestedQuotes:100},
        previewGaps:Array.from({length:100},()=>({sourceUrl:'u'.repeat(X_MAX_SOURCE_URL_UNITS),unresolved:Number.MAX_SAFE_INTEGER}))};
      t.article.entryObserved = true;
      t.article.actionAttempted = true;
      t.article.navigationStarted = true;
      t.article.bodyObserved = true;
    });
  state.budgetUsage = {
    scrolls: 400,
    expandActions: 400,
    distinctEntries: 2000,
    outputBytes: X_RESEARCH_MAX_OUTPUT_BYTES,
  };
  state.truncation = { returned: 0, totalKnown: 8080000, truncated: true };
  state.contentProjection = 'x_research_projection_v1';
  compactMetadata(state);
  compactModelDocumentLocations(state);
  const requiredBytes = measure(state, true, prior).result.budgetUsage.outputBytes;
  if (requiredBytes > X_RESEARCH_MAX_OUTPUT_BYTES)
    throw new Error(
      `x_research: request metadata exceeds 1 MiB required-state envelope (${requiredBytes} bytes); shorten or split the request`,
    );
}
export function serializeXResearchResult<T extends XResearchResult>(
  original: T,
  prior?: XResearchScopePrior,
): XSerializedResult<T> {
  if(original.operation==='read') for(const row of original.targets) for(const frame of [row.diagnostics?.initialFrame,row.diagnostics?.firstAdmittedFrame,row.diagnostics?.terminalFrame])
    if(frame){
      if(frame.sourceRootState) sourceRootStateSchema.parse(frame.sourceRootState);
      replyUiFrameSchema.parse(frame);
    }
  const result = structuredClone(projectActionDiagnostics(original)),
    bodies = texts(result),
    previous = result.truncation;
  const totalKnown = previous.truncated
    ? previous.totalKnown
    : bodies.some((p) => p.truncation.totalKnown === null)
      ? null
      : bodies.reduce((n, p) => n + p.truncation.totalKnown!, 0);
  if (result.operation === 'read')
    for (const row of result.targets) {
      if (row.article.entry) row.article.entryIdentity = publicXArticleEntryIdentity(row.article);
    }
  let projected = !!result.contentProjection;
  const update = () => {
    result.truncation = {
      returned: texts(result).reduce((n, p) => n + p.text.length, 0),
      totalKnown,
      truncated:
        previous.truncated ||
        bodies.some((p) => p.truncation.truncated) ||
        texts(result).length < bodies.length ||
        !!result.metadataOmissions?.length ||
        !!result.contentMetadataOmissions?.length,
    };
    if(result.operation==='read') for(const row of result.targets) if(row.unscopedPosts) {
      row.unscopedPosts.inventory.retained=row.unscopedPosts.observations.length;
      row.unscopedPosts.inventory.omitted=row.unscopedPosts.inventory.observed-row.unscopedPosts.inventory.retained;
      row.budgetUsage.distinctEntries=new Set([...(row.root?[row.root]:[]),...row.quotedPosts,...row.replies.observations,...(row.article.body?[row.article.body]:[]),...row.unscopedPosts.observations].map(p=>p.postId)).size;
    }
    if(result.operation==='read' && result.targets.some(row=>row.unscopedPosts)) result.budgetUsage.distinctEntries=result.targets.reduce((sum,row)=>sum+row.budgetUsage.distinctEntries,0);
    return measure(result, projected, prior);
  };
  let value = update();
  if (value.result.budgetUsage.outputBytes <= X_RESEARCH_MAX_OUTPUT_BYTES)
    return value;
  projected = true;
  result.contentProjection = 'x_research_projection_v1';
  value = update();
  if (value.result.budgetUsage.outputBytes <= X_RESEARCH_MAX_OUTPUT_BYTES)
    return value;
  // Optional observation history yields before current text or diagnostics.
  // This is output omission, never a claim that separate source frames are equal.
  const mark = (path: string) => {
    if (!(result.metadataOmissions ??= []).includes(path)) result.metadataOmissions.push(path);
  };
  if (result.operation === 'read') for (const [index,row] of result.targets.entries()) {
    const entries = row.bodyObservations;
    if (!entries?.length) continue;
    const previousOmitted = row.bodyObservationsOmitted ?? 0;
    mark(`targets.${index}.bodyObservations`);
    if (row.status === 'observed') row.status = 'partial';
    row.reason ??= 'body_observations_output_budget';
    if (row.stopReason === 'agent_stopped') row.stopReason = 'budget_reached';
    if (result.status === 'observed') result.status = 'partial';
    const retain = (count: number) => {
      row.bodyObservations = entries.slice(0,count);
      row.bodyObservationsOmitted = previousOmitted + entries.length - count;
    };
    let lo=0,hi=entries.length;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);retain(mid);if(update().result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)lo=mid;else hi=mid-1;}
    retain(lo);value=update();
    if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
  }
  if (result.operation === 'search') for (const [index,row] of result.queries.entries()) {
    const entries = row.postObservations;
    if (!entries?.length) continue;
    const previousOmitted = row.postObservationsOmitted ?? 0;
    const optional = entries.filter(p=>!protectedSearchHistory(p));
    if(optional.length){
      mark(`queries.${index}.postObservations`);
      if(row.status==='observed')row.status='partial';
      if(row.stopReason==='agent_stopped')row.stopReason='budget_reached';
      if(result.status==='observed')result.status='partial';
      const retain=(count:number)=>{
        const prefix=new Set(optional.slice(0,count));
        row.postObservations=entries.filter(p=>protectedSearchHistory(p)||prefix.has(p));
        row.postObservationsOmitted=previousOmitted+entries.length-row.postObservations.length;
      };
      let lo=0,hi=optional.length;
      while(lo<hi){const mid=Math.ceil((lo+hi)/2);retain(mid);if(update().result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)lo=mid;else hi=mid-1;}
      retain(lo);value=update();
      if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
    }
  }
  if(result.operation==='search') for(const [index,row] of result.queries.entries()) {
    const history=row.postObservations?.filter(p=>p.text.length);
    if(!history?.length)continue;
    mark(`queries.${index}.postObservations.text`);
    for(const p of history){p.text='';p.truncation={...p.truncation,returned:0,truncated:true};}
    if(row.status==='observed')row.status='partial';
    if(row.stopReason==='agent_stopped')row.stopReason='budget_reached';
    if(result.status==='observed')result.status='partial';
    value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
  }
  // Reply attempt telemetry is one optional section, never partially rewritten.
  if(result.operation==='read') for(const [index,row] of result.targets.entries()) {
    if(!row.diagnostics?.replyExpansions)continue;
    delete row.diagnostics.replyExpansions;
    (result.metadataOmissions??=[]).push(`targets.${index}.diagnostics.replyExpansions`);
    value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
  }
  // Drop whole optional source inventories before evidence bodies. Clone each
  // frame shell: two stage slots can honestly share the same collection object.
  if(result.operation==='read') for(const [index,row] of result.targets.entries()) {
    for(const key of ['initialFrame','firstAdmittedFrame','terminalFrame'] as const){
      const frame=row.diagnostics?.[key];if(!frame?.replyUiInventory)continue;
      const retained={...frame};delete retained.replyUiInventory;row.diagnostics![key]=retained;
      (result.metadataOmissions??=[]).push(`targets.${index}.diagnostics.${key}.replyUiInventory`);
      value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
    }
  }
  // Independent failure-frame bodies are optional; their exact own-parent gap
  // facts are required state. Remove whole items before touching current text.
  if(result.operation==='read') for(const [index,row] of result.targets.entries()) {
    const envelope=row.unscopedPosts;if(!envelope?.observations.length) continue;
    const entries=[...envelope.observations];
    const path=`targets.${index}.unscopedPosts.observations`;
    if(!(result.metadataOmissions??=[]).includes(path)) result.metadataOmissions.push(path);
    let lo=0,hi=entries.length;
    while(lo<hi) {
      const mid=Math.ceil((lo+hi)/2);envelope.observations=entries.slice(0,mid);
      if(update().result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)lo=mid;else hi=mid-1;
    }
    envelope.observations=entries.slice(0,lo);value=update();
    if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
  }
  for (const p of texts(result)
    .filter((b) => b.text.length)
    .sort((a, b) => b.text.length - a.text.length)) {
    const full = p.text;
    let lo = 0,
      hi = full.length;
    p.truncation.truncated = true;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      p.text = full.slice(0, mid);
      p.truncation.returned = p.text.length;
      if (
        update().result.budgetUsage.outputBytes <= X_RESEARCH_MAX_OUTPUT_BYTES
      )
        lo = mid;
      else hi = mid - 1;
    }
    p.text = full.slice(0, lo);
    if (/[\uD800-\uDBFF]$/.test(p.text)) p.text = p.text.slice(0, -1);
    p.truncation.returned = p.text.length;
    value = update();
    if (value.result.budgetUsage.outputBytes <= X_RESEARCH_MAX_OUTPUT_BYTES)
      return value;
  }
  if(result.operation==='search') for(const q of result.queries) {
    const candidates=[...q.posts],observations=[...(q.postObservations??[])];
    let lo=0,hi=candidates.length;
    const retain=(count:number)=>{
      q.posts=candidates.slice(0,count);
      const ids=new Set(q.posts.map(p=>p.postId));
      if(q.postObservations) q.postObservations=observations.filter(p=>protectedSearchHistory(p)||ids.has(p.postId));
    };
    while(lo<hi) {const mid=Math.ceil((lo+hi)/2);retain(mid);if(update().result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES) lo=mid;else hi=mid-1;}
    retain(lo);value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
  }
  const lists =
    result.operation === 'search'
      ? []
      : result.targets.flatMap((t) => [t.replies.observations, t.quotedPosts]);
  for (const list of lists) {
    const entries = [...list];
    let lo = 0,
      hi = entries.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      list.splice(0, list.length, ...entries.slice(0, mid));
      if (
        update().result.budgetUsage.outputBytes <= X_RESEARCH_MAX_OUTPUT_BYTES
      )
        lo = mid;
      else hi = mid - 1;
    }
    list.splice(0, list.length, ...entries.slice(0, lo));
    value = update();
    if (value.result.budgetUsage.outputBytes <= X_RESEARCH_MAX_OUTPUT_BYTES)
      return value;
  }
  if(result.operation==='read') for(const row of result.targets) {
    const audits=row.articlePreviewObservations;
    if(!audits?.length)continue;
    const {observationId,postId,sourceUrl,authorHandle}=audits[0];
    row.inventoryAuditOmitted={count:(row.inventoryAuditOmitted?.count??0)+audits.length,first:row.inventoryAuditOmitted?.first??{observationId,postId,sourceUrl,authorHandle}};
    row.articlePreviewObservations=[];
    (result.metadataOmissions??=[]).push(`targets.${result.targets.indexOf(row)}.articlePreviewObservations`);
    if(row.status==='observed') row.status='partial';
    row.reason??='article_inventory_audit_output_budget';
    if(row.stopReason==='agent_stopped')row.stopReason='budget_reached';
    if(result.status==='observed')result.status='partial';
    value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
  }
  if (result.operation==='read') {
    const mark=(index:number,part:string)=>{
      const path=`targets.${index}.diagnostics.${part}`;
      (result.metadataOmissions??=[]).push(path);
    };
    for (const part of ['scrollRecovery','pointerPreflights','scroll','readiness','clickFailures','pointerFailure','initialFrame','firstAdmittedFrame','terminalFrame','sourceFailure'] as const) {
      for (const [index,row] of result.targets.entries()) {
        if (!row.diagnostics?.[part]) continue;
        delete row.diagnostics[part];
        mark(index,part);
        value=update();
        if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
      }
    }
  }
  if(result.operation==='search') for(const part of ['scrollRecovery','scroll','sourceFailure'] as const) for(const [index,row] of result.queries.entries()) {
    if(!row.diagnostics?.[part])continue;
    delete row.diagnostics[part];
    (result.metadataOmissions??=[]).push(`queries.${index}.diagnostics.${part}`);
    value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES)return value;
  }
  compactMetadata(result);
  value = update();
  if (value.result.budgetUsage.outputBytes <= X_RESEARCH_MAX_OUTPUT_BYTES)
    return value;
  compactModelDocumentLocations(result);
  value = update();
  if (value.result.budgetUsage.outputBytes <= X_RESEARCH_MAX_OUTPUT_BYTES)
    return value;
  // The factory's required-state admission prevents this branch for supported
  // production source bounds. Reject unsupported direct helper callers clearly.
  throw new Error(
    'x_research: retained result metadata exceeds 1 MiB required-state envelope',
  );
}
