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
const search=z.object({version:z.literal(1),scroll:scroll.optional()});
const relation=z.enum(['same_cell','focal_contains_control','control_contains_focal','different_cell','unknown']);
const diagnostic=z.unknown().transform(projectPointerDiagnostic);
const click=z.object({actionIndex:count.positive(),targetPostId:z.string().regex(/^\d+$/),controlKind:z.enum(['body_expand','article_entry','replies_expand']),binding:z.object({index:count,nodeId:count,snapshotId:id,generation:id}),sourceRelation:relation,diagnostic}).refine(v=>v.binding.snapshotId===v.diagnostic.snapshotId&&v.binding.generation===v.diagnostic.generation&&v.binding.nodeId===v.diagnostic.nodeId);
const failures=z.object({totalFailures:count,first:click.optional(),last:click.optional(),omittedFailures:count}).refine(v=>v.omittedFailures===v.totalFailures-new Set([v.first?.actionIndex,v.last?.actionIndex].filter(i=>i!==undefined)).size && (!v.first||!v.last||v.first.actionIndex<=v.last.actionIndex));
const legacy=z.object({actionIndex:count.positive(),targetPostId:z.string().regex(/^\d+$/),controlKind:z.literal('replies_expand'),sourceRelation:relation,diagnostic});
/** Project new diagnostics before cloning. Telemetry never enters the evidence authority decoder. */
export function projectActionDiagnostics<T extends XResearchResult>(value:T):T {
 if(value.operation==='search')return {...value,queries:value.queries.map(row=>({...row,...(row.diagnostics?{diagnostics:search.parse(row.diagnostics)}:{})}))};
 return {...value,targets:value.targets.map(row=>({...row,...(row.diagnostics?{diagnostics:{...row.diagnostics,
  ...(row.diagnostics.clickFailures?{clickFailures:failures.parse(row.diagnostics.clickFailures)}:{}),
  ...(row.diagnostics.pointerFailure?{pointerFailure:legacy.parse(row.diagnostics.pointerFailure)}:{}),
 }}:{})}))};
}
