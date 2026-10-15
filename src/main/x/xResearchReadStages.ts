import { admitXSourceRoot } from './xDomSource';
import { bindXReadBudgets, sampleXEntries } from './xResearchBudget';
import type { BrowserScrollReceipt } from '../browser/actions';
import { isScrollReceipt } from './xScrollRecovery';
import {
  isPointerPreflight,
  type PointerPreflightDiagnostic,
} from '../browser/pointerPreflightDiagnostic';
import {
  beginReplyExpansion,
  replyCollection,
  replyUsage,
  observeReplyDiagnostic,
} from './xReplyExpansionDiagnostics';
import { logger } from '../log';
import { pointerFailureDiagnostic } from '../browser/pointerDiagnostic';
import { KydogError } from '../../shared/errors';
import type { XQueuedPage } from './xResearchBrowser';
import type {
  XPageObservation,
  XPageRequest,
  XPageControl,
} from './xObservation';
import { matchesXArticleParent } from './xResearchIdentity';
import {
  collectFreshXPage,
  rememberSources,
  X_POST_READY_SELECTOR,
  type XResearchContext,
  type XCollectionBudget,
} from './xResearchSearch';
import type {
  XReadObservation,
  XReadRequest,
  XTextObservation,
  XUnscopedPost,
} from './xResearchTypes';

