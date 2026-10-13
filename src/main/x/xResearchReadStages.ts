import { logger } from '../log';
import { admitXSourceRoot } from './xPageSource';
import { pointerFailureDiagnostic } from '../browser/pointerDiagnostic';
import { KydogError } from '../../shared/errors';
import type { XQueuedPage } from './xResearchBrowser';
import type {
  XPageObservation,
  XPageRequest,
  XPageControl,
} from './xPageSource';
import { applyReplyEndEvidence } from './xResearchIdentity';
import {
  collectFreshXPage,
  rememberSources,
  X_POST_READY_SELECTOR,
  type XResearchContext,
  type XCollectionBudget,
} from './xResearchSearch';
import type {
  XReadDiagnostics,
  XReadObservation,
  XReadRequest,
  XTextObservation,
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
/** Preserve source observations, never choose a body by length or similarity. */
export function retainReadBody(row: XReadObservation, body: XTextObservation): void {
  const history = (row.bodyObservations ??= []);
  if (history.some(p => p.observationId === body.observationId)) return;
  history.push(body);
  const inventory = body.articlePreviewInventory;
  if (body.postId && body.sourceUrl && body.author?.handle && inventory && (inventory.observed > 0 || inventory.unresolved > 0)) {
    (row.articlePreviewObservations ??= []).push({ observationId: body.observationId, postId: body.postId, sourceUrl: body.sourceUrl, authorHandle: body.author.handle, articlePreviews: body.articlePreviews ?? [], articlePreviewInventory: inventory });
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
      if (saved[index].observationId !== item.observationId) retainReadBody(row, saved[index]);
      saved[index] = item;
    }
    else if (saved.length < maximum) saved.push(item);
  }
}
/** Stable isolated-world node identity, document coordinates and source purpose/owner. */
function admitControl(
  control: XPageControl,
  observed: XPageObservation,
  row: XReadObservation,
  stage: XReadStage,
): boolean {
  const key = JSON.stringify([
    observed.location.documentEpoch,
    observed.location.routeRevision,
    observed.location.navigationSequence,
    control.binding.generation,
    control.binding.nodeId,
    control.kind,
    control.postId,
    row.postId,
  ]);
  if (stage.attemptedControls.has(key)) {
    row.status = 'partial';
    row.reason = `${control.kind}_control_unchanged`;
    row.stopReason = 'action_failed';
    return false;
  }
  stage.attemptedControls.add(key);
  return true;
}
/** Persist each validated frame before an action can replace its virtual DOM. */
export function savePostFrame(
  row: XReadObservation,
  observed: XPageObservation,
  request: XReadRequest,
  context: XResearchContext,
): boolean {
  if (readBarrier(row, observed)) return false;
  if (
    !observed.identityProven ||
    !observed.root ||
    observed.root.postId !== row.postId
  ) {
    row.status = 'partial';
    row.reason = 'post_identity_unproven';
    row.stopReason = 'identity_unproven';
    return false;
  }
  admitXSourceRoot(observed);
  if(row.diagnostics && observed.diagnosticFrame) row.diagnostics.firstAdmittedFrame ??= observed.diagnosticFrame;
  if (row.root === observed.root) return true;
  if (row.root) retainReadBody(row, row.root);
  const rootEntries=observed.entries.filter(entry=>observed.entryParents.get(entry)===observed.root);
  const selected=rootEntries[0];
  if(observed.root.articlePreviewInventory) {
    observed.root.articlePreviewInventory.retained=selected?1:0;
    observed.root.articlePreviewInventory.omitted=rootEntries.length-(selected?1:0);
  }
  if(selected) observed.root.articlePreviews=[{entryObservationId:selected.observationId,parentPostId:selected.parentPostId,sourceUrl:selected.sourceUrl,targetUrl:selected.targetUrl}];
  row.root = observed.root;
  row.sourceUrl = observed.root.sourceUrl;
  mergeText(row, row.quotedPosts, observed.quotedPosts);
  const incoming = request.includeReplies ? observed.replies : [];
  mergeText(row, row.replies.observations, incoming, request.maxRepliesPerPost);
  rememberSources(context, [
    observed.root,
    ...observed.quotedPosts,
    ...incoming.filter((p) => row.replies.observations.includes(p)),
  ]);
  const documentUrl = observed.snapshot.url;
  const safe = observed.location.current;
  if (!safe.redacted && safe.origin && safe.path) {
    row.documentSource = {
      urlKind: 'document',
      sourceUrl: documentUrl,
      observationId: observed.root.observationId,
      rootObservationId: observed.root.observationId,
      observedAt: observed.root.observedAt,
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
    sources.push(row.documentSource);
    context.sources.set(row.postId!, sources);
  } else row.documentSource = null;
  if (!row.article.actionAttempted) {
    row.article.entry =
      rootEntries[0] ??
      row.article.entry;
    row.article.entryObserved = !!row.article.entry;
  }
  row.replies.scope = applyReplyEndEvidence(
    {
      ...row.replies.scope,
      rootPostId: row.postId,
      branch: observed.replyScope?.branch ?? null,
      sort: observed.replyScope?.sort ?? null,
      displayedReplyCount: observed.replyScope?.displayedReplyCount ?? null,
    },
    observed.replyScope?.endEvidence ?? null,
  );
  row.budgetUsage.distinctEntries = new Set(
    [
      row.root,
      ...row.quotedPosts,
      ...row.replies.observations,
      ...(row.article.body ? [row.article.body] : []),
    ].map((p) => p.postId),
  ).size;
  return true;
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
  if (observed.diagnosticFrame) {
    const diagnostics = row.diagnostics ??= {version:1};
    diagnostics.initialFrame ??= observed.diagnosticFrame;
    diagnostics.terminalFrame = observed.diagnosticFrame;
  }
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
function discussionReady(
  observed: XPageObservation,
  row: XReadObservation,
): boolean {
  return (
    observed.replies.some(
      (p) => p.containerKind === 'reply' && !!p.postId && !!p.sourceUrl,
    ) ||
    observed.controls.some((c) => c.kind === 'replies_expand') ||
    row.replies.scope.completeness === 'ui_scope_end_observed'
  );
}
/** Poll cadence only schedules fresh source observations; elapsed time never proves page state. */
function pauseRead(context: XResearchContext): Promise<void> {
  checkReadCancelled(context);
  return new Promise((resolve, reject) => {
    const cleanup = () => context.signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 100);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new KydogError('browser.cancelled', 'X read cancelled'));
    };
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
  });
}
/** One readiness deadline before discussion actions. Existing port operations retain their lease. */
async function waitForDiscussion(
  page: XQueuedPage,
  initial: XPageObservation,
  request: Extract<XPageRequest, { stage: 'post' }>,
  row: XReadObservation,
  limits: XReadRequest,
  stage: XReadStage,
  context: XResearchContext,
): Promise<XPageObservation | null> {
  let observed = initial;
  const predicate = (frame:XPageObservation) => ({
    replyCount:frame.replies.filter(p=>p.containerKind==='reply' && !!p.postId && !!p.sourceUrl).length,
    expandControlCount:frame.controls.filter(c=>c.kind==='replies_expand').length,
    explicitEndObserved:frame.replyScope?.completeness==='ui_scope_end_observed',
  });
  const readiness: XReadDiagnostics['readiness'] = row.diagnostics ? row.diagnostics.readiness = {collectCount:1,initial:predicate(initial),terminal:predicate(initial),timedOut:false} : undefined;
  if (discussionReady(observed, row)) return observed;
  const documentUrl = initial.snapshot.url;
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
  }, 8000);
  try {
    for (;;) {
      checkReadCancelled(context);
      stage.current = 'wait';
      await pauseRead(context);
      checkReadCancelled(context);
      if (expired) break;
      // Do not race collection against the deadline: a still-issued operation must
      // finish its owned cleanup, and its late observation cannot authorize input.
      observed = await collectPostFrame(page, request, row, stage, context);
      if (readiness) {readiness.collectCount++;readiness.terminal=predicate(observed);}
      checkReadCancelled(context);
      if (readBarrier(row, observed)) return null;
      if (observed.snapshot.url !== documentUrl) {
        row.status = 'partial';
        row.reason = 'post_identity_unproven';
        row.stopReason = 'identity_unproven';
        return null;
      }
      if (!savePostFrame(row, observed, limits, context)) return null;
      if (expired) break;
      if (discussionReady(observed, row)) return observed;
    }
    row.status = 'partial';
    row.reason = 'reply_readiness_timeout';
    row.stopReason = 'wait_timeout';
    if (readiness) readiness.timedOut=true;
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
/** Body expansion is independent of Article and discussion. Every click uses a new collection. */
export async function expandPostBody(
  page: XQueuedPage,
  initial: XPageObservation,
  request: Extract<XPageRequest, { stage: 'post' }>,
  row: XReadObservation,
  limits: XReadRequest,
  stage: XReadStage,
  context: XResearchContext,
): Promise<XPageObservation> {
  let observed = initial;
  while (savePostFrame(row, observed, limits, context)) {
    const control = observed.controls.find(
      (c) => c.kind === 'body_expand' && c.postId === row.postId,
    );
    if (!control) return observed;
    if (row.budgetUsage.expandActions >= limits.maxExpandActionsPerPost) {
      row.status = 'partial';
      row.reason = 'body_expand_budget_reached';
      row.stopReason = 'budget_reached';
      return observed;
    }
    if (!admitControl(control, observed, row, stage)) return observed;
    checkReadCancelled(context);
    stage.current = 'action';
    stage.actionIndex++;
    await page.act(
      {
        kind: 'click',
        index: control.binding.index,
        snapshotId: control.binding.snapshotId,
      },
      observed.snapshot,
    );
    row.budgetUsage.expandActions++;
    checkReadCancelled(context);
    observed = await collectPostFrame(page, request, row, stage, context);
  }
  return observed;
}
/** No no-new-items or geometry heuristic ever turns this bounded read into completeness. */
export async function readDiscussion(
  page: XQueuedPage,
  initial: XPageObservation,
  request: Extract<XPageRequest, { stage: 'post' }>,
  row: XReadObservation,
  limits: XReadRequest,
  stage: XReadStage,
  context: XResearchContext,
): Promise<void> {
  let observed = initial;
  if (!savePostFrame(row, observed, limits, context) || !limits.includeReplies)
    return;
  if (row.replies.observations.length < limits.maxRepliesPerPost) {
    const ready = await waitForDiscussion(
      page,
      observed,
      request,
      row,
      limits,
      stage,
      context,
    );
    checkReadCancelled(context);
    if (!ready) return;
    observed = ready;
  }
  for (;;) {
    checkReadCancelled(context);
    if (!savePostFrame(row, observed, limits, context)) return;
    if (!limits.includeReplies) return;
    if (row.replies.scope.completeness === 'ui_scope_end_observed') {
      row.stopReason = 'explicit_ui_end';
      return;
    }
    const control = observed.controls.find((c) => c.kind === 'replies_expand');
    const capped =
      row.replies.observations.length >= limits.maxRepliesPerPost ||
      (control
        ? row.budgetUsage.expandActions >= limits.maxExpandActionsPerPost
        : row.budgetUsage.scrolls >= limits.maxScrollsPerPost);
    if (capped) {
      row.status = 'partial';
      row.reason ??= 'reply_budget_reached';
      row.stopReason = 'budget_reached';
      return;
    }
    checkReadCancelled(context);
    stage.current = 'action';
    if (control) {
      if (!admitControl(control, observed, row, stage)) return;
      stage.actionIndex++;
      try {
        await page.act(
          {
            kind: 'click',
            index: control.binding.index,
            snapshotId: control.binding.snapshotId,
          },
          observed.snapshot,
        );
      } catch (error) {
        const diagnostic = pointerFailureDiagnostic(error);
        if (diagnostic && diagnostic.snapshotId === control.binding.snapshotId
          && diagnostic.generation === control.binding.generation && diagnostic.nodeId === control.binding.nodeId) {
          (row.diagnostics ??= {version:1}).pointerFailure = {
            actionIndex:stage.actionIndex,targetPostId:row.postId!,controlKind:'replies_expand',
            sourceRelation:control.sourceRelation ?? 'unknown',diagnostic,
          };
          logger.warn('xResearch', 'Reply expansion pointer interception', {
            runId: context.runId, callId: context.callId, batchId: context.batchId, diagnostic,
          });
        }
        throw error;
      }
      row.budgetUsage.expandActions++;
    } else {
      stage.actionIndex++;
      const scroll = (row.diagnostics ??= {version:1}).scroll ??= {totalAttempts:0,omittedAttempts:0};
      scroll.totalAttempts++;
      scroll.omittedAttempts=scroll.totalAttempts-new Set([scroll.first?.actionIndex,scroll.last?.actionIndex].filter((id):id is number=>id!==undefined)).size;
      const actionIndex=stage.actionIndex;
      await page.act({ kind: 'scroll', direction: 'down' }, observed.snapshot, {
        scrollAcknowledgement: { onWritten: () => { row.budgetUsage.scrolls++; }, onReceipt: receipt => {
          const saved = {actionIndex,snapshotId:observed.snapshot.snapshotId,generation:receipt.generation,location:observed.location.current,
            targetKind:receipt.targetKind,targetNodeId:receipt.targetNodeId,targetContainsHit:receipt.targetContainsHit,
            conversationRelation:receipt.conversationRelation,rootRelation:receipt.rootRelation,
            before:receipt.before,after:receipt.after,scrollHeight:receipt.scrollHeight,clientHeight:receipt.clientHeight,
            written:receipt.written,eventObserved:receipt.eventObserved,frameObserved:receipt.frameObserved,state:receipt.state};
          if(scroll.totalAttempts===1) scroll.first=saved;
          scroll.last=saved;
          scroll.omittedAttempts=scroll.totalAttempts-new Set([scroll.first?.actionIndex,scroll.last?.actionIndex].filter((id):id is number=>id!==undefined)).size;
        }, relationNodes:{conversationNodeId:observed.diagnosticFrame?.regionNodeId??null,rootNodeId:observed.diagnosticFrame?.rootNodeId??null} },
      });
    }
    checkReadCancelled(context);
    observed = await collectPostFrame(page, request, row, stage, context);
  }
}
