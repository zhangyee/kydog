import {getSourceFailure} from './xSourceDiagnostics';
import { readArticle } from './xResearchArticle';
import {
  beginReadNavigation,
  checkReadCancelled,
  collectPostFrame,
  collectReadyPostFrame,
  expandPostBody,
  readDiscussion,
  savePostFrame,
  retainReadBody,
  type XReadStage,
} from './xResearchReadStages';
import { KydogError } from '../../shared/errors';
import {
  compareXLocation,
  toSafeXLocation,
  parseXPostCoordinates,
} from './xResearchIdentity';
import {
  aggregateResult,
  committedFacts,
  emptyUsage,
  failure,
  locationFacts,
  rememberSources,
  navigationUrl,
  type XResearchContext,
} from './xResearchSearch';
import type {
  XReadObservation,
  XResearchInput,
  XResearchResult,
  XReadTarget,
  XResearchStatus,
  XStopReason,
} from './xResearchTypes';

export type XReadInput = Extract<XResearchInput, { read: unknown }>;
/** Recognize literal observed public coordinates; never generate a permalink. */
function observedPostId(raw: string, coordinatesOnly = false): string | null {
  return (
    parseXPostCoordinates(raw, {
      allowMedia: true,
      allowQuery: coordinatesOnly,
    })?.id ?? null
  );
}
function ordinaryDocument(raw: string, id: string): boolean {
  return (
    observedPostId(raw) === id &&
    !/\/(?:history|(?:photo|video)\/[0-9]+)\/?$/.test(new URL(raw).pathname)
  );
}
function safeInputUrl(target: XReadTarget): string | null {
  if (!target.url) return null;
  return observedPostId(target.url) ? target.url : null;
}
function emptyTarget(input: XReadInput, target: XReadTarget): XReadObservation {
  const inputUrl = safeInputUrl(target);
  const redacted = !!target.url && !inputUrl;
  const id =
    target.postId ?? (target.url ? observedPostId(target.url, true) : null);
  const safeTarget = redacted && id ? { postId: id } : target;
  return {
    target: safeTarget,
    collectionTransitions: [],
    documentSource: null,
    inputKind: target.url ? 'url' : 'postId',
    inputUrlRedacted: redacted,
    postId: id,
    inputUrl,
    sourceUrl: null,
    status: 'failed',
    reason: 'not_attempted',
    root: null,
    quotedPosts: [],
    article: {
      requested: input.read.includeArticle,
      entryObserved: false,
      actionAttempted: false,
      navigationStarted: false,
      bodyObserved: false,
      entry: null,
      body: null,
      barrier: null,
    },
    replies: {
      requested: input.read.includeReplies,
      observations: [],
      scope: {
        rootPostId: null,
        branch: null,
        sort: null,
        stopReason: 'agent_stopped',
        displayedReplyCount: null,
        completeness: 'unknown',
        endEvidence: null,
      },
    },
    stopReason: 'agent_stopped',
    budgetUsage: emptyUsage(),
    location: target.url
      ? {
          committedNavigationOutcome: null,
          requested: toSafeXLocation(target.url),
          committed: null,
          subsequent: null,
          relation: {
            origin: 'unknown',
            path: 'unknown',
            postId: 'unknown',
            query: 'unknown',
            product: 'unknown',
            fragment: 'unknown',
          },
          documentGeneration: null,
          navigationEvent: null,
        }
      : null,
    barrier: null,
  };
}
export function readResult(
  input: XReadInput,
  context: XResearchContext,
): Extract<XResearchResult, { operation: 'read' }> {
  return {
    schemaVersion: 2,
    sourceKind: 'rendered_ui',
    operation: 'read',
    callId: context.callId,
    batchId: context.batchId,
    runId: context.runId,
    browserTabId: input.tabId,
    objective: input.read.objective,
    status: 'partial',
    budgetUsage: emptyUsage(),
    truncation: { returned: 0, totalKnown: 0, truncated: false },
    targets: input.read.targets.map((t) => emptyTarget(input, t)),
  };
}
interface ReadHalt {
  cause:
    | 'auth'
    | 'cancelled'
    | 'adapter'
    | 'browser_unavailable'
    | 'navigation';
  status: XResearchStatus;
  stopReason: XStopReason;
  reason: string;
}
export async function readX(
  input: XReadInput,
  context: XResearchContext,
): Promise<Extract<XResearchResult, { operation: 'read' }>> {
  const result = readResult(input, context);
  let halt: ReadHalt | null = null;
  for (const [index, row] of result.targets.entries()) {
    const stage: XReadStage = {
      current: 'navigation',
      actionIndex: 0,
      attemptedControls: new Set(),
    };
    let returnToParent = false;
    // Every exit, including unvisited targets and navigation receipts, synchronizes scope in finally.
    try {
      if (context.signal?.aborted)
        halt = {
          cause: 'cancelled',
          status: 'cancelled',
          stopReason: 'cancelled',
          reason: 'cancelled',
        };
      if (halt) {
        row.status = halt.status;
        row.reason = halt.reason;
        row.stopReason = halt.stopReason;
        continue;
      }
      if (row.inputUrlRedacted) {
        row.reason = 'unsafe_target_url';
        row.stopReason = 'identity_unproven';
        continue;
      }
      const target = input.read.targets[index];
      const recorded = context.sources.get(target.postId ?? '') ?? [];
      const source =
        target.url ??
        [...recorded]
          .reverse()
          .find(
            (s) =>
              s.urlKind === 'document' &&
              observedPostId(s.sourceUrl) === row.postId,
          )?.sourceUrl ??
        recorded.find((s) => observedPostId(s.sourceUrl) === row.postId)
          ?.sourceUrl;
      if (!source) {
        row.reason = 'unresolved_target';
        continue;
      }
      const id = observedPostId(source);
      if (!id) {
        row.reason = 'unsafe_target_url';
        row.stopReason = 'identity_unproven';
        continue;
      }
      row.postId = id;
      const opened = await context.browser.open(
        source,
        input.tabId,
        context.signal,
      );
      result.browserTabId = opened.tabId;
      checkReadCancelled(context);
      const committed = navigationUrl(opened.nav);
      row.location = committedFacts(source, opened.nav);
      if (!committed) {
        const cancelled = opened.nav.outcome.kind === 'cancelled';
        row.reason = cancelled ? 'cancelled' : 'navigation_failed';
        row.stopReason = cancelled ? 'cancelled' : 'navigation_failed';
        row.status = cancelled ? 'cancelled' : 'failed';
        if (cancelled)
          halt = {
            cause: 'cancelled',
            status: 'cancelled',
            stopReason: 'cancelled',
            reason: 'cancelled',
          };
        else if (opened.nav.outcome.kind === 'crashed')
          halt = {
            cause: 'navigation',
            status: 'failed',
            stopReason: 'navigation_failed',
            reason: 'not_attempted:navigation_failed',
          };
        continue;
      }
      beginReadNavigation(stage, 'initial_post', opened.nav);
      // Unsupported public documents still get one fixed collection for actual
      // access barriers. Their route alone cannot assert auth or admit a root.
      const unsupportedRoute =
        (!ordinaryDocument(source, id) && !ordinaryDocument(committed, id)) ||
        (observedPostId(committed, true) === id &&
          /\/(?:history|(?:photo|video)\/[0-9]+)\/?$/.test(
            new URL(committed).pathname,
          ));
      await context.browser.withPage(
        opened.tabId,
        context.signal,
        async (page) => {
          const request = {
            stage: 'post' as const,
            expectedUrl: ordinaryDocument(committed, id) ? committed : source,
            postId: id,
            ...(input.read.includeArticle ? { directOpen: opened } : {}),
          };
          const ready = await collectReadyPostFrame(
            page,
            request,
            row,
            stage,
            context,
            !unsupportedRoute,
          );
          let observed = ready.observed;
          const waitFailed = ready.waitFailed;
          checkReadCancelled(context);
          row.location = locationFacts(source, opened.nav, observed);
          // Compare original input to the exact private observation URL, even when
          // a public media/history input redirected to a supported document.
          row.location.relation = compareXLocation(
            source,
            observed.snapshot.url,
          );
          if (observed.state?.kind === 'auth_required') {
            row.status = 'auth_required';
            row.reason = 'auth_required';
            row.stopReason = 'access_barrier';
            row.barrier = {
              status: 'auth_required',
              reason: observed.state.text,
              observationId: observed.state.observationId,
            };
            halt = {
              cause: 'auth',
              status: 'auth_required',
              stopReason: 'access_barrier',
              reason: 'not_attempted:auth_required',
            };
            return;
          }
          if (unsupportedRoute) {
            row.status = 'partial';
            row.reason = 'unsupported_document_route';
            row.stopReason = 'identity_unproven';
            return;
          }
          if (observed.identityProven && !observed.root && observed.article && input.read.includeArticle) {
            const body = observed.article.body;
            row.article.body = body;
            row.article.bodyObserved = true;
            row.article.provenance = {kind:'direct_open',navigationId:opened.nav.navigationId,bodyObservationId:body.observationId,sourceUrl:body.sourceUrl!,...(observed.article.nativeIdentity?{nativeIdentity:observed.article.nativeIdentity}:{})};
            row.sourceUrl = body.sourceUrl;
            row.status = body.truncation.truncated || input.read.includeReplies ? 'partial' : 'observed';
            row.reason = input.read.includeReplies ? 'direct_article_discussion_unobserved' : null;
            row.replies.scope.rootPostId = body.postId;
            row.budgetUsage.distinctEntries = 1;
            rememberSources(context, [body]);
            return;
          }
          if (!observed.identityProven || !observed.root) {
            row.status = waitFailed ? 'failed' : 'partial';
            row.reason = waitFailed
              ? 'post_wait_timeout'
              : 'post_identity_unproven';
            row.stopReason = waitFailed ? 'wait_timeout' : 'identity_unproven';
            return;
          }
          row.status = 'observed';
          row.reason = null;
          savePostFrame(row, observed, input.read, context);
          if (waitFailed) {
            row.status = 'partial';
            row.reason = 'post_wait_timeout';
            row.stopReason = 'wait_timeout';
            return;
          }
          observed = await expandPostBody(
            page,
            observed,
            request,
            row,
            input.read,
            stage,
            context,
          );
          checkReadCancelled(context);
          if (
            !observed.identityProven ||
            !observed.root ||
            row.barrier?.status === 'auth_required'
          )
            return;
          if (row.root?.truncation.truncated) row.status = 'partial';
          const article = await readArticle(
            page,
            observed,
            row,
            input.read,
            stage,
            context,
          );
          checkReadCancelled(context);
          returnToParent = article.returnToParent;
          if (
            (row.status as XResearchStatus) === 'auth_required' ||
            returnToParent
          )
            return;
          // An attempted entry can mutate its DOM even when native safety rejects it.
          if (row.article.actionAttempted)
            observed = await collectPostFrame(
              page,
              request,
              row,
              stage,
              context,
            );
          await readDiscussion(
            page,
            observed,
            request,
            row,
            input.read,
            stage,
            context,
          );
        },
      );
      checkReadCancelled(context);
      if (returnToParent) {
        // open owns the queue. The saved same-observation document is the real return address.
        const parentUrl = row.documentSource?.sourceUrl ?? row.root?.sourceUrl;
        if (!parentUrl) {
          row.status = 'partial';
          row.reason = 'parent_return_identity_unproven';
          row.stopReason = 'identity_unproven';
        } else {
          stage.current = 'navigation';
          const returned = await context.browser.open(
            parentUrl,
            opened.tabId,
            context.signal,
          );
          checkReadCancelled(context);
          const finalUrl = navigationUrl(returned.nav);
          if (!finalUrl) {
            if (returned.nav.outcome.kind === 'cancelled')
              throw new KydogError(
                'browser.cancelled',
                'Parent return cancelled',
              );
            row.status = 'partial';
            row.reason = 'parent_return_navigation_failed';
            row.stopReason = 'navigation_failed';
          } else {
            beginReadNavigation(stage, 'return_post', returned.nav);
            const savedParent = {
              root: row.root,
              sourceUrl: row.sourceUrl,
              documentSource: row.documentSource,
            };
            try {
              await context.browser.withPage(
                opened.tabId,
                context.signal,
                async (page) => {
                  const request = {
                    stage: 'post' as const,
                    expectedUrl: parentUrl,
                    postId: id,
                  };
                  const { observed, waitFailed } = await collectReadyPostFrame(
                    page,
                    request,
                    row,
                    stage,
                    context,
                  );
                  checkReadCancelled(context);
                  const saved = savePostFrame(
                    row,
                    observed,
                    input.read,
                    context,
                  );
                  if (!saved && row.barrier?.status === 'auth_required') return;
                  if (waitFailed) {
                    row.status = 'partial';
                    row.reason = 'post_wait_timeout';
                    row.stopReason = 'wait_timeout';
                    return;
                  }
                  if (!saved) return;
                  await readDiscussion(
                    page,
                    observed,
                    request,
                    row,
                    input.read,
                    stage,
                    context,
                  );
                },
              );
            } finally {
              // Return-page previews are separate observations; retain the body actually expanded before Article.
              if (row.root && row.root.observationId !== savedParent.root?.observationId) retainReadBody(row, row.root);
              row.bodyObservations = row.bodyObservations?.filter(p => p.observationId !== savedParent.root?.observationId);
              Object.assign(row, savedParent);
            }
            checkReadCancelled(context);
          }
        }
      }
      if (row.status === 'auth_required')
        halt = {
          cause: 'auth',
          status: 'auth_required',
          stopReason: 'access_barrier',
          reason: 'not_attempted:auth_required',
        };
    } catch (error) {
      const sourceFailure=getSourceFailure(error);if(sourceFailure)(row.diagnostics??={version:1}).sourceFailure=sourceFailure;
      const problem = failure(error, stage.current);
      row.status =
        row.root && problem.status !== 'cancelled' ? 'partial' : problem.status;
      row.stopReason = problem.stopReason;
      row.reason = problem.reason ?? (
        problem.status === 'cancelled'
          ? 'cancelled'
          : problem.internal
            ? `internal_adapter_error:${stage.current}`
            : `${stage.current}_failed${error instanceof KydogError ? ':' + error.code : ''}`);
      if (problem.status === 'cancelled')
        halt = {
          cause: 'cancelled',
          status: 'cancelled',
          stopReason: 'cancelled',
          reason: 'cancelled',
        };
      else if (problem.internal)
        halt = {
          cause: 'adapter',
          status: 'failed',
          stopReason: problem.stopReason,
          reason: 'internal_adapter_stopped',
        };
      else if (
        error instanceof KydogError &&
        ['browser.no_tab', 'browser.not_dispatchable'].includes(error.code)
      )
        halt = {
          cause: 'browser_unavailable',
          status: 'failed',
          stopReason: problem.stopReason,
          reason: `not_attempted:${error.code}`,
        };
    } finally {
      row.replies.scope.stopReason = row.stopReason;
      row.collectionStop = {status:row.status,stopReason:row.stopReason,reason:row.reason};
    }
  }
  aggregateResult(result);
  return result;
}