export interface XReadStage {
  current: 'navigation' | 'collection' | 'action' | 'wait';
  actionIndex: number;
  attemptedControls: Set<string>;
  collectionBudget?: XCollectionBudget;
}
/** Only real successful navigation receipts establish an independent collection stage. */
export function beginReadNavigation(
  stage: XReadStage,
  phase: XCollectionBudget['navigationPhase'],
  nav: import('../../shared/types').NavigationObservation,
): void {
  if (nav.outcome.kind === 'ok' || nav.outcome.kind === 'ok_same_document') {
    stage.collectionBudget = {
      navigationPhase: phase,
      navigationId: nav.navigationId,
      rereadRequested: false,
    };
  }
}
export function checkReadCancelled(context: XResearchContext): void {
  if (context.signal?.aborted)
    throw new KydogError('browser.cancelled', 'X read cancelled');
}
export function readBarrier(
  row: XReadObservation,
  observed: XPageObservation,
): boolean {
  if (observed.state?.kind !== 'auth_required') return false;
  row.status = 'auth_required';
  row.reason = 'auth_required';
  row.stopReason = 'access_barrier';
  row.barrier = {
    status: 'auth_required',
    reason: observed.state.text,
    observationId: observed.state.observationId,
  };
  return true;
}
// Row lifetime spans body/Article/discussion stages. Retention caps never erase observed identity.
const admittedReplyIdentities = new WeakMap<XReadObservation, Set<string>>();
// Only the current accepted root source; never a second body ledger or capability.
const wireArticlePresence = new WeakMap<XReadObservation, number>();
/** Preserve source observations, never choose a body by length or similarity. */
export function retainReadBody(
  row: XReadObservation,
  body: XTextObservation | XUnscopedPost,
): void {
  if (body.containerKind === 'unscoped_post' && !body.text.trim()) {
    retainReadArticleScope(row, body);
    return;
  }
  const history = (row.bodyObservations ??= []);
  if (history.some((p) => p.observationId === body.observationId)) return;
  history.push(body);
  retainReadArticleScope(row, body);
}
function retainReadArticleScope(
  row: XReadObservation,
  body: XTextObservation | XUnscopedPost,
): void {
  const inventory = body.articlePreviewInventory;
  if (
    body.postId &&
    body.sourceUrl &&
    body.author?.handle &&
    inventory &&
    (inventory.observed > 0 || inventory.unresolved > 0)
  ) {
    const scope = {
      observationId: body.observationId,
      postId: body.postId,
      sourceUrl: body.sourceUrl,
      authorHandle: body.author.handle,
      articlePreviews: body.articlePreviews ?? [],
      articlePreviewInventory: inventory,
    };
    const audit = (row.articlePreviewObservations ??= []);
    if (
      !audit.some(
        (previous) => JSON.stringify(previous) === JSON.stringify(scope),
      )
    )
      audit.push(structuredClone(scope));
  }
}
function mergeText(
  row: XReadObservation,
  saved: XTextObservation[],
  incoming: XTextObservation[],
  maximum = Infinity,
): void {
  for (const item of incoming) {
    const index = saved.findIndex(
      (p) => p.postId === item.postId && p.sourceUrl === item.sourceUrl,
    );
    if (index >= 0) {
      if (saved[index].observationId !== item.observationId)
        retainReadBody(row, saved[index]);
      saved[index] = item;
    } else if (saved.length < maximum) saved.push(item);
  }
}
const acceptedReadPages = new WeakMap<XReadObservation, Set<string>>();
/** Called synchronously at source acceptance, before any cancellation continuation. */
export function acceptReadNetworkPage(
  row: XReadObservation,
  page: import('./xNetworkSource').XNetworkReadPage,
  fact: import('./xNetworkLease').XNetworkPageFact | undefined,
  limits: XReadRequest,
  context: XResearchContext,
): void {
  let seen = acceptedReadPages.get(row);
  if (!seen) {
    seen = new Set();
    acceptedReadPages.set(row, seen);
  }
  if (seen.has(page.provenance.requestRef) || seen.size >= 1000) return;
  if (page.root && page.root.postId !== row.postId) return;
  const targetProven =
    !!page.root ||
    (row.identity?.state === 'proven' &&
      row.identity.proof.leaseId === page.provenance.leaseId);
  seen.add(page.provenance.requestRef);
  if (page.root) {
    if (row.root && row.root.observationId !== page.root.observationId)
      retainReadBody(row, row.root);
    row.root = structuredClone(page.root);
    wireArticlePresence.set(
      row,
      page.root.articlePreviewInventory?.unresolved ?? 0,
    );
    row.sourceUrl = page.root.sourceUrl;
    row.identity = {
      state: 'proven',
      postId: row.postId!,
      proof: { ...page.provenance },
    };
  }
  let admitted = admittedReplyIdentities.get(row);
  if (!admitted) {
    admitted = new Set();
    admittedReplyIdentities.set(row, admitted);
  }
  const collect = limits.includeReplies && limits.maxRepliesPerPost > 0;
  const candidates = collect
    ? [...(targetProven ? page.replies : []), ...page.unscopedPosts]
    : [];
  if (page.sampleOrder)
    candidates.sort(
      (a, b) =>
        page.sampleOrder!.indexOf(a.observationId) -
        page.sampleOrder!.indexOf(b.observationId),
    );
  const sample = sampleXEntries(
    candidates.filter(
      (p): p is typeof p & { postId: string } => p.postId !== null,
    ),
    admitted,
    limits.maxRepliesPerPost,
  );
  const retainedReplies = sample.retained.filter(
    (p): p is XTextObservation & { postId: string } =>
      p.containerKind !== 'unscoped_post',
  );
  mergeText(row, row.replies.observations, retainedReplies);
  if (collect && !targetProven) {
    sample.observed += page.replies.length;
    sample.omitted += page.replies.length;
  }
  const counts = (row.sampleTruncation ??= {
    observed: 0,
    sampled: 0,
    omitted: 0,
  });
  for (const key of ['observed', 'sampled', 'omitted'] as const)
    counts[key] += sample[key];
  const unscoped = sample.retained.filter(
    (p): p is import('./xResearchTypes').XUnscopedPost =>
      p.containerKind === 'unscoped_post',
  );
  if (unscoped.length) {
    const prior = row.unscopedPosts?.observations ?? [];
    for (const p of unscoped) {
      const i = prior.findIndex((v) => v.postId === p.postId);
      if (i >= 0) {
        if (prior[i].observationId !== p.observationId)
          retainReadBody(row, prior[i]);
        prior[i] = p;
      } else prior.push(p);
    }
    const gaps = [...(row.unscopedPosts?.previewGaps ?? [])];
    for (const p of [...prior, ...unscoped]) {
      if (!p.text.trim()) retainReadArticleScope(row, p);
      const unresolved = p.articlePreviewInventory?.unresolved ?? 0;
      if (unresolved && !gaps.some((g) => g.sourceUrl === p.sourceUrl))
        gaps.push({ sourceUrl: p.sourceUrl, unresolved });
    }
    row.unscopedPosts = {
      observations: prior.filter((p) => !!p.text.trim()),
      collection: { kind: 'network', provenance: page.provenance },
      inventory: {
        scope: 'collection',
        observed: prior.length,
        retained: prior.filter((p) => !!p.text.trim()).length,
        omitted: prior.filter((p) => !p.text.trim()).length,
        sourceInventoryTruncated: false,
        excludedNestedQuotes: 0,
      },
      previewGaps: gaps,
    };
  }
  const retainedParents = new Set(sample.retained.map((p) => p.postId));
  const quoted = page.quotedPosts.filter((q) => {
    const parent = page.quoteParents?.[q.observationId];
    return parent
      ? parent === page.root?.postId || retainedParents.has(parent)
      : false;
  });
  mergeText(row, row.quotedPosts, quoted);
  if (fact) {
    fact.observed = sample.observed;
    fact.sampled = sample.sampled;
    fact.omitted = sample.omitted;
    (row.networkPages ??= []).push(fact);
  }
  const rc = fact?.readContext;
  row.replies.scope = {
    kind: 'network',
    rootPostId: targetProven ? row.postId! : null,
    extent:
      page.end === 'cursor_exhausted' &&
      !!rc &&
      rc.accountContextId !== null &&
      rc.branchKey !== null &&
      rc.sortKey !== null
        ? 'cursor_exhausted'
        : 'unknown',
    context: {
      leaseId: targetProven ? page.provenance.leaseId : null,
      accountContextId: rc?.accountContextId ?? null,
      branchKey: page.branchKey,
      sortKey: page.sortKey,
    },
    terminalRequestRef:
      page.end === 'cursor_exhausted' && rc?.accountContextId != null
        ? page.provenance.requestRef
        : null,
    stopReason: row.stopReason,
  };
  row.budgetUsage.distinctEntries = new Set(
    [
      row.root,
      row.article.body,
      ...row.quotedPosts,
      ...row.replies.observations,
      ...(row.unscopedPosts?.observations ?? []),
    ]
      .filter((p) => !!p)
      .map((p) => p!.postId),
  ).size;
  rememberSources(context, [
    ...(page.root ? [page.root] : []),
    ...quoted,
    ...retainedReplies,
  ]);
  if (limits.includeReplies)
    bindXReadBudgets(
      row,
      limits,
      context.budgetPolicy,
      ['replies', 'scrolls'],
      admitted.size,
    );
  if ((acceptedReadPages.get(row)?.size ?? 0) >= 1000)
    (row.budgetBinding ??= []).push({
      dimension: 'network_pages',
      limit: 1000,
      used: seen.size,
      origin: 'safety',
    });
}
/** Persist each validated frame before an action can replace its virtual DOM. */
export function savePostFrame(
  row: XReadObservation,
  observed: XPageObservation,
  request: XReadRequest,
  context: XResearchContext,
): boolean {
  if (readBarrier(row, observed)) return false;
  if (observed.network) {
    for (const [i, page] of observed.network.pages.entries())
      if ('root' in page)
        acceptReadNetworkPage(
          row,
          page as import('./xNetworkSource').XNetworkReadPage,
          observed.network.facts?.[i],
          request,
          context,
        );
    if (
      !observed.identityProven ||
      observed.network.failure ||
      row.identity?.state !== 'proven' ||
      row.identity.postId !== row.postId ||
      row.identity.proof.leaseId !== observed.network.proof.leaseId
    ) {
      row.status = 'partial';
      row.reason = observed.network.failure ?? 'post_identity_unproven';
      row.stopReason = observed.network.failure
        ? 'source_unavailable'
        : 'identity_unproven';
      return false;
    }
    admitXSourceRoot(observed);
    if (row.root) {
      const safe = observed.location.current;
      if (!safe.redacted && safe.origin && safe.path) {
        row.documentSource = {
          urlKind: 'document',
          sourceUrl: observed.snapshot.url,
          observationId: row.root.observationId,
          rootObservationId: row.root.observationId,
          observedAt: row.root.observedAt,
          containerKind: 'root_post',
          runId: context.runId,
          callId: context.callId,
          batchId: context.batchId,
          queryId: null,
          query: null,
          purpose: null,
          product: null,
        };
        const sources = context.sources.get(row.postId!) ?? [];
        if (
          !sources.some(
            (s) =>
              s.observationId === row.documentSource!.observationId &&
              s.sourceUrl === row.documentSource!.sourceUrl,
          )
        )
          sources.push(row.documentSource);
        context.sources.set(row.postId!, sources);
      }
    }
    if (row.diagnostics && observed.diagnosticFrame)
      row.diagnostics.firstAdmittedFrame ??= observed.diagnosticFrame;
    const rootEntries = observed.entries.filter((e) =>
      matchesXArticleParent(observed, e, row.root),
    );
    if (!row.article.actionAttempted) {
      row.article.entry = rootEntries[0] ?? row.article.entry;
      row.article.entryObserved = !!row.article.entry;
    }
    if (row.root) {
      const root = row.root,
        native = [...(observed.articleParentInventories?.values() ?? [])].find(
          (p) =>
            p.postId === root.postId &&
            p.sourceUrl === root.sourceUrl &&
            p.authorHandle === root.author?.handle,
        );
      if (native) {
        const previews = rootEntries.map((e) => ({
          entryObservationId: e.observationId,
          parentPostId: e.parentPostId,
          sourceUrl: e.sourceUrl,
          targetUrl: e.targetUrl,
        }));
        // A later zero cannot revoke a previously observed native entry. The
        // accepted wire root itself remains unchanged, and positive audits are
        // copied independently of this current projection.
        if (
          native.observedEntries === 0 &&
          native.unresolvedEntries === 0 &&
          (root.articlePreviewInventory?.observed ?? 0) > 0
        )
          return true;
        const wireUnresolved = wireArticlePresence.get(row) ?? 0;
        root.articlePreviews = previews;
        root.articlePreviewInventory = {
          scope: 'collection',
          observed: native.observedEntries,
          retained: previews.length,
          omitted: native.observedEntries - previews.length,
          unresolved: Math.max(
            wireUnresolved - native.observedEntries,
            native.unresolvedEntries,
            0,
          ),
        };
        if (native.observedEntries > 0 || native.unresolvedEntries > 0)
          retainReadArticleScope(row, root);
      }
    }
    return true;
  }
  row.status = 'partial';
  row.reason = 'post_identity_unproven';
  row.stopReason = 'identity_unproven';
  return false;
}
/** Retain admitted collection facts even when the current focal root is absent. */
function retainCollectedPostFrame(
  row: XReadObservation,
  observed: XPageObservation,
): void {
  if (observed.diagnosticFrame) {
    const diagnostics = (row.diagnostics ??= { version: 1 });
    diagnostics.initialFrame ??= observed.diagnosticFrame;
    diagnostics.terminalFrame = observed.diagnosticFrame;
  }
}
export async function collectPostFrame(
  page: XQueuedPage,
  request: Extract<XPageRequest, { stage: 'post' }>,
  row: XReadObservation,
  stage: XReadStage,
  context: XResearchContext,
): Promise<XPageObservation> {
  checkReadCancelled(context);
  stage.current = 'collection';
  const observed = await collectFreshXPage(
    page,
    request,
    row.collectionTransitions,
    context.signal,
    stage.collectionBudget,
  );
  checkReadCancelled(context);
  retainCollectedPostFrame(row, observed);
  return observed;
}
/** Reuse the observed post DOM gate after either explicit parent navigation. */
export async function collectReadyPostFrame(
  page: XQueuedPage,
  request: Extract<XPageRequest, { stage: 'post' }>,
  row: XReadObservation,
  stage: XReadStage,
  context: XResearchContext,
  allowWait = true,
): Promise<{ observed: XPageObservation; waitFailed: boolean }> {
  let observed = await collectPostFrame(page, request, row, stage, context);
  checkReadCancelled(context);
  let waitFailed = false;
  if (
    allowWait &&
    observed.scope.collectedItemCount === 0 &&
    !observed.article &&
    !observed.state &&
    observed.location.current.origin &&
    observed.location.relation.postId !== 'different'
  ) {
    stage.current = 'wait';
    waitFailed = !(await page.wait(
      { selector: X_POST_READY_SELECTOR, state: 'present' },
      8000,
    ));
    checkReadCancelled(context);
    observed = await collectPostFrame(page, request, row, stage, context);
    checkReadCancelled(context);
  }
  return { observed, waitFailed };
}
/** Ordinary network bodies need no DOM text expansion. */
export async function expandPostBody(
  _page: XQueuedPage,
  initial: XPageObservation,
  _request: Extract<XPageRequest, { stage: 'post' }>,
  row: XReadObservation,
  limits: XReadRequest,
  _stage: XReadStage,
  context: XResearchContext,
): Promise<XPageObservation> {
  savePostFrame(row, initial, limits, context);
  return initial;
}
export async function readDiscussion(
  page: XQueuedPage,
  initial: XPageObservation,
  request: Extract<XPageRequest, { stage: 'post' }>,
  row: XReadObservation,
  limits: XReadRequest,
  stage: XReadStage,
  context: XResearchContext,
): Promise<void> {
  if (!initial.network) {
    savePostFrame(row, initial, limits, context);
    return;
  }
  await readNetworkDiscussion(
    page,
    initial,
    request,
    row,
    limits,
    stage,
    context,
  );
}

