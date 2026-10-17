import type {XNetworkPage} from './xNetworkSource';
import {getXNetworkCleanupFailure,type XNetworkPageFact} from './xNetworkLease';
import { reachedXBudgets, resolveXBudgetPolicy, sampleXEntries, type XBudgetPolicy } from './xResearchBudget';
import {getSourceFailure} from './xSourceDiagnostics';
import type {BrowserScrollReceipt} from '../browser/actions';
import {isScrollReceipt} from './xScrollRecovery';
import { BrowserScrollAcknowledgementError } from '../browser/actions';
import { KydogError } from '../../shared/errors';
import { logger } from '../log';
import type { NavigationObservation } from '../../shared/types';
import { collectXPage, type XPageRequest, type XPageObservation } from './xObservation';
import type { BrowserLocationFacts } from '../browser/browserService';
import type { XQueuedPage, XResearchBrowser } from './xResearchBrowser';
import { compareXLocation, toSafeXLocation } from './xResearchIdentity';
import type { XBudgetUsage, XLocationFacts, XReadObservation, XResearchInput, XResearchResult, XResearchStatus, XSearchObservation, XStopReason, XTextObservation, XSourceReference, XCollectionTransition } from './xResearchTypes';
import type { XResearchSection, XResearchWorkState } from '../../shared/xResearchTask';

export type XSearchInput = Extract<XResearchInput, { search: unknown }>;
/** Session-owned source table. Preserve actual URLs and every discovery's provenance. */
export type { XObservedSource } from './xResearchTypes';
/** 任务侧的进度事件（spec §5.5）：采集循环在**阶段边界**说一句「这一行此刻在哪一段」。
 *  `row` 是采集层正在改的那一行 —— 接收方收到即抄数字，绝不保留引用；它不进结果、不进工件。 */
export type XResearchProgressEvent = {
  section: XResearchSection;
  /** 这一行在**本次提交**里的序号（`queries` / `targets` 的下标）。 */
  rowIndex: number;
  state: XResearchWorkState;
  phaseDetail?: 'root' | 'article' | 'return' | 'discussion';
  row: XSearchObservation | XReadObservation;
};
export interface XResearchContext {
  browser: XResearchBrowser; threadId: string; runId: string; callId: string; batchId: string;
  budgetPolicy?: XBudgetPolicy;
  signal?: AbortSignal; sources: Map<string, XSourceReference[]>;
  /** 唯一的进度缝：不传就没有进度，行为与改造前逐字节相同。 */
  onProgress?: (event: XResearchProgressEvent) => void;
}
/** 观察者抛异常绝不影响采集（与 `retainClickFailure` 同一条规矩）：采集的结论不因一个观察者改写。
 *  但吞掉之前必须留一条诊断：一个系统性坏掉的投影表现为「一条进度也没有」，日志是它唯一露面的地方。 */
export function reportXProgress(context: XResearchContext, event: XResearchProgressEvent): void {
  try { context.onProgress?.(event); }
  catch (err) {
    logger.warn('x_research', 'progress observer threw', {
      section: event.section, rowIndex: event.rowIndex, state: event.state, err: String(err),
    });
  }
}
// Every selector comes from the dated actual X DOM source guide. Readiness
// only gates one bounded wait; it never proves identity or completeness.
export const X_AUTH_READY_SELECTOR='[role="dialog"] input[name="username_or_email"][type="text"][autocomplete="username webauthn"]';
export const X_POST_READY_SELECTOR='[aria-label="Timeline: Conversation"] [data-testid="tweet"], '+X_AUTH_READY_SELECTOR;
/** X loads the next page only once the viewport nears the bottom of the list, so a
 *  round without a reply means "not far enough yet", not "the list ended". Pause
 *  this long for a slow reply, then keep scrolling. */
export const X_SCROLL_REPLY_WAIT_MS = 3000;
/** Extra per-round pause drawn from [0, this): a machine-regular scroll cadence is
 *  itself a behavioural signal, so the pause must not be constant. */
