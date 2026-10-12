import { BrowserScrollAcknowledgementError } from '../browser/actions';
import { KydogError } from '../../shared/errors';
import type { NavigationObservation } from '../../shared/types';
import { collectXPage, type XPageRequest, type XPageObservation } from './xPageSource';
import type { BrowserLocationFacts } from '../browser/browserService';
import type { XQueuedPage, XResearchBrowser } from './xResearchBrowser';
import { compareXLocation, toSafeXLocation } from './xResearchIdentity';
import type { XBudgetUsage, XLocationFacts, XResearchInput, XResearchResult, XResearchStatus, XSearchObservation, XStopReason, XTextObservation, XSourceReference, XCollectionTransition } from './xResearchTypes';

export type XSearchInput = Extract<XResearchInput, { search: unknown }>;
/** Session-owned source table. Preserve actual URLs and every discovery's provenance. */
export type { XObservedSource } from './xResearchTypes';
export interface XResearchContext {
  browser: XResearchBrowser; threadId: string; runId: string; callId: string; batchId: string;
  signal?: AbortSignal; sources: Map<string, XSourceReference[]>;
}
// Every selector comes from the dated actual X DOM source guide. Readiness
// only gates one bounded wait; it never proves identity or completeness.
export const X_AUTH_READY_SELECTOR='[role="dialog"] input[name="username_or_email"][type="text"][autocomplete="username webauthn"]';
export const X_SEARCH_READY_SELECTOR='[data-testid="primaryColumn"] [data-testid="tweet"], [data-testid="primaryColumn"] [data-testid="emptyState"], '+X_AUTH_READY_SELECTOR;
export const X_POST_READY_SELECTOR='[aria-label="Timeline: Conversation"] [data-testid="tweet"], '+X_AUTH_READY_SELECTOR;
export function xSearchUrl(query:XSearchObservation['query']):string {
  const url=new URL('https://x.com/search');url.searchParams.set('q',query.query);url.searchParams.set('f',query.product==='Latest'?'live':'top');return url.href;
}
export const emptyUsage = (): XBudgetUsage => ({ scrolls:0, expandActions:0, distinctEntries:0, outputBytes:0 });
export function rememberSources(context:XResearchContext, posts:XTextObservation[], query?:XSearchObservation['query']): void {
  for (const p of posts) if (p.postId && p.sourceUrl) {
    const entries=context.sources.get(p.postId)??[];
    entries.push({urlKind:'permalink',rootObservationId:p.containerKind==='root_post'?p.observationId:null,sourceUrl:p.sourceUrl,observationId:p.observationId,observedAt:p.observedAt,containerKind:p.containerKind,runId:context.runId,callId:context.callId,batchId:context.batchId,queryId:query?.id??null,query:query?.query??null,purpose:query?.purpose??null,product:query?.product??null});
    context.sources.set(p.postId,entries);
  }
}
export function navigationUrl(nav:NavigationObservation): string | null {
  return nav.outcome.kind==='ok' || nav.outcome.kind==='ok_same_document' ? nav.outcome.finalUrl : null;
}
export function locationFacts(expected:string, nav:NavigationObservation, observation:XPageObservation): XLocationFacts {
  const committed=navigationUrl(nav);
  return {committedNavigationOutcome:nav.outcome.kind,requested:toSafeXLocation(expected),committed:committed?toSafeXLocation(committed):null,subsequent:observation.location.current,
    relation:observation.location.relation,documentGeneration:`${observation.location.documentEpoch}:${observation.location.routeRevision}:${observation.location.navigationSequence}`,navigationEvent:observation.location.navigationEvent};
}
export function committedFacts(expected:string, nav:NavigationObservation): XLocationFacts {
  const committed=navigationUrl(nav);
  return {committedNavigationOutcome:nav.outcome.kind,requested:toSafeXLocation(expected),committed:committed?toSafeXLocation(committed):null,subsequent:null,
    relation:compareXLocation(expected,committed??''),documentGeneration:null,navigationEvent:null};
}
export function failure(error:unknown, stage:'navigation'|'collection'|'action'|'wait'): {status:XResearchStatus;stopReason:XStopReason;internal:boolean;reason?:BrowserScrollAcknowledgementError['reason']} {
  if(error instanceof BrowserScrollAcknowledgementError) return {status:'failed',stopReason:error.reason==='scroll_ack_timeout'?'wait_timeout':'action_failed',internal:false,reason:error.reason};
  if(error instanceof KydogError && error.code==='browser.stale_snapshot' && stage==='collection') return {status:'partial',stopReason:'identity_unproven',internal:false};
  if(error instanceof KydogError && error.code==='browser.cancelled') return {status:'cancelled',stopReason:'cancelled',internal:false};
  const internal=!(error instanceof KydogError) || error.code==='x.invalid_page';
  return {status:'failed',stopReason:stage==='navigation'?'navigation_failed':stage==='wait'?'wait_timeout':'action_failed',internal};
}
export function aggregateResult(result:XResearchResult): XResearchResult {
  const entries=result.operation==='search'?result.queries:result.targets;
  const statuses=entries.map(e=>e.status);
  result.status=statuses.every(s=>s===statuses[0]) ? statuses[0] : statuses.includes('cancelled')?'cancelled':statuses.includes('auth_required')?'auth_required':'partial';
  result.budgetUsage=entries.reduce((a,e)=>({scrolls:a.scrolls+e.budgetUsage.scrolls,expandActions:a.expandActions+e.budgetUsage.expandActions,distinctEntries:a.distinctEntries+e.budgetUsage.distinctEntries,outputBytes:0}),emptyUsage());
  return result;
}
export function searchResult(input:XSearchInput,context:XResearchContext): Extract<XResearchResult,{operation:'search'}> {
  return {schemaVersion:2,sourceKind:'rendered_ui',operation:'search',callId:context.callId,batchId:context.batchId,runId:context.runId,browserTabId:input.tabId??'',objective:input.search.objective,status:'partial',budgetUsage:emptyUsage(),truncation:{returned:0,totalKnown:0,truncated:false},
    queries:input.search.queries.map(query=>({query,collectionTransitions:[],status:'failed',posts:[],stopReason:'agent_stopped',budgetUsage:emptyUsage(),location:null,barrier:null}))};
}
export async function searchX(input:XSearchInput, context:XResearchContext): Promise<Extract<XResearchResult,{operation:'search'}>> {
  const result=searchResult(input,context);
  let halted:false|'cancelled'|'other'=false;
  for (const row of result.queries) {
    if(halted || context.signal?.aborted) { if(halted==='cancelled' || context.signal?.aborted){row.status='cancelled';row.stopReason='cancelled';} continue; }
    const url=new URL(xSearchUrl(row.query));
    let stage:'navigation'|'collection'|'action'|'wait'='navigation';
    try {
      const opened=await context.browser.open(url.href,result.browserTabId||undefined,context.signal);
      result.browserTabId=opened.tabId;
      const committed=navigationUrl(opened.nav);row.location=committedFacts(url.href,opened.nav);
      if(!committed) { row.status=opened.nav.outcome.kind==='cancelled'?'cancelled':'failed';row.stopReason=row.status==='cancelled'?'cancelled':'navigation_failed';halted=opened.nav.outcome.kind==='cancelled'?'cancelled':opened.nav.outcome.kind==='crashed'?'other':false;continue; }
      await context.browser.withPage(opened.tabId,context.signal,async page=>{
        const seen=new Set<string>();
        const request={stage:'search' as const,expectedUrl:url.href,query:row.query.query,product:row.query.product};
        let waited=false, waitFailed=false;
        while(true) {
          stage='collection';const observed=await collectFreshXPage(page,request,row.collectionTransitions,context.signal);
          row.location=locationFacts(url.href,opened.nav,observed);
          if(observed.state?.kind==='auth_required') {row.status='auth_required';row.stopReason='access_barrier';row.barrier={status:'auth_required',reason:observed.state.text,observationId:observed.state.observationId};break;}
          if(waitFailed) {
            if(observed.identityProven) {rememberSources(context,observed.posts,row.query);for(const p of observed.posts) if(p.postId && !seen.has(p.postId) && row.posts.length<input.search.maxPostsPerQuery) {seen.add(p.postId);row.posts.push(p);}row.budgetUsage.distinctEntries=row.posts.length;}
            row.status=row.posts.length?'partial':'failed';row.stopReason='wait_timeout';break;
          }
          if(!observed.identityProven) {
            // Loading may lack the observed primary region. A bounded wait is
            // allowed once; contradictory identity is never repaired by retry.
            // The genuinely observed onboarding route may precede its form.
            // Waiting for that exact DOM never asserts auth by URL alone.
            const authRoute=new URL(observed.snapshot.url).pathname==='/i/jf/onboarding/web';
            const queryConsistent=observed.location.relation.path!=='different' && observed.location.relation.query!=='different' && observed.location.relation.product!=='different' && (!observed.scope.selectedProduct || observed.scope.selectedProduct===row.query.product);
            if(observed.scope.collectedItemCount===0 && !waited && observed.location.current.origin && (authRoute || queryConsistent)) {
              stage='wait';waited=true;
              waitFailed=!await page.wait({selector:X_SEARCH_READY_SELECTOR,state:'present'},8000);
              continue;
            }
            row.status='partial';row.stopReason='identity_unproven';break;
          }
          rememberSources(context,observed.posts,row.query);
          for(const p of observed.posts) if(p.postId && !seen.has(p.postId) && row.posts.length<input.search.maxPostsPerQuery) {seen.add(p.postId);row.posts.push(p);}
          row.budgetUsage.distinctEntries=row.posts.length;
          if(observed.state?.kind==='explicit_empty') {row.status=row.posts.length?'partial':'explicit_empty';row.stopReason='explicit_ui_end';row.barrier={status:'explicit_empty',reason:observed.state.text,observationId:observed.state.observationId};break;}
          if(observed.scope.collectedItemCount===0 && !waited) {
            stage='wait';waited=true;
            waitFailed=!await page.wait({selector:X_SEARCH_READY_SELECTOR,state:'present'},8000);
            continue;
          }
          if(row.posts.length>=input.search.maxPostsPerQuery || row.budgetUsage.scrolls>=input.search.maxScrollsPerQuery) {row.status='partial';row.stopReason='budget_reached';break;}
          stage='action';await page.act({kind:'scroll',direction:'down'},observed.snapshot);row.budgetUsage.scrolls++;
        }
      });
    } catch(error) {
      const problem=failure(error,stage);row.status=row.posts.length && problem.status!=='cancelled'?'partial':problem.status;row.stopReason=problem.stopReason;halted=problem.status==='cancelled'?'cancelled':problem.internal || (error instanceof KydogError && ['browser.no_tab','browser.not_dispatchable'].includes(error.code))?'other':false;
      row.barrier={status:problem.status,reason:problem.internal?`internal_adapter_error:${stage}`:`${stage}_failed${error instanceof KydogError?':'+error.code:''}`,observationId:null};
    }
    if(row.status==='auth_required') halted='other';
  }
  aggregateResult(result);return result;
}

