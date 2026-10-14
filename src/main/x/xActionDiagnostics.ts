import {pointerPreflightSchema} from '../browser/pointerPreflightDiagnostic';
import {replyExpansionsSchema} from './xReplyExpansionDiagnostics';
import {z} from 'zod';
import {projectPointerDiagnostic} from '../browser/pointerDiagnostic';
import type {XResearchResult} from './xResearchTypes';
const count=z.number().int().nonnegative().safe();
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const safe=z.object({origin:z.string().max(256).nullable(),path:z.string().max(16384).nullable(),q:z.string().max(16384).nullable(),f:z.string().max(256).nullable(),fragment:z.string().max(16384).nullable(),redacted:z.boolean()});
const receipt=z.object({actionIndex:count.positive(),snapshotId:id,generation:id,location:safe,targetKind:z.enum(['document','element']),targetNodeId:count.nullable(),targetContainsHit:z.boolean().nullable(),conversationRelation:z.enum(['inside','equal','unknown']),rootRelation:z.enum(['inside','equal','unknown']),before:z.number().finite(),after:z.number().finite(),scrollHeight:z.number().finite().nonnegative(),clientHeight:z.number().finite().nonnegative(),written:z.boolean(),eventObserved:z.boolean(),frameObserved:z.boolean(),state:z.enum(['pending','frame_observed','no_movement','invalidated','expired'])});
const scroll=z.object({totalAttempts:count,first:receipt.optional(),last:receipt.optional(),omittedAttempts:count}).refine(v=>{
 const retained=[v.first,v.last].filter(v=>!!v);
 return v.omittedAttempts===v.totalAttempts-new Set(retained.map(v=>v.actionIndex)).size
  && retained.every(r=>r.actionIndex<=v.totalAttempts) && (!v.first||!v.last||v.first.actionIndex<=v.last.actionIndex);
});
const recoveryBinding=z.object({snapshotId:id,generation:id,documentEpoch:count,routeRevision:count,navigationSequence:count,location:safe});
const recoveryAttempt=recoveryBinding.extend({actionIndex:count.positive(),collectCount:count,newIdentityCount:count,
 outcome:z.enum(['progress','expired','barrier','identity_unproven','cancelled','failed']),firstCollection:recoveryBinding.optional(),lastCollection:recoveryBinding.optional()}).refine(v=>{
 const frames=[v.firstCollection,v.lastCollection];
 if(v.collectCount===0)return frames.every(f=>!f)&&v.newIdentityCount===0&&v.outcome!=='progress';
 if(frames.some(f=>!f))return false;
 if(v.collectCount===1 && JSON.stringify(v.firstCollection)!==JSON.stringify(v.lastCollection))return false;
 return !['progress','expired'].includes(v.outcome)||frames.every(f=>f!.generation===v.generation&&f!.documentEpoch===v.documentEpoch&&f!.routeRevision===v.routeRevision&&f!.navigationSequence===v.navigationSequence&&JSON.stringify(f!.location)===JSON.stringify(v.location));
});
const recoveries=z.object({totalRecoveries:count.positive(),omittedRecoveries:count,first:recoveryAttempt,last:recoveryAttempt}).refine(v=>v.omittedRecoveries===Math.max(0,v.totalRecoveries-2)
 && v.last.actionIndex-v.first.actionIndex>=v.totalRecoveries-1 && (v.totalRecoveries!==1||JSON.stringify(v.first)===JSON.stringify(v.last)));
const search=z.object({version:z.literal(1),scroll:scroll.optional(),scrollRecovery:recoveries.optional()});
const relation=z.enum(['same_cell','focal_contains_control','control_contains_focal','different_cell','unknown']);
const diagnostic=z.unknown().transform(projectPointerDiagnostic);
const click=z.object({actionIndex:count.positive(),targetPostId:z.string().regex(/^\d+$/),controlKind:z.enum(['body_expand','article_entry','replies_expand']),binding:z.object({index:count,nodeId:count,snapshotId:id,generation:id}),sourceRelation:relation,diagnostic}).refine(v=>v.binding.snapshotId===v.diagnostic.snapshotId&&v.binding.generation===v.diagnostic.generation&&v.binding.nodeId===v.diagnostic.nodeId);
const failures=z.object({totalFailures:count,first:click.optional(),last:click.optional(),omittedFailures:count}).refine(v=>v.omittedFailures===v.totalFailures-new Set([v.first?.actionIndex,v.last?.actionIndex].filter(i=>i!==undefined)).size && (!v.first||!v.last||v.first.actionIndex<=v.last.actionIndex));
const preflight=z.object({actionIndex:count.positive(),targetPostId:z.string().regex(/^\d+$/),controlKind:z.enum(['body_expand','article_entry','replies_expand']),binding:z.object({index:count,nodeId:count,snapshotId:id,generation:id}),diagnostic:pointerPreflightSchema}).refine(v=>v.binding.snapshotId===v.diagnostic.snapshotId&&v.binding.generation===v.diagnostic.generation&&v.binding.nodeId===v.diagnostic.nodeId);
const preflights=z.object({totalAttempts:count.positive(),omittedAttempts:count,first:preflight,last:preflight}).refine(v=>v.omittedAttempts===Math.max(0,v.totalAttempts-2)&&v.last.actionIndex-v.first.actionIndex>=v.totalAttempts-1&&v.first.targetPostId===v.last.targetPostId&&(v.totalAttempts!==1||JSON.stringify(v.first)===JSON.stringify(v.last)));
const legacy=z.object({actionIndex:count.positive(),targetPostId:z.string().regex(/^\d+$/),controlKind:z.literal('replies_expand'),sourceRelation:relation,diagnostic});
/** Project new diagnostics before cloning. Telemetry never enters the evidence authority decoder. */
export function projectActionDiagnostics<T extends XResearchResult>(value:T):T {
 if(value.operation==='search')return {...value,queries:value.queries.map(row=>({...row,...(row.diagnostics?{diagnostics:search.parse(row.diagnostics)}:{})}))};
 return {...value,targets:value.targets.map(row=>({...row,...(row.diagnostics?{diagnostics:{...row.diagnostics,
  ...(row.diagnostics.scrollRecovery?{scrollRecovery:recoveries.parse(row.diagnostics.scrollRecovery)}:{}),
  ...(row.diagnostics.pointerPreflights?{pointerPreflights:preflights.parse(row.diagnostics.pointerPreflights)}:{}),
  ...(row.diagnostics.replyExpansions?{replyExpansions:replyExpansionsSchema.parse(row.diagnostics.replyExpansions)}:{}),
  ...(row.diagnostics.clickFailures?{clickFailures:failures.parse(row.diagnostics.clickFailures)}:{}),
  ...(row.diagnostics.pointerFailure?{pointerFailure:legacy.parse(row.diagnostics.pointerFailure)}:{}),
 }}:{})}))};
}
