import { reachedXBudgets, resolveXBudgetPolicy, sampleXEntries, type XBudgetPolicy } from './xResearchBudget';
import {getSourceFailure} from './xSourceDiagnostics';
import type {BrowserScrollReceipt} from '../browser/actions';
import {isScrollReceipt} from './xScrollRecovery';
import { BrowserScrollAcknowledgementError } from '../browser/actions';
import { KydogError } from '../../shared/errors';
import type { NavigationObservation } from '../../shared/types';
import { collectXPage, type XPageRequest, type XPageObservation } from './xObservation';
import type { BrowserLocationFacts } from '../browser/browserService';
import type { XQueuedPage, XResearchBrowser } from './xResearchBrowser';
import { compareXLocation, toSafeXLocation } from './xResearchIdentity';
import type { XBudgetUsage, XLocationFacts, XResearchInput, XResearchResult, XResearchStatus, XSearchObservation, XStopReason, XTextObservation, XSourceReference, XCollectionTransition } from './xResearchTypes';

export type XSearchInput = Extract<XResearchInput, { search: unknown }>;
/** Session-owned source table. Preserve actual URLs and every discovery's provenance. */
export type { XObservedSource } from './xResearchTypes';
export interface XResearchContext {
  browser: XResearchBrowser; threadId: string; runId: string; callId: string; batchId: string;
  budgetPolicy?: XBudgetPolicy;
  signal?: AbortSignal; sources: Map<string, XSourceReference[]>;
}
// Every selector comes from the dated actual X DOM source guide. Readiness
// only gates one bounded wait; it never proves identity or completeness.
export const X_AUTH_READY_SELECTOR='[role="dialog"] input[name="username_or_email"][type="text"][autocomplete="username webauthn"]';
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
  return {schemaVersion:2,sourceKind:'page_graphql',operation:'search',callId:context.callId,batchId:context.batchId,runId:context.runId,browserTabId:input.tabId??'',objective:input.search.objective,status:'partial',budgetUsage:emptyUsage(),truncation:{returned:0,totalKnown:0,truncated:false},
    queries:input.search.queries.map(query=>({query,collectionTransitions:[],status:'failed',posts:[],stopReason:'agent_stopped',budgetUsage:emptyUsage(),location:null,barrier:null}))};
}
export async function searchX(input:XSearchInput, context:XResearchContext): Promise<Extract<XResearchResult,{operation:'search'}>> {
  const result=searchResult(input,context);
  const policy={...(context.budgetPolicy??resolveXBudgetPolicy(input,input)),network_pages:{limit:1000,origin:'safety' as const}};
  let halted:false|'cancelled'|'auth_required'|'other'=false;
  for(const row of result.queries){
    if(halted||context.signal?.aborted){if(halted==='cancelled'||context.signal?.aborted){row.status='cancelled';row.stopReason='cancelled';}else if(halted==='auth_required'){row.status='auth_required';row.stopReason='access_barrier';row.barrier={status:'auth_required',reason:'not_attempted:auth_required',observationId:null};}continue;}
    const admitted=new Set<string>(),saved=new Set<string>();let pageCount=0;
    row.sampleTruncation={observed:0,sampled:0,omitted:0};
    const capped=()=>{const bindings=reachedXBudgets(policy,{posts:admitted.size,scrolls:row.budgetUsage.scrolls,network_pages:pageCount},['posts','scrolls','network_pages']);if(bindings.length)row.budgetBinding=bindings;return bindings.length>0;};
    if(input.search.maxPostsPerQuery===0&&capped()){row.status='partial';row.stopReason='budget_reached';continue;}
    const request={stage:'search' as const,expectedUrl:xSearchUrl(row.query),query:row.query.query,product:row.query.product};
    let stage:'navigation'|'collection'|'action'|'wait'='navigation';
    try {
      const opened=await context.browser.open(request.expectedUrl,result.browserTabId||undefined,context.signal,request);result.browserTabId=opened.tabId;
      row.location=committedFacts(request.expectedUrl,opened.nav);
      if(!navigationUrl(opened.nav)){row.status=opened.nav.outcome.kind==='cancelled'?'cancelled':'failed';row.stopReason=row.status==='cancelled'?'cancelled':'navigation_failed';halted=row.status==='cancelled'?'cancelled':false;continue;}
      await context.browser.withPage(opened.tabId,context.signal,async page=>{
        let waited=false,waitFailed=false,bottom=false;
        while(true){
          stage='collection';const observed=await collectFreshXPage(page,request,row.collectionTransitions,context.signal);row.location=locationFacts(request.expectedUrl,opened.nav,observed);
          if(observed.state?.kind==='auth_required'){row.status='auth_required';row.stopReason='access_barrier';row.barrier={status:'auth_required',reason:observed.state.text,observationId:observed.state.observationId};break;}
          let terminal=false,unsupported=false,accepted=0;
          for(const source of observed.network?.pages??[]){
            if(saved.has(source.provenance.requestRef))continue;
            if(pageCount>=1000)break;
            saved.add(source.provenance.requestRef);pageCount++;accepted++;
            const sample=sampleXEntries(source.posts.filter((p):p is XTextObservation&{postId:string}=>p.postId!==null&&p.sourceKind==='page_graphql'&&p.networkProvenance?.leaseId===source.provenance.leaseId&&p.networkProvenance.requestRef===source.provenance.requestRef),admitted,input.search.maxPostsPerQuery);
            for(const key of ['observed','sampled','omitted'] as const)row.sampleTruncation![key]+=sample[key];
            for(const post of sample.retained){if(row.posts.some(p=>p.postId===post.postId))(row.postObservations??=[]).push(post);else row.posts.push(post);}
            const fact=observed.network?.facts?.find(f=>f.provenance.requestRef===source.provenance.requestRef);
            if(fact)(row.networkPages??=[]).push({...fact,observed:sample.observed,sampled:sample.sampled,omitted:sample.omitted});
            rememberSources(context,sample.retained,row.query);row.budgetUsage.distinctEntries=admitted.size;
            terminal ||= source.end==='cursor_exhausted';unsupported ||= source.unsupported.length>0;
          }
          const budget=capped();
          if(unsupported||observed.network?.failure){row.status=row.posts.length?'partial':'unavailable';row.stopReason=observed.network?.failure==='wait_timeout'?'wait_timeout':observed.network?.failure==='cancelled'?'cancelled':'source_unavailable';if(row.stopReason==='cancelled')row.status='cancelled';row.barrier={status:row.status,reason:observed.network?.failure??'unsupported_response',observationId:null};break;}
          if(terminal){row.status=row.sampleTruncation!.omitted?'partial':row.posts.length?'observed':'explicit_empty';row.stopReason='cursor_exhausted';break;}
          if(waitFailed){row.status=row.posts.length?'partial':'failed';row.stopReason='wait_timeout';break;}
          // collect drains associated response bodies before this geometric stop.
          if(bottom&&!observed.network?.pending){row.status='partial';row.stopReason='explicit_ui_end';break;}
          if(!observed.network?.proof||!observed.identityProven){
            if(!waited){stage='wait';waited=true;waitFailed=!await page.wait({selector:X_AUTH_READY_SELECTOR,state:'present'},8000);continue;}
            row.status='unavailable';row.stopReason='source_unavailable';break;
          }
          if(budget){row.status='partial';row.stopReason='budget_reached';break;}
          if(observed.network.pending)continue;
          if(!accepted&&!waited){stage='wait';waited=true;waitFailed=!await page.wait({selector:X_AUTH_READY_SELECTOR,state:'present'},8000);continue;}
          if(accepted)waited=false;
          stage='action';let receipt:BrowserScrollReceipt|undefined;
          const scroll=(row.diagnostics??={version:1}).scroll??={totalAttempts:0,omittedAttempts:0};
          const actionIndex=++scroll.totalAttempts;
          const omissions=()=>{scroll.omittedAttempts=scroll.totalAttempts-new Set([scroll.first?.actionIndex,scroll.last?.actionIndex].filter(id=>id!==undefined)).size;};omissions();
          try{await page.act({kind:'scroll',direction:'down'},observed.snapshot,{scrollAcknowledgement:{onWritten:()=>{row.budgetUsage.scrolls++;},onReceipt:value=>{if(!isScrollReceipt(value)||value.generation!==observed.snapshot.generation)return;
            receipt={...value};const saved={actionIndex,snapshotId:observed.snapshot.snapshotId,...receipt,location:observed.location.current};
            if(!scroll.first||scroll.first.actionIndex===actionIndex)scroll.first=saved;scroll.last=saved;omissions();}}});}
          catch(error){if(!(error instanceof BrowserScrollAcknowledgementError&&receipt?.state==='no_movement'))throw error;}
          bottom=!!receipt&&receipt.written&&receipt.after+receipt.clientHeight>=receipt.scrollHeight;
        }
      });
    }catch(error){
      const sourceFailure=getSourceFailure(error);if(sourceFailure)(row.diagnostics??={version:1}).sourceFailure=sourceFailure;
      const problem=failure(error,stage);row.status=row.posts.length&&problem.status!=='cancelled'?'partial':problem.status;
      row.stopReason=error instanceof KydogError&&error.message==='source_unavailable:wait_timeout'?'wait_timeout':problem.stopReason==='action_failed'||problem.stopReason==='identity_unproven'?'source_unavailable':problem.stopReason;
      halted=problem.status==='cancelled'?'cancelled':problem.internal||(error instanceof KydogError&&['browser.no_tab','browser.not_dispatchable'].includes(error.code))?'other':false;
      row.barrier={status:row.status,reason:error instanceof KydogError&&error.message.startsWith('source_unavailable:')?error.message:problem.reason??`${stage}_failed${error instanceof KydogError?':'+error.code:''}`,observationId:null};
    }
    if(row.status==='auth_required')halted='auth_required';
  }
  for(const row of result.queries)row.collectionStop={status:row.status,stopReason:row.stopReason,reason:row.barrier?.reason??null};
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
