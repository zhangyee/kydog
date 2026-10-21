import {z} from 'zod';
import {KydogError} from '../../shared/errors';
import {logSourceDiagnostic,isSourceEvaluation,sourceEvaluationFailure,sourceEvaluationSettlement,type SourceEvaluation} from '../browser/sourceEvaluationDiagnostic';
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const codes=z.enum(['browser.page_no_result','browser.no_tab','browser.not_dispatchable','browser.cancelled','browser.stale_snapshot','browser.input_not_delivered','browser.bad_action','x.invalid_page']);
export const sourceFailureSchema=z.object({
 ownerId:id,operationId:id,tabId:id,purpose:z.enum(['x_collect','x_source_release']),
 phase:z.enum(['prepare','evaluate','decode','release']),
 cause:z.enum(['main_deadline','native_rejection','wrapper_failure','invalid_release_receipt','observed_realm_unavailable']),
 nativeSettlement:z.enum(['not_observed','resolved','rejected']),nativeSettlementObserved:z.boolean(),code:codes.optional(),
}).refine(v=>(v.nativeSettlementObserved===(v.nativeSettlement!=='not_observed'))
 && (v.purpose==='x_source_release' ? v.phase==='release' : v.phase!=='release')
 && (!['main_deadline','native_rejection'].includes(v.cause)||['evaluate','release'].includes(v.phase))
 && (v.cause!=='native_rejection'||v.nativeSettlement==='rejected')
 && (!['invalid_release_receipt','observed_realm_unavailable'].includes(v.cause)||v.phase==='release'));
export type XSourceFailure=z.infer<typeof sourceFailureSchema>;
const authentic=new WeakSet<object>();
const failures=new WeakMap<object,Readonly<XSourceFailure>>();
export function getSourceFailure(error:unknown):Readonly<XSourceFailure>|undefined {
 return error!==null&&(typeof error==='object'||typeof error==='function')?failures.get(error):undefined;
}
/** Call only at the owned adapter catch. Native cause is authenticated by operation + error identity. */
export function sourceFailureReceipt(error:unknown,context:SourceEvaluation,phase:XSourceFailure['phase'],cause:XSourceFailure['cause']='wrapper_failure'):Readonly<XSourceFailure> {
 if(!isSourceEvaluation(context))throw new Error('Unowned source operation');
 const evaluation=sourceEvaluationFailure(context,error);
 const nativeSettlement=sourceEvaluationSettlement(context);
 // A finite direct code is supplemental context, never the cause discriminator.
 const code=error instanceof KydogError?codes.safeParse(error.code):undefined;
 const receipt=Object.freeze(sourceFailureSchema.parse({...context,phase,cause,nativeSettlement,nativeSettlementObserved:nativeSettlement!=='not_observed',...(evaluation??{}),...(code?.success?{code:code.data}:{})}));
 authentic.add(receipt);
 return receipt;
}
export function retainSourceFailure(error:unknown,context:SourceEvaluation,phase:XSourceFailure['phase']):Readonly<XSourceFailure> {
 const receipt=sourceFailureReceipt(error,context,phase);
 if(error!==null&&(typeof error==='object'||typeof error==='function'))retainSourceFailureReceipt(error,receipt);
 return receipt;
}
export function logSourceCollectionFailure(error:unknown,context:SourceEvaluation,phase:XSourceFailure['phase']):void {
 try{logSourceDiagnostic('source_collection_failed',{...retainSourceFailure(error,context,phase)});}catch{/* Telemetry cannot replace original errors. */}
}

/** Transfer an authenticated receipt when the established cleanup route creates its outward error. */
export function retainSourceFailureReceipt(error:object,receipt:Readonly<XSourceFailure>):void {if(authentic.has(receipt))failures.set(error,receipt);}
