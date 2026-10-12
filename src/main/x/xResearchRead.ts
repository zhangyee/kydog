import { KydogError } from '../../shared/errors';
import { compareXLocation, toSafeXLocation } from './xResearchIdentity';
import {
  aggregateResult,
  collectFreshXPage,
  committedFacts,
  emptyUsage,
  failure,
  locationFacts,
  navigationUrl,
  rememberSources,
  X_POST_READY_SELECTOR,
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
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' ||
      u.port ||
      u.username ||
      u.password ||
      !['x.com', 'twitter.com'].includes(u.hostname) ||
      (!coordinatesOnly && (u.search || u.hash))
    )
      return null;
    return (
      /^\/(?:[A-Za-z0-9_]+\/status|i\/web\/status)\/([0-9]+)(?:\/history|\/(?:photo|video)\/[0-9]+)?\/?$/.exec(
        u.pathname,
      )?.[1] ?? null
    );
  } catch {
    return null;
  }
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
    let stage: 'navigation' | 'collection' | 'action' | 'wait' = 'navigation';
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
          };
          stage = 'collection';
          let observed = await collectFreshXPage(
            page,
            request,
            row.collectionTransitions,
            context.signal,
          );
          let waitFailed = false;
          if (
            !unsupportedRoute &&
            observed.scope.collectedItemCount === 0 &&
            !observed.state &&
            observed.location.current.origin &&
            observed.location.relation.postId !== 'different'
          ) {
            stage = 'wait';
            waitFailed = !(await page.wait(
              { selector: X_POST_READY_SELECTOR, state: 'present' },
              8000,
            ));
            stage = 'collection';
            observed = await collectFreshXPage(
              page,
              request,
              row.collectionTransitions,
              context.signal,
            );
          }
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
          if (!observed.identityProven || !observed.root) {
            row.status = waitFailed ? 'failed' : 'partial';
            row.reason = waitFailed
              ? 'post_wait_timeout'
              : 'post_identity_unproven';
            row.stopReason = waitFailed ? 'wait_timeout' : 'identity_unproven';
            return;
          }
          row.root = observed.root;
          row.sourceUrl = observed.root.sourceUrl;
          row.quotedPosts = observed.quotedPosts;
          rememberSources(context, [observed.root, ...observed.quotedPosts]);
          const documentUrl = observed.snapshot.url;
          if (observedPostId(documentUrl) === id) {
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
            const sources = context.sources.get(id) ?? [];
            sources.push(row.documentSource);
            context.sources.set(id, sources);
          }
          row.budgetUsage.distinctEntries = 1 + observed.quotedPosts.length;
          row.article.entry =
            observed.entries.find((e) => e.parentPostId === id) ?? null;
          row.article.entryObserved = !!row.article.entry;
          row.replies.scope.rootPostId = id;
          const later = input.read.includeArticle || input.read.includeReplies;
          row.status =
            waitFailed || later || observed.root.truncation.truncated
              ? 'partial'
              : 'observed';
          row.reason = waitFailed
            ? 'post_wait_timeout'
            : later
              ? 'later_stages_not_implemented'
              : null;
          row.stopReason = waitFailed ? 'wait_timeout' : 'agent_stopped';
        },
      );
    } catch (error) {
      const problem = failure(error, stage);
      row.status =
        row.root && problem.status !== 'cancelled' ? 'partial' : problem.status;
      row.stopReason = problem.stopReason;
      row.reason =
        problem.status === 'cancelled'
          ? 'cancelled'
          : problem.internal
            ? `internal_adapter_error:${stage}`
            : `${stage}_failed${error instanceof KydogError ? ':' + error.code : ''}`;
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
    }
  }
  aggregateResult(result);
  return result;
}
