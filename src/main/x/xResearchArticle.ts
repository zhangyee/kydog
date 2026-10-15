import { KydogError } from '../../shared/errors';
import type { XQueuedPage } from './xResearchBrowser';
import type { XPageObservation } from './xObservation';
import {
  compareXLocation,
  isXPostUrl,
  proveArticleIdentity,
  toSafeXLocation,
} from './xResearchIdentity';
import {
  collectFreshXPage,
  committedFacts,
  locationFacts,
  failure,
  navigationUrl,
  rememberSources,
  X_AUTH_READY_SELECTOR,
  type XResearchContext,
} from './xResearchSearch';
import {
  beginReadNavigation,
  retainClickFailure,
  preflightObserver,
  checkReadCancelled,
  readBarrier,
  type XReadStage,
} from './xResearchReadStages';
import type { XReadObservation, XReadRequest } from './xResearchTypes';

/** One exact observed entry is attempted once. Caller owns return navigation outside the queue. */
export async function readArticle(
  page: XQueuedPage,
  parent: XPageObservation,
  row: XReadObservation,
  limits: XReadRequest,
  stage: XReadStage,
  context: XResearchContext,
): Promise<{ returnToParent: boolean }> {
  if (!limits.includeArticle) return { returnToParent: false };
  const entry = parent.entries.find((e) => parent.entryParents.get(e) === parent.root);
  const barrier = (reason: string) => {
    row.article.barrier = { status: 'partial', reason, observationId: null };
    row.status = 'partial';
    row.reason ??= reason;
  };
  if (!entry) {
    barrier('no_entry_observed');
    return { returnToParent: false };
  }
  row.article.entry = entry;
  row.article.entryObserved = true;
  if (row.budgetUsage.expandActions >= limits.maxExpandActionsPerPost) {
    barrier('article_budget_reached');
    row.stopReason = 'budget_reached';
    return { returnToParent: false };
  }
  let returnToParent = false;
  try {
    checkReadCancelled(context);
    stage.current = 'action';
    stage.actionIndex++;
    row.article.actionAttempted = true;
    const action = await page.act(
      {
        kind: 'click',
        index: entry.binding.index,
        snapshotId: entry.binding.snapshotId,
      },
      parent.snapshot,
      {onPointerPreflight:preflightObserver(row,{kind:'article_entry',binding:entry.binding},stage.actionIndex)},
    );
    row.budgetUsage.expandActions++;
    row.article.navigationStarted = action.navigation !== null;
    if (action.navigation)
      row.article.location = committedFacts(
        entry.targetUrl ?? entry.sourceUrl,
        action.navigation,
      );
    returnToParent = action.navigation !== null;
    checkReadCancelled(context);
    if (action.navigation?.outcome.kind === 'cancelled')
      throw new KydogError('browser.cancelled', 'Article navigation cancelled');
    const destination = action.navigation
      ? navigationUrl(action.navigation)
      : null;
    if (destination && action.navigation)
      beginReadNavigation(stage, 'article', action.navigation);
    const safe = destination ? toSafeXLocation(destination) : null;
    // The fallback is the actual observed parent coordinate, used ONLY to collect
    // an actual access barrier when navigation cannot name a public Article URL.
    const expectedUrl =
      destination && isXPostUrl(destination) && !safe?.redacted
        ? destination
        : entry.sourceUrl;
    const request = {
      stage: 'article' as const,
      expectedUrl,
      entry,
      via: { kind: 'action' as const, result: action },
    };
    stage.current = 'collection';
    let observed = await collectFreshXPage(
      page,
      request,
      row.collectionTransitions,
      context.signal,
      stage.collectionBudget,
    );
    checkReadCancelled(context);
    if (!observed.article && !observed.state && destination) {
      stage.current = 'wait';
      const ready = await page.wait(
        {
          selector:
            '[data-testid="twitterArticleReadView"], ' + X_AUTH_READY_SELECTOR,
          state: 'present',
        },
        8000,
      );
      checkReadCancelled(context);
      stage.current = 'collection';
      observed = await collectFreshXPage(
        page,
        request,
        row.collectionTransitions,
        context.signal,
        stage.collectionBudget,
      );
      checkReadCancelled(context);
      if (!ready && !observed.article && !observed.state) {
        barrier('article_body_wait_timeout');
        row.stopReason = 'wait_timeout';
        return { returnToParent };
      }
    }
    if (action.navigation) {
      row.article.location = locationFacts(
        entry.targetUrl ?? entry.sourceUrl,
        action.navigation,
        observed,
      );
      row.article.location.relation = compareXLocation(
        entry.targetUrl ?? entry.sourceUrl,
        observed.snapshot.url,
      );
    }
    if (readBarrier(row, observed)) {
      row.article.barrier = row.barrier;
      return { returnToParent: false };
    }
    if (!destination) {
      barrier('article_navigation_failed');
      row.stopReason = 'navigation_failed';
      return { returnToParent };
    }
    const verdict = proveArticleIdentity(entry, observed, action.navigation);
    if (!verdict.proven) {
      barrier(verdict.reason);
      row.stopReason = 'identity_unproven';
      return { returnToParent };
    }
    row.article.body = observed.article!.body;
    row.article.bodyObserved = true;
    rememberSources(context, [row.article.body]);
    row.budgetUsage.distinctEntries++;
    return { returnToParent: true };
  } catch (error) {
    retainClickFailure(row,{kind:'article_entry',postId:entry.parentPostId,binding:entry.binding},stage,error,context);
    const problem = failure(error, stage.current);
    row.article.barrier = {
      status: problem.status === 'cancelled' ? 'cancelled' : 'partial',
      reason: `article_${stage.current}_failed${error instanceof KydogError ? ':' + error.code : ''}`,
      observationId: null,
    };
    if (
      problem.internal ||
      problem.status === 'cancelled' ||
      (error instanceof KydogError &&
        ['browser.no_tab', 'browser.not_dispatchable'].includes(error.code))
    )
      throw error;
    row.status = 'partial';
    row.reason = row.article.barrier.reason;
    row.stopReason = problem.stopReason;
    return { returnToParent };
  }
}