export const X_SCROLL_REPLY_JITTER_MS = 1500;
export const xScrollPauseMs = (): number => X_SCROLL_REPLY_WAIT_MS + Math.floor(Math.random() * X_SCROLL_REPLY_JITTER_MS);
/** HTTP statuses that mean "the source is refusing the rate": 429/503 are limits,
 *  anything else is an access/source fact. Kept finite for the barrier reason. */
export const HALTING_HTTP_STATUS = /^http_status:(\d{3})$/;
export function xHttpFailure(reason: string): {status: XResearchStatus; stopReason: XStopReason; reason: string; skippedReason: string} | null {
  const match = HALTING_HTTP_STATUS.exec(reason.replace(/^source_unavailable:/, ''));
  if (!match) return null;
  const code = Number(match[1]);
  const status = code === 429 || code === 503 ? 'rate_limited' : code === 401 || code === 403 ? 'access_denied' : 'unavailable';
  return {status, stopReason: status === 'unavailable' ? 'source_unavailable' : 'access_barrier', reason: `http_status:${code}`,
    skippedReason: status === 'rate_limited' ? 'not_attempted:rate_limited' : `not_attempted:http_status:${code}`};
}
/** Consecutive scroll rounds whose write moved nothing before the row stops. */
export const X_SEARCH_UNMOVED_ROUNDS = 2;
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
  let halted:false|'cancelled'|'auth_required'|'rate_limited'|'other'=false;
  let httpHalt: ReturnType<typeof xHttpFailure> = null;
  for(const row of result.queries){
    if(halted||httpHalt||context.signal?.aborted){
      if(halted==='cancelled'||context.signal?.aborted){row.status='cancelled';row.stopReason='cancelled';}
      else if(halted==='auth_required'){row.status='auth_required';row.stopReason='access_barrier';row.barrier={status:'auth_required',reason:'not_attempted:auth_required',observationId:null};}
      else if(httpHalt){row.status=httpHalt.status;row.stopReason=httpHalt.stopReason;row.barrier={status:httpHalt.status,reason:httpHalt.skippedReason,observationId:null};}
      // A skipped row must not read as "the agent stopped": it was never attempted
      // because an earlier row hit the same source barrier (or an adapter defect).
      else if(halted==='rate_limited'){row.status='rate_limited';row.stopReason='access_barrier';row.barrier={status:'rate_limited',reason:'not_attempted:rate_limited',observationId:null};}
      else {row.status='failed';row.stopReason='source_unavailable';row.barrier={status:'failed',reason:'internal_adapter_stopped',observationId:null};}
      continue;
    }
    const admitted=new Set<string>(),saved=new Set<string>();let pageCount=0,unsupportedSeen=false;
    row.sampleTruncation={observed:0,sampled:0,omitted:0};
    const capped=()=>{const bindings=reachedXBudgets(policy,{posts:admitted.size,scrolls:row.budgetUsage.scrolls,network_pages:pageCount},['posts','scrolls','network_pages']);if(bindings.length)row.budgetBinding=bindings;return bindings.length>0;};
    const acceptNetworkPage=(source:XNetworkPage,fact?:XNetworkPageFact)=>{
      // Retained across the whole row: an unrecorded shape anywhere in the
      // collected chain means the row cannot claim a complete timeline even if a
      // later page proves the cursor end, so it stays partial.
      if(source.unsupported.length)unsupportedSeen=true;
      if(saved.has(source.provenance.requestRef))return;
      if(pageCount>=1000)return;
      saved.add(source.provenance.requestRef);pageCount++;
      const sample=sampleXEntries(source.posts.filter((p):p is XTextObservation&{postId:string}=>p.postId!==null&&p.sourceKind==='page_graphql'&&p.networkProvenance?.leaseId===source.provenance.leaseId&&p.networkProvenance.requestRef===source.provenance.requestRef),admitted,input.search.maxPostsPerQuery);
      for(const key of ['observed','sampled','omitted'] as const)row.sampleTruncation![key]+=sample[key];
      for(const post of sample.retained){if(row.posts.some(p=>p.postId===post.postId))(row.postObservations??=[]).push(post);else row.posts.push(post);}
      if(fact)(row.networkPages??=[]).push({...fact,observed:sample.observed,sampled:sample.sampled,omitted:sample.omitted});
      rememberSources(context,sample.retained,row.query);row.budgetUsage.distinctEntries=admitted.size;
      capped();
      // 每接纳一页就是一帧可见的新数字（spec §5.5 第 2 条），行仍是活着的那一行。
      reportXProgress(context,{section:'search',rowIndex:result.queries.indexOf(row),state:'collecting',row});
    };
    if(input.search.maxPostsPerQuery===0&&capped()){row.status='partial';row.stopReason='budget_reached';continue;}
    const request={stage:'search' as const,expectedUrl:xSearchUrl(row.query),query:row.query.query,product:row.query.product};
    let stage:'navigation'|'collection'|'action'|'wait'='navigation';
    try {
      reportXProgress(context,{section:'search',rowIndex:result.queries.indexOf(row),state:'navigating',row});
      const opened=await context.browser.open(request.expectedUrl,result.browserTabId||undefined,context.signal,request);result.browserTabId=opened.tabId;
      row.location=committedFacts(request.expectedUrl,opened.nav);
      if(opened.networkCleanupFailure)(row.diagnostics??={version:1}).networkCleanupFailure=opened.networkCleanupFailure;
      if(!navigationUrl(opened.nav)){row.status=opened.nav.outcome.kind==='cancelled'?'cancelled':'failed';row.stopReason=row.status==='cancelled'?'cancelled':'navigation_failed';halted=row.status==='cancelled'?'cancelled':false;continue;}
      await context.browser.withPage(opened.tabId,context.signal,async page=>{
        let waited=false,bottom=false,lastMoved=true,unmoved=0,stepReceipt:BrowserScrollReceipt|undefined;
        while(true){
          const priorPageCount=pageCount;
          // A fresh reread allowance per collection: X search performs a same-URL
          // generation change on load and again around a scroll, and the row-wide
          // one-shot check rejected the second one. The outer loop's post/scroll
          // budget still bounds how many times this can happen.
          stage='collection';reportXProgress(context,{section:'search',rowIndex:result.queries.indexOf(row),state:'collecting',row});const observed=await collectFreshXPage(page,request,row.collectionTransitions,context.signal,{rereadRequested:false});row.location=locationFacts(request.expectedUrl,opened.nav,observed);
          if(observed.state?.kind==='auth_required'){row.status='auth_required';row.stopReason='access_barrier';row.barrier={status:'auth_required',reason:observed.state.text,observationId:observed.state.observationId};break;}
          let terminal=false;
          for(const source of observed.network?.pages??[]){
            acceptNetworkPage(source,observed.network?.facts?.find(f=>f.provenance.requestRef===source.provenance.requestRef));
            terminal ||= source.end==='cursor_exhausted';
          }
          const accepted=pageCount-priorPageCount;
          const budget=capped();
          // An unrecorded shape is a retained page fact, not a source failure:
          // its page keeps end='unknown' and collection continues on the proven
          // cursor until a real failure, budget, terminal or wait limits it.
          if(observed.network?.failure){
            if(xHttpFailure(observed.network.failure))throw new KydogError('x.invalid_page', 'source_unavailable:'+observed.network.failure);
            row.status=row.posts.length?'partial':'unavailable';row.stopReason=observed.network?.failure==='wait_timeout'?'wait_timeout':observed.network?.failure==='cancelled'?'cancelled':'source_unavailable';if(row.stopReason==='cancelled')row.status='cancelled';row.barrier={status:row.status,reason:observed.network?.failure,observationId:null};break;
          }
          if(terminal){row.status=(unsupportedSeen||row.sampleTruncation!.omitted)?'partial':row.posts.length?'observed':'explicit_empty';row.stopReason='cursor_exhausted';break;}
          // A page that arrived means the list grew: the earlier geometric bottom is
          // stale, so keep scrolling instead of stopping on it.
          if(accepted){bottom=false;unmoved=0;}else if(!lastMoved)unmoved++;
          if(!observed.network?.proof||!observed.identityProven){
            // No provable response chain even after a bounded wait: the design stop for
            // "no matching response before the deadline".
            if(!waited){stage='wait';waited=true;reportXProgress(context,{section:'search',rowIndex:result.queries.indexOf(row),state:'waiting',row});await page.wait({selector:X_AUTH_READY_SELECTOR,state:'present'},8000);continue;}
            row.status=row.posts.length?'partial':'unavailable';row.stopReason='wait_timeout';break;
          }
          if(budget){row.status='partial';row.stopReason='budget_reached';break;}
          // Only a container that has stopped moving ends the row: on X's virtualized
          // list a geometric bottom is reached after almost every scroll, so one
          // bottom receipt is not an end. `explicit_ui_end` still labels the case
          // where the stop happened at the container bottom.
          if(!observed.network?.pending&&unmoved>=X_SEARCH_UNMOVED_ROUNDS){row.status='partial';row.stopReason=bottom?'explicit_ui_end':'wait_timeout';break;}
          if(observed.network.pending)continue;
          // Keep scrolling toward the bottom: one bounded pause for a slow reply,
          // then another scroll. Ending after a single unanswered round is what
          // left every long page on its first batch.
          if(!accepted){stage='wait';reportXProgress(context,{section:'search',rowIndex:result.queries.indexOf(row),state:'waiting',row});await page.wait({selector:X_AUTH_READY_SELECTOR,state:'present'},xScrollPauseMs());}
          stage='action';reportXProgress(context,{section:'search',rowIndex:result.queries.indexOf(row),state:'scrolling',row});let receipt:BrowserScrollReceipt|undefined;
          // X only loads the next page near the bottom of a very long virtualized
          // list (live: 240,890px, ~14 one-viewport rounds per page). Ask for the
          // whole remaining distance so one round lands at the bottom and triggers
          // the next page instead of inching toward it.
          const remaining=stepReceipt?Math.round(stepReceipt.scrollHeight-stepReceipt.clientHeight-stepReceipt.after):null;
          const amount=remaining!==null&&remaining>0?remaining:undefined;
          const scroll=(row.diagnostics??={version:1}).scroll??={totalAttempts:0,omittedAttempts:0};
          const actionIndex=++scroll.totalAttempts;
          const omissions=()=>{scroll.omittedAttempts=scroll.totalAttempts-new Set([scroll.first?.actionIndex,scroll.last?.actionIndex].filter(id=>id!==undefined)).size;};omissions();
          try{await page.act({kind:'scroll',direction:'down',...(amount===undefined?{}:{amount})},observed.snapshot,{scrollAcknowledgement:{onWritten:()=>{row.budgetUsage.scrolls++;},onReceipt:value=>{if(!isScrollReceipt(value)||value.generation!==observed.snapshot.generation)return;
            receipt={...value};const saved={actionIndex,snapshotId:observed.snapshot.snapshotId,...receipt,location:observed.location.current};
            if(!scroll.first||scroll.first.actionIndex===actionIndex)scroll.first=saved;scroll.last=saved;omissions();}}});}
          catch(error){
            const writtenInvalidation=isScrollReceipt(receipt)&&receipt.state==='invalidated'&&receipt.written&&receipt.after!==receipt.before;
            if(error instanceof BrowserScrollAcknowledgementError&&receipt?.state==='no_movement'){/* executed no-op; geometry below stays authoritative */}
            // The write landed but the page changed underneath it (X search does a
            // same-URL in-page navigation around a scroll). Re-collect the new
            // generation and keep the chain instead of ending the query.
            else if(writtenInvalidation&&error instanceof KydogError&&error.code==='browser.stale_snapshot')continue;
            else throw error;
          }
          if(receipt)stepReceipt=receipt;
          bottom=!!receipt&&receipt.written&&receipt.after+receipt.clientHeight>=receipt.scrollHeight;
          lastMoved=!!receipt&&receipt.written&&receipt.after!==receipt.before;
        }
      },{onNetworkPageAccepted:acceptNetworkPage});
    }catch(error){
      const networkCleanupFailure=getXNetworkCleanupFailure(error);if(networkCleanupFailure)(row.diagnostics??={version:1}).networkCleanupFailure=networkCleanupFailure;
      const sourceFailure=getSourceFailure(error);if(sourceFailure)(row.diagnostics??={version:1}).sourceFailure=sourceFailure;
      const problem=failure(error,stage);row.status=row.posts.length&&problem.status!=='cancelled'?'partial':problem.status;
      row.stopReason=error instanceof KydogError&&error.message==='source_unavailable:wait_timeout'?'wait_timeout':problem.stopReason==='action_failed'||problem.stopReason==='identity_unproven'?'source_unavailable':problem.stopReason;
      halted=problem.status==='cancelled'?'cancelled':problem.internal||(error instanceof KydogError&&['browser.no_tab','browser.not_dispatchable'].includes(error.code))?'other':false;
      let reason=error instanceof KydogError&&error.message.startsWith('source_unavailable:')?error.message:problem.reason??`${stage}_failed${error instanceof KydogError?':'+error.code:''}`;
      // A non-200 is a source fact, not an adapter defect: rate limiting gets the
      // designed barrier instead of a generic source_unavailable, and it halts the
      // rest of the batch (further queries would only burn the limit further).
      const http=xHttpFailure(reason);
      if(http){
        reason=http.reason;
        row.status=row.posts.length?'partial':http.status;
        row.stopReason=http.stopReason;
        httpHalt=http;
      }
      row.barrier={status:row.status,reason,observationId:null};
    }
    if(row.status==='auth_required')halted='auth_required';
    else if(row.status==='rate_limited')halted='rate_limited';
  }
  for(const row of result.queries)row.collectionStop={status:row.status,stopReason:row.stopReason,reason:row.barrier?.reason??null};
  aggregateResult(result);return result;
}

