import { KydogError } from '../../shared/errors';
import { toSafeXLocation } from './xResearchIdentity';
import { collectFreshXPage, aggregateResult, committedFacts, emptyUsage, failure, locationFacts, navigationUrl, rememberSources, X_POST_READY_SELECTOR, type XResearchContext } from './xResearchSearch';
import type { XReadObservation, XResearchInput, XResearchResult, XReadTarget } from './xResearchTypes';

export type XReadInput = Extract<XResearchInput,{read:unknown}>;
/** Recognize observed public coordinates, including actual Edit History links. Never generate a permalink. */
function observedPostId(raw:string, coordinatesOnly=false): string | null {
  try {const u=new URL(raw);return u.protocol==='https:' && !u.port && !u.username && !u.password && ['x.com','twitter.com'].includes(u.hostname) && (coordinatesOnly || (!u.search && !u.hash)) ? /^\/(?:[A-Za-z0-9_]+\/status|i\/web\/status)\/([0-9]+)(?:\/history|\/(?:photo|video)\/[0-9]+)?\/?$/.exec(u.pathname)?.[1]??null : null;} catch{return null;}
}
function safeInputUrl(target:XReadTarget):string|null {
  if(!target.url) return null;
  // Retain a literal source only when safe, never fabricate a cleaned version.
  return observedPostId(target.url)?target.url:null;
}
function emptyTarget(input:XReadInput,target:XReadTarget):XReadObservation {
  const redacted=!!target.url && !safeInputUrl(target);
  const id=target.postId??(target.url?observedPostId(target.url,true):null);
  const safeTarget=redacted && id?{postId:id}:target;
  return {target:safeTarget,collectionTransitions:[],documentSource:null,inputKind:target.url?'url':'postId',inputUrlRedacted:redacted,postId:id,inputUrl:safeInputUrl(target),sourceUrl:null,status:'failed',reason:'not_attempted',root:null,quotedPosts:[],
    article:{requested:input.read.includeArticle,entryObserved:false,actionAttempted:false,navigationStarted:false,bodyObserved:false,entry:null,body:null,barrier:null},
    replies:{requested:input.read.includeReplies,observations:[],scope:{rootPostId:null,branch:null,sort:null,stopReason:'agent_stopped',displayedReplyCount:null,completeness:'unknown',endEvidence:null}},
    stopReason:'agent_stopped',budgetUsage:emptyUsage(),location:target.url?{committedNavigationOutcome:null,requested:toSafeXLocation(target.url),committed:null,subsequent:null,relation:{origin:'unknown',path:'unknown',postId:'unknown',query:'unknown',product:'unknown',fragment:'unknown'},documentGeneration:null,navigationEvent:null}:null,barrier:null};
}
export function readResult(input:XReadInput,context:XResearchContext):Extract<XResearchResult,{operation:'read'}> {
  return {schemaVersion:2,sourceKind:'rendered_ui',operation:'read',callId:context.callId,batchId:context.batchId,runId:context.runId,browserTabId:input.tabId,objective:input.read.objective,status:'partial',budgetUsage:emptyUsage(),truncation:{returned:0,totalKnown:0,truncated:false},targets:input.read.targets.map(t=>emptyTarget(input,t))};
}
export async function readX(input:XReadInput,context:XResearchContext):Promise<Extract<XResearchResult,{operation:'read'}>> {
  const result=readResult(input,context);let halted=false;
  for(const [index,row] of result.targets.entries()) {
    if(halted || context.signal?.aborted) {row.reason=halted?'internal_adapter_stopped':'cancelled';if(context.signal?.aborted){row.status='cancelled';row.stopReason='cancelled';}continue;}
    if(row.inputUrlRedacted) {row.reason='unsafe_target_url';row.stopReason='identity_unproven';row.replies.scope.stopReason=row.stopReason;continue;}
    const target=input.read.targets[index];
    const recorded=context.sources.get(target.postId??'')??[];
    const source=target.url??[...recorded].reverse().find(s=>s.urlKind==='document' && observedPostId(s.sourceUrl)===row.postId)?.sourceUrl??recorded.find(s=>observedPostId(s.sourceUrl)===row.postId)?.sourceUrl;
    if(!source) {row.reason='unresolved_target';continue;}
    const id=observedPostId(source);
    if(!id) {row.reason='unsafe_target_url';continue;}
    row.postId=id;
    let stage:'navigation'|'collection'|'action'|'wait'='navigation';
    try {
      const opened=await context.browser.open(source,input.tabId,context.signal);
      result.browserTabId=opened.tabId;const committed=navigationUrl(opened.nav);row.location=committedFacts(source,opened.nav);
      if(!committed) {row.reason='navigation_failed';row.stopReason=opened.nav.outcome.kind==='cancelled'?'cancelled':'navigation_failed';row.status=row.stopReason==='cancelled'?'cancelled':'failed';halted=['cancelled','crashed'].includes(opened.nav.outcome.kind);continue;}
      await context.browser.withPage(opened.tabId,context.signal,async page=>{
        const request={stage:'post' as const,expectedUrl:source,postId:id};
        stage='collection';let observed=await collectFreshXPage(page,request,row.collectionTransitions,context.signal);
        if(observed.scope.collectedItemCount===0 && !observed.state && observed.location.current.origin && observed.location.relation.postId!=='different') {
          stage='wait';const ready=await page.wait({selector:X_POST_READY_SELECTOR,state:'present'},8000);
          stage='collection';observed=await collectFreshXPage(page,request,row.collectionTransitions,context.signal);
          if(!ready && observed.state?.kind!=='auth_required') {row.location=locationFacts(source,opened.nav,observed);row.status='failed';row.reason='post_wait_timeout';row.stopReason='wait_timeout';return;}
        }
        row.location=locationFacts(source,opened.nav,observed);
        if(observed.state?.kind==='auth_required') {row.status='auth_required';row.reason='auth_required';row.stopReason='access_barrier';row.barrier={status:'auth_required',reason:observed.state.text,observationId:observed.state.observationId};return;}
        if(!observed.identityProven || !observed.root) {row.status='partial';row.reason='post_identity_unproven';row.stopReason='identity_unproven';return;}
        row.root=observed.root;row.sourceUrl=observed.root.sourceUrl;row.quotedPosts=observed.quotedPosts;
        rememberSources(context,[observed.root,...observed.quotedPosts]);
        // The private snapshot URL is from this exact validated collection.
        // A later location() call must never substitute an unrelated document.
        const documentUrl=observed.snapshot.url;
        if(observedPostId(documentUrl)===id) {
          row.documentSource={urlKind:'document',sourceUrl:documentUrl,observationId:observed.root.observationId,rootObservationId:observed.root.observationId,
            observedAt:observed.root.observedAt,containerKind:'root_post',runId:context.runId,callId:context.callId,batchId:context.batchId,queryId:null,query:null,purpose:null,product:null};
          const sources=context.sources.get(id)??[];sources.push(row.documentSource);context.sources.set(id,sources);
        }
        row.budgetUsage.distinctEntries=1+observed.quotedPosts.length;
        row.article.entry=observed.entries.find(e=>e.parentPostId===id)??null;row.article.entryObserved=!!row.article.entry;
        row.replies.scope.rootPostId=id;
        // Task4 is the ordinary vertical chain. Later Article/reply orchestration
        // must use fresh trusted bindings; include flags never imply attempts.
        const later=input.read.includeArticle || input.read.includeReplies;
        row.status=later || observed.root.truncation.truncated?'partial':'observed';row.reason=later?'later_stages_not_implemented':null;row.stopReason='agent_stopped';
      });
    } catch(error) {
      const problem=failure(error,stage);row.status=row.root && problem.status!=='cancelled'?'partial':problem.status;row.stopReason=problem.stopReason;
      row.reason=problem.internal?`internal_adapter_error:${stage}`:`${stage}_failed${error instanceof KydogError?':'+error.code:''}`;halted=problem.internal || problem.status==='cancelled' || (error instanceof KydogError && ['browser.no_tab','browser.not_dispatchable'].includes(error.code));
    }
    row.replies.scope.stopReason=row.stopReason;
    if(row.status==='auth_required') halted=true;
  }
  aggregateResult(result);return result;
}
