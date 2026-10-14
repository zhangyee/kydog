import {BrowserScrollAcknowledgementError,type BrowserScrollReceipt} from '../browser/actions';
import {KydogError} from '../../shared/errors';
import {collectXPage,type XPageObservation,type XPageRequest} from './xPageSource';
import type {XQueuedPage} from './xResearchBrowser';
import type {XScrollRecoveries,XScrollRecoveryAttempt,XTextObservation} from './xResearchTypes';

/** Reject malformed callback facts before retaining a local receipt or its diagnostic projection. */
export function isScrollReceipt(receipt:BrowserScrollReceipt|undefined):receipt is BrowserScrollReceipt {
 return !!receipt && typeof receipt.generation==='string' && receipt.generation.length>0
  && typeof receipt.written==='boolean' && typeof receipt.eventObserved==='boolean' && typeof receipt.frameObserved==='boolean'
  && ['pending','frame_observed','no_movement','invalidated','expired'].includes(receipt.state)
  && Number.isFinite(receipt.before) && Number.isFinite(receipt.after)
  && Number.isFinite(receipt.scrollHeight) && receipt.scrollHeight>=0 && Number.isFinite(receipt.clientHeight) && receipt.clientHeight>=0
  && ['document','element'].includes(receipt.targetKind) && (receipt.targetNodeId===null || Number.isSafeInteger(receipt.targetNodeId)&&receipt.targetNodeId>=0)
  && (receipt.targetContainsHit===null || typeof receipt.targetContainsHit==='boolean')
  && ['inside','equal','unknown'].includes(receipt.conversationRelation) && ['inside','equal','unknown'].includes(receipt.rootRelation);
}
/** Local native callback facts only. Serialized diagnostic projections never call this gate. */
export function isRecoverableScroll(error:unknown,receipt:BrowserScrollReceipt|undefined,written:boolean,frame:XPageObservation):boolean {
 return error instanceof BrowserScrollAcknowledgementError && error.reason==='scroll_no_movement' && written
  && isScrollReceipt(receipt) && receipt.generation===frame.snapshot.generation && receipt.written && receipt.state==='no_movement'
  && !receipt.eventObserved && !receipt.frameObserved && receipt.before===receipt.after;
}
/** Include observed identities outside the retained cap; UUID and text are deliberately absent. */
export function rememberXIdentities(seen:Set<string>,posts:XTextObservation[]):number {
 let added=0;
 for(const post of posts) if(post.postId && post.sourceUrl) {
  const key=JSON.stringify([post.postId,post.sourceUrl]);
  if(!seen.has(key)){seen.add(key);added++;}
 }
 return added;
}
const binding=(frame:XPageObservation)=>({snapshotId:frame.snapshot.snapshotId,generation:frame.snapshot.generation,
 documentEpoch:frame.location.documentEpoch,routeRevision:frame.location.routeRevision,navigationSequence:frame.location.navigationSequence,location:frame.location.current});
function check(signal?:AbortSignal):void {if(signal?.aborted)throw new KydogError('browser.cancelled','X recovery cancelled');}
function pause(signal?:AbortSignal):Promise<void>{
 check(signal);
 return new Promise((resolve,reject)=>{
  const cleanup=()=>signal?.removeEventListener('abort',abort);
  const timer=setTimeout(()=>{cleanup();resolve();},100);
  const abort=()=>{clearTimeout(timer);cleanup();reject(new KydogError('browser.cancelled','X recovery cancelled'));};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
/** One owned, read-only window. Every collection settles, including after its deadline. */
export async function recoverXScroll(page:XQueuedPage,request:XPageRequest,initial:XPageObservation,actionIndex:number,
 diagnostics:{scrollRecovery?:XScrollRecoveries},
 accept:(frame:XPageObservation)=>{outcome:'progress'|'continue'|'barrier'|'identity_unproven';newIdentityCount:number},
 signal?:AbortSignal):Promise<{frame:XPageObservation|null;outcome:XScrollRecoveryAttempt['outcome']}> {
 check(signal);
 const attempt:XScrollRecoveryAttempt={actionIndex,...binding(initial),collectCount:0,newIdentityCount:0,outcome:'failed'};
 const summary=diagnostics.scrollRecovery??={totalRecoveries:0,omittedRecoveries:0};
 summary.totalRecoveries++;summary.first??=attempt;summary.last=attempt;summary.omittedRecoveries=Math.max(0,summary.totalRecoveries-2);
 // The resource deadline is monotonic; timer scheduling never grants extra time.
 const deadlineAt=performance.now()+8000;
 const expired=()=>performance.now()>=deadlineAt;
 const sameLocation=()=>{const now=page.location();return now.currentUrl===initial.snapshot.url && now.documentEpoch===initial.location.documentEpoch && now.routeRevision===initial.location.routeRevision && now.navigationSequence===initial.location.navigationSequence;};
 try {
  for(;;){
   check(signal);
   if(expired()){attempt.outcome='expired';return{frame:null,outcome:attempt.outcome};}
   // Intentionally bypass collectFreshXPage: a new document cannot inherit this authorization.
   const frame=await collectXPage(page,request);
   attempt.collectCount++;attempt.firstCollection??=binding(frame);attempt.lastCollection=binding(frame);
   check(signal);
   const collectedAfterDeadline=expired();
   if(frame.state?.kind!=='auth_required' && (!sameLocation() || frame.snapshot.url!==initial.snapshot.url || frame.snapshot.generation!==initial.snapshot.generation
    || frame.location.documentEpoch!==initial.location.documentEpoch || frame.location.routeRevision!==initial.location.routeRevision || frame.location.navigationSequence!==initial.location.navigationSequence)) {
    attempt.outcome='identity_unproven';return{frame:null,outcome:attempt.outcome};
   }
   const accepted=accept(frame);attempt.newIdentityCount+=accepted.newIdentityCount;
   check(signal);
   if(accepted.outcome==='barrier'||accepted.outcome==='identity_unproven'){attempt.outcome=accepted.outcome;return{frame:null,outcome:attempt.outcome};}
   if(collectedAfterDeadline||expired()){attempt.outcome='expired';return{frame:null,outcome:attempt.outcome};}
   if(accepted.outcome==='progress'){attempt.outcome='progress';return{frame,outcome:attempt.outcome};}
   await pause(signal);
  }
 } catch(error){
  attempt.outcome=error instanceof KydogError&&error.code==='browser.cancelled'?'cancelled':error instanceof KydogError&&error.code==='browser.stale_snapshot'?'identity_unproven':'failed';
  throw error;
 }
}
