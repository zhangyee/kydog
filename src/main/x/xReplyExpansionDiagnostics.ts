import {z} from 'zod';
import {parseXSourcePost,parseXPostCoordinates,isXPostId} from './xResearchIdentity';
import type {XPageControl,XPageObservation} from './xObservation';
import type {XReadObservation,XReadRequest,XReplyCollectionDiagnostic,XReplyExpansionAttempt} from './xResearchTypes';

const count=z.number().int().nonnegative().safe();
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const binding=z.object({index:count,nodeId:count,snapshotId:id,generation:id});
const safe=z.object({origin:z.enum(['https://x.com','https://twitter.com']).nullable(),path:z.string().max(8192).nullable(),q:z.string().max(8192).nullable(),f:z.string().max(8192).nullable(),fragment:z.null(),redacted:z.boolean()}).refine(v=>{
  if(v.origin===null)return v.path===null&&v.q===null&&v.f===null&&v.redacted;
  if(v.path===null)return v.q===null&&v.f===null&&v.redacted;
  return v.path==='/search'||(v.q===null&&v.f===null&&!!parseXPostCoordinates(v.origin+v.path,{allowMedia:true}));
});
const item=z.object({postId:z.string().refine(isXPostId),sourceUrl:z.string().max(16384)}).refine(v=>parseXSourcePost(v.sourceUrl)?.id===v.postId);
const inventory=z.union([z.object({state:z.literal('unavailable')}),z.object({state:z.literal('captured'),items:z.array(item).max(100),total:count,returned:count.max(100),omitted:count}).refine(v=>v.returned===v.items.length && v.returned===Math.min(100,v.total) && v.omitted===v.total-v.returned)]);
const frame=z.union([z.object({state:z.enum(['not_observed','unavailable'])}),z.object({state:z.literal('captured'),snapshotId:id,generation:id,location:safe,sourceAvailable:z.boolean(),replyControlCount:count,inventory}).refine(v=>v.sourceAvailable===(v.inventory.state==='captured'))]);
const usage=z.object({replies:count,scrolls:count,expansions:count});
const sameBinding=(a:z.infer<typeof binding>,b:z.infer<typeof binding>)=>a.index===b.index&&a.nodeId===b.nodeId&&a.snapshotId===b.snapshotId&&a.generation===b.generation;
const attempt=z.object({actionIndex:count.positive(),targetPostId:z.string().refine(isXPostId),binding,
  admission:z.union([z.object({state:z.literal('unavailable')}),z.object({state:z.literal('consumed'),purpose:z.literal('replies_expand'),binding})]),
  outcome:z.enum(['succeeded','failed','cancelled']),caps:z.object({replies:count.max(100),scrolls:count.max(20),expansions:count.max(20)}),usageBefore:usage,usageAfter:usage,before:frame,after:frame,
}).refine(v=>{
  if(v.admission.state==='consumed'&&!sameBinding(v.binding,v.admission.binding))return false;
  if(v.before.state==='captured'&&(v.before.snapshotId!==v.binding.snapshotId||v.before.generation!==v.binding.generation))return false;
  if(v.before.state==='not_observed')return false;
  if(v.outcome!=='succeeded'&&v.after.state!=='not_observed')return false;
  return v.usageBefore.expansions<v.caps.expansions && v.usageBefore.replies<v.caps.replies
    && v.usageAfter.expansions===v.usageBefore.expansions+(v.outcome==='succeeded'?1:0)
    && v.usageAfter.scrolls===v.usageBefore.scrolls && v.usageAfter.replies===v.usageBefore.replies
    && v.usageBefore.scrolls<=v.caps.scrolls;
});
/** Strip all non-allowlisted data before cloning; this parser grants no authority. */
export const replyExpansionsSchema=z.object({totalAttempts:count.positive(),omittedAttempts:count,first:attempt,last:attempt}).refine(v=>{
  const unique=v.first.actionIndex===v.last.actionIndex?1:2;
  return v.omittedAttempts===v.totalAttempts-unique && v.last.actionIndex-v.first.actionIndex>=v.totalAttempts-1
    && v.last.targetPostId===v.first.targetPostId && JSON.stringify(v.last.caps)===JSON.stringify(v.first.caps)
    && v.last.usageBefore.expansions-v.first.usageBefore.expansions===v.totalAttempts-1
    && v.totalAttempts<=v.first.caps.expansions-v.first.usageBefore.expansions
    && (v.totalAttempts===1 ? JSON.stringify(v.first)===JSON.stringify(v.last) : v.first.actionIndex<v.last.actionIndex);
});
/** Diagnostic failures never affect input, collection, cancellation or budget accounting. */
export function observeReplyDiagnostic(work:()=>void):void {try{work();}catch{/* Optional observation only. */}}
export function replyUsage(row:XReadObservation):XReplyExpansionAttempt['usageBefore'] {
  return {replies:row.replies.observations.length,scrolls:row.budgetUsage.scrolls,expansions:row.budgetUsage.expandActions};
}
export function replyCollection(observed:XPageObservation):XReplyCollectionDiagnostic {
  const sourceAvailable=observed.identityProven&&!!observed.root;
  const items=observed.replies.flatMap(p=>p.postId&&p.sourceUrl?[{postId:p.postId,sourceUrl:p.sourceUrl}]:[]);
  return {state:'captured',snapshotId:observed.snapshot.snapshotId,generation:observed.snapshot.generation,location:{...observed.location.current},sourceAvailable,
    replyControlCount:observed.controls.filter(c=>c.kind==='replies_expand').length,
    inventory:sourceAvailable?{state:'captured',items:items.slice(0,100),total:items.length,returned:Math.min(items.length,100),omitted:Math.max(0,items.length-100)}:{state:'unavailable'}};
}
export function beginReplyExpansion(row:XReadObservation,observed:XPageObservation,control:XPageControl,limits:XReadRequest,actionIndex:number):XReplyExpansionAttempt|undefined {
  let value:XReplyExpansionAttempt|undefined;
  observeReplyDiagnostic(()=>{
    value={actionIndex,targetPostId:row.postId!,binding:{...control.binding},admission:{state:'unavailable'},outcome:'failed',
      caps:{replies:limits.maxRepliesPerPost,scrolls:limits.maxScrollsPerPost,expansions:limits.maxExpandActionsPerPost},usageBefore:replyUsage(row),usageAfter:replyUsage(row),before:replyCollection(observed),after:{state:'not_observed'}};
    const diagnostics=(row.diagnostics??={version:1}).replyExpansions??={totalAttempts:0,omittedAttempts:0};
    diagnostics.totalAttempts++;diagnostics.first??=value;diagnostics.last=value;diagnostics.omittedAttempts=Math.max(0,diagnostics.totalAttempts-2);
  });
  return value;
}
