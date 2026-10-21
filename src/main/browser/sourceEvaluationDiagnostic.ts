import {randomUUID} from 'node:crypto';
import {logger} from '../log';

export interface SourceEvaluation {
 readonly ownerId:string;
 readonly operationId:string;
 readonly tabId:string;
 readonly purpose:'x_collect'|'x_source_release';
}
export type NativeSettlement='not_observed'|'resolved'|'rejected';
export interface SourceEvaluationFailure {
 cause:'main_deadline'|'native_rejection';
 nativeSettlement:NativeSettlement;
 nativeSettlementObserved:boolean;
}
interface State {nativeSettlement:NativeSettlement;afterDeadline:boolean;failure?:{error:unknown;receipt:SourceEvaluationFailure}}
const states=new WeakMap<SourceEvaluation,State>();
/** Host-only provenance. Never accept error properties or page receipts as a brand. */
export function createSourceEvaluation(ownerId:string,tabId:string,purpose:SourceEvaluation['purpose']):SourceEvaluation {
 const context=Object.freeze({ownerId,operationId:randomUUID(),tabId,purpose});
 states.set(context,{nativeSettlement:'not_observed',afterDeadline:false});return context;
}
export function isSourceEvaluation(context:SourceEvaluation):boolean {return states.has(context);}
export function sourceEvaluationFailure(context:SourceEvaluation,error:unknown):SourceEvaluationFailure|undefined {
 const failure=states.get(context)?.failure;return failure&&Object.is(failure.error,error)?{...failure.receipt}:undefined;
}
export function sourceEvaluationSettlement(context:SourceEvaluation):NativeSettlement {return states.get(context)?.nativeSettlement??'not_observed';}
/** Diagnostic observers must never turn successful work into failure, including late callbacks. */
export function logSourceDiagnostic(message:string,context:Record<string,unknown>,level:'info'|'error'='info'):void {
 try{logger[level]('x_research',message,context);}catch{/* Optional telemetry cannot affect native or wrapper semantics. */}
}
export function observeSourceDeadline(context:SourceEvaluation|undefined,error:unknown):void {
 const state=context&&states.get(context);if(!context||!state)return;
 state.afterDeadline=true;
 const receipt:SourceEvaluationFailure={cause:'main_deadline',nativeSettlement:state.nativeSettlement,nativeSettlementObserved:state.nativeSettlement!=='not_observed'};
 state.failure={error,receipt};logSourceDiagnostic('source_evaluation_failed',{...context,...receipt,phase:'evaluate'});
}
export function observeSourceNative(context:SourceEvaluation|undefined,settlement:'resolved'|'rejected',error?:unknown):void {
 const state=context&&states.get(context);if(!context||!state)return;
 state.nativeSettlement=settlement;
 if(settlement==='rejected'&&!state.afterDeadline){
  const receipt:SourceEvaluationFailure={cause:'native_rejection',nativeSettlement:'rejected',nativeSettlementObserved:true};
  state.failure={error,receipt};logSourceDiagnostic('source_evaluation_failed',{...context,...receipt,phase:'evaluate'});
 }
 if(settlement==='rejected'||state.afterDeadline)logSourceDiagnostic('source_evaluation_native_settled',{...context,nativeSettlement:settlement,afterDeadline:state.afterDeadline,phase:'native_settlement'});
}