/** Owned by a single successful explicit navigation receipt, not by actions or waits. */
export interface XCollectionBudget {
  navigationPhase: NonNullable<XCollectionTransition['navigationPhase']>;
  navigationId: string;
  rereadRequested: boolean;
}
/** A rejected observation is never consumed. One new collection is permitted
 * only by an exact same-URL navigation-generation change, never by elapsed time. */
export async function collectFreshXPage(page:XQueuedPage, request:XPageRequest, transitions:XCollectionTransition[], signal?:AbortSignal, budget?:XCollectionBudget):Promise<XPageObservation> {
  const safe=(facts:BrowserLocationFacts)=>({location:toSafeXLocation(facts.currentUrl),documentEpoch:facts.documentEpoch,routeRevision:facts.routeRevision,navigationSequence:facts.navigationSequence,navigationEvent:facts.navigationEvent});
  let reread=budget?.rereadRequested ?? transitions.some(t=>t.rereadRequested);
  for(;;) {
    if(signal?.aborted) throw new KydogError('browser.cancelled','X observation cancelled');
    const before=page.location();
    try {return await collectXPage(page,request);}
    catch(error) {
      if(!(error instanceof KydogError) || error.code!=='browser.stale_snapshot') throw error;
      const after=page.location();
      const changed=before.documentEpoch!==after.documentEpoch || before.routeRevision!==after.routeRevision || before.navigationSequence!==after.navigationSequence;
      const sameUrl=before.currentUrl===after.currentUrl;
      const allowed=changed && sameUrl && !reread && !signal?.aborted;
      transitions.push({...(budget?{navigationPhase:budget.navigationPhase,navigationId:budget.navigationId}:{}),stage:request.stage,before:safe(before),after:safe(after),relation:compareXLocation(before.currentUrl,after.currentUrl),rereadRequested:allowed,
        outcome:signal?.aborted?'cancelled':reread?'repeated_invalidation':!sameUrl?'route_changed':changed?'same_url_generation_changed':'generation_unchanged'});
      if(signal?.aborted) throw new KydogError('browser.cancelled','X observation cancelled');
      if(!allowed) throw new KydogError('browser.stale_snapshot','X navigation invalidated this observation');
      reread=true;
      if(budget) budget.rereadRequested=true;
    }
  }
}