/** Owned by a single successful explicit navigation receipt, not by actions or waits. */
export interface XCollectionBudget {
  navigationPhase?: NonNullable<XCollectionTransition['navigationPhase']>;
  navigationId?: string;
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
      const relation=compareXLocation(before.currentUrl,after.currentUrl);
      const sameUrl=before.currentUrl===after.currentUrl;
      // X canonicalizes an author handle in place (…/weiwang/status/ID → …/wei_wang/status/ID).
      // That is still the same post, so the identity that gates a re-read is origin plus
      // post id; a genuine retarget changes the post id and stays rejected.
      const samePost=relation.origin==='same'&&relation.postId==='same';
      const allowed=changed && (sameUrl||samePost) && !reread && !signal?.aborted;
      transitions.push({...(budget?.navigationPhase&&budget.navigationId?{navigationPhase:budget.navigationPhase,navigationId:budget.navigationId}:{}),stage:request.stage,before:safe(before),after:safe(after),relation,rereadRequested:allowed,
        outcome:signal?.aborted?'cancelled':reread?'repeated_invalidation':!sameUrl?'route_changed':changed?'same_url_generation_changed':'generation_unchanged'});
      if(signal?.aborted) throw new KydogError('browser.cancelled','X observation cancelled');
      if(!allowed) throw new KydogError('browser.stale_snapshot','X navigation invalidated this observation');
      reread=true;
      if(budget) budget.rereadRequested=true;
    }
  }
}