/** Diagnostic binding cannot grant permission; only the actual source error is admitted. */
export function retainClickFailure(
  row: XReadObservation,
  control: XPageControl,
  stage: XReadStage,
  error: unknown,
  context: XResearchContext,
): void {
  const diagnostic = pointerFailureDiagnostic(error);
  if (
    !diagnostic ||
    diagnostic.snapshotId !== control.binding.snapshotId ||
    diagnostic.generation !== control.binding.generation ||
    diagnostic.nodeId !== control.binding.nodeId ||
    !row.postId
  )
    return;
  const entry = {
    actionIndex: stage.actionIndex,
    targetPostId: row.postId,
    controlKind: control.kind,
    binding: { ...control.binding },
    sourceRelation: control.sourceRelation ?? 'unknown',
    diagnostic,
  };
  const diagnostics = (row.diagnostics ??= { version: 1 });
  const failures = (diagnostics.clickFailures ??= {
    totalFailures: 0,
    omittedFailures: 0,
  });
  failures.totalFailures++;
  failures.first ??= entry;
  failures.last = entry;
  failures.omittedFailures =
    failures.totalFailures -
    new Set([failures.first.actionIndex, failures.last.actionIndex]).size;
  if (control.kind === 'replies_expand')
    diagnostics.pointerFailure = {
      actionIndex: entry.actionIndex,
      targetPostId: entry.targetPostId,
      controlKind: 'replies_expand',
      sourceRelation: entry.sourceRelation,
      diagnostic,
    };
  try {
    logger.warn(
      'xResearch',
      control.kind === 'article_entry'
        ? 'Article pointer interception'
        : control.kind === 'replies_expand'
          ? 'Reply expansion pointer interception'
          : 'Body expansion pointer interception',
      {
        runId: context.runId,
        callId: context.callId,
        batchId: context.batchId,
        diagnostic,
      },
    );
  } catch {
    /* Observer failures never replace the original refusal. */
  }
}

