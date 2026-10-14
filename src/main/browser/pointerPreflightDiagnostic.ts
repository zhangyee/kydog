import {z} from 'zod';
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),count=z.number().int().nonnegative().safe();
const state=z.enum(['auto','none','unknown']).nullable();
export const pointerPreflightSchema=z.object({
 tabId:id,snapshotId:id,generation:id,nodeId:count,phase:z.literal('collected_preflight'),
 initialState:state,finalState:state,noneObserved:z.boolean(),
 eligibilityReadsIssued:count,probeReadsIssued:count,finalizationsIssued:count,framesObserved:count,
 finalHitPerformed:z.boolean().nullable(),
 outcome:z.enum(['final_hit_validated','final_hit_refused','permission_lost','invalidated','cancelled','expired','unknown','frame_failed']),
 unavailableFields:z.array(z.enum(['initialState','finalState','finalHitPerformed'])).max(3),
}).refine(v=>{
 const missing=(['initialState','finalState','finalHitPerformed'] as const).filter(k=>v[k]===null);
 return JSON.stringify(missing)===JSON.stringify(v.unavailableFields)
  && (!(v.initialState==='none'||v.finalState==='none')||v.noneObserved)
  && (!['final_hit_validated','final_hit_refused'].includes(v.outcome)||(v.finalHitPerformed===true&&v.finalState==='auto'&&v.finalizationsIssued>0&&v.framesObserved>0))
  && (v.finalHitPerformed!==true||v.finalizationsIssued>0);
});
export type PointerPreflightDiagnostic=z.infer<typeof pointerPreflightSchema>;
const authentic=new WeakSet<object>();
/** Trusted main-process producer only. This receipt describes preflight, never input delivery. */
export function sealPointerPreflight(value:PointerPreflightDiagnostic):Readonly<PointerPreflightDiagnostic>{
 const receipt=pointerPreflightSchema.parse(value);Object.freeze(receipt.unavailableFields);Object.freeze(receipt);authentic.add(receipt);return receipt;
}
export function isPointerPreflight(value:unknown):value is Readonly<PointerPreflightDiagnostic>{return !!value&&typeof value==='object'&&authentic.has(value);}