/** Capture action identity at issue; asynchronous observers never borrow a later stage index. */
export function preflightObserver(
  row: XReadObservation,
  control: Pick<XPageControl, 'kind' | 'binding'>,
  actionIndex: number,
): (value: Readonly<PointerPreflightDiagnostic>) => void {
  const binding = { ...control.binding },
    targetPostId = row.postId,
    controlKind = control.kind;
  return (value) =>
    observeReplyDiagnostic(() => {
      if (
        !targetPostId ||
        !isPointerPreflight(value) ||
        value.snapshotId !== binding.snapshotId ||
        value.generation !== binding.generation ||
        value.nodeId !== binding.nodeId
      )
        return;
      const entry = {
        actionIndex,
        targetPostId,
        controlKind,
        binding,
        diagnostic: value,
      };
      const diagnostics = (row.diagnostics ??= { version: 1 });
      const summaries = (diagnostics.pointerPreflights ??= {
        totalAttempts: 0,
        omittedAttempts: 0,
        first: entry,
        last: entry,
      });
      if (summaries.totalAttempts && summaries.last.actionIndex >= actionIndex)
        return;
      summaries.totalAttempts++;
      summaries.last = entry;
      summaries.omittedAttempts = Math.max(0, summaries.totalAttempts - 2);
    });
}

async function readNetworkDiscussion(
  page: XQueuedPage,
  initial: XPageObservation,
  request: Extract<XPageRequest, { stage: 'post' }>,
  row: XReadObservation,
  limits: XReadRequest,
  stage: XReadStage,
  context: XResearchContext,
): Promise<void> {
  let observed = initial;
  for (;;) {
    if (!savePostFrame(row, observed, limits, context)) return;
    if (!limits.includeReplies) return;
    if (
      'kind' in row.replies.scope &&
      row.replies.scope.extent === 'cursor_exhausted'
    ) {
      row.stopReason = 'cursor_exhausted';
      return;
    }
    const control = observed.controls.find((c) => c.kind === 'replies_expand');
    if (
      bindXReadBudgets(
        row,
        limits,
        context.budgetPolicy,
        ['replies', control ? 'expands' : 'scrolls'],
        admittedReplyIdentities.get(row)?.size,
      ).length ||
      (acceptedReadPages.get(row)?.size ?? 0) >= 1000
    ) {
      row.status = 'partial';
      row.reason = 'reply_budget_reached';
      row.stopReason = 'budget_reached';
      return;
    }
    if (observed.network?.pending) {
      observed = await collectPostFrame(page, request, row, stage, context);
      continue;
    }
    checkReadCancelled(context);
    stage.current = 'action';
    stage.actionIndex++;
    if (control) {
      const attempt = beginReplyExpansion(
        row,
        observed,
        control,
        limits,
        stage.actionIndex,
      );
      try {
        await page.act(
          {
            kind: 'click',
            index: control.binding.index,
            snapshotId: control.binding.snapshotId,
          },
          observed.snapshot,
          {
            onPointerPreflight: preflightObserver(
              row,
              control,
              stage.actionIndex,
            ),
            onReplyAdmission: (r) => {
              if (attempt) attempt.admission = r;
            },
          },
        );
      } catch (error) {
        if (attempt) {
          attempt.outcome = context.signal?.aborted ? 'cancelled' : 'failed';
          attempt.usageAfter = replyUsage(row);
        }
        retainClickFailure(row, control, stage, error, context);
        throw error;
      }
      row.budgetUsage.expandActions++;
      if (attempt) {
        attempt.outcome = 'succeeded';
        attempt.usageAfter = replyUsage(row);
        attempt.after = { state: 'unavailable' };
      }
      observed = await collectPostFrame(page, request, row, stage, context);
      if (attempt) attempt.after = replyCollection(observed);
      continue;
    }
    let receipt: BrowserScrollReceipt | undefined;
    const scroll = ((row.diagnostics ??= { version: 1 }).scroll ??= {
      totalAttempts: 0,
      omittedAttempts: 0,
    });
    const actionIndex = ++scroll.totalAttempts;
    const omissions = () => {
      scroll.omittedAttempts =
        scroll.totalAttempts -
        new Set(
          [scroll.first?.actionIndex, scroll.last?.actionIndex].filter(
            (id) => id !== undefined,
          ),
        ).size;
    };
    omissions();
    await page.act({ kind: 'scroll', direction: 'down' }, observed.snapshot, {
      scrollAcknowledgement: {
        onWritten: () => {
          row.budgetUsage.scrolls++;
        },
        onReceipt: (r) => {
          if (!isScrollReceipt(r)) return;
          receipt = r;
          const saved = {
            actionIndex,
            snapshotId: observed.snapshot.snapshotId,
            generation: r.generation,
            location: observed.location.current,
            targetKind: r.targetKind,
            targetNodeId: r.targetNodeId,
            targetContainsHit: r.targetContainsHit,
            conversationRelation: r.conversationRelation,
            rootRelation: r.rootRelation,
            before: r.before,
            after: r.after,
            scrollHeight: r.scrollHeight,
            clientHeight: r.clientHeight,
            written: r.written,
            eventObserved: r.eventObserved,
            frameObserved: r.frameObserved,
            state: r.state,
          };
          scroll.first ??= saved;
          scroll.last = saved;
          omissions();
        },
      },
    });
    observed = await collectPostFrame(page, request, row, stage, context);
    if (!savePostFrame(row, observed, limits, context)) return;
    if (observed.network?.pending) continue;
    if (
      receipt &&
      receipt.after + receipt.clientHeight >= receipt.scrollHeight
    ) {
      row.status = 'partial';
      row.stopReason = 'explicit_ui_end';
      row.reason = 'reply_ui_end';
      return;
    }
    if (!observed.network?.pages.length) {
      stage.current = 'wait';
      if (
        !(await page.wait(
          { selector: X_POST_READY_SELECTOR, state: 'present' },
          8000,
        ))
      ) {
        row.status = 'partial';
        row.stopReason = 'wait_timeout';
        row.reason = 'reply_readiness_timeout';
        return;
      }
      observed = await collectPostFrame(page, request, row, stage, context);
    }
  }
}
