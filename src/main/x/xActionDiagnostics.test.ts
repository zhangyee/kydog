import {replyContinuationFixture} from '../../test-support/xReplyContinuationFixture';
import {expect,it} from 'vitest';
import {fixture,post,searchHtml,searchInput} from '../../test-support/xResearchFixture';
import {readX} from './xResearchRead';
import {KydogError} from '../../shared/errors';
import {sealPointerPreflight,isPointerPreflight,pointerPreflightSchema} from '../browser/pointerPreflightDiagnostic';
import {retainPointerFailure} from '../browser/pointerDiagnostic';
import {readHtml} from '../../test-support/xResearchFixture';
import {searchX} from './xResearchSearch';
import {serializeXResearchResult,xResearchToolResult} from './xResearchOutput';
import {X_RESEARCH_MAX_OUTPUT_BYTES} from './xResearchTypes';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {getBuiltinModel} from '@earendil-works/pi-ai/providers/all';
import {streamSimple} from '@earendil-works/pi-ai/api/openai-completions';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function result(){
 const f=fixture([searchHtml(post())]);
 f.act.mockImplementation(async(action,snapshot,options)=>{
  const ack=options!.scrollAcknowledgement!;ack.onWritten();
  ack.onReceipt?.({generation:(snapshot as import('../browser/snapshot').AxSnapshot).generation,targetKind:'document',targetNodeId:27,targetContainsHit:true,conversationRelation:'unknown',rootRelation:'unknown',before:39,after:739,scrollHeight:2800,clientHeight:701,written:true,eventObserved:true,frameObserved:true,state:'frame_observed',invalidatedReason:null});
  return {action,line:'done',navigation:null};
 });
 return searchX(searchInput,f.context);
}
async function pointerResult(){
 const f=fixture([readHtml(post()+'<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>')]);
 f.act.mockImplementation(async(action,snapshot,options)=>{
  const snap=snapshot as import('../browser/snapshot').AxSnapshot,node=snap.nodes.find(n=>n.index===action.index)!;
  (options as any)?.onPointerPreflight?.(sealPointerPreflight({phase:'collected_preflight',tabId:'research-tab',snapshotId:snap.snapshotId,generation:snap.generation,nodeId:node.nodeId,initialState:'auto',finalState:'auto',noneObserved:true,eligibilityReadsIssued:1,probeReadsIssued:1,finalizationsIssued:2,framesObserved:2,finalHitPerformed:true,outcome:'final_hit_refused',unavailableFields:[]}));
  throw retainPointerFailure(new KydogError('browser.click_intercepted','private'),{tabId:'research-tab',snapshotId:snap.snapshotId,generation:snap.generation,nodeId:node.nodeId},'pointer_validate',{
   ok:false,reason:'intercepted',pointerFailure:{point:{x:31,y:47},targetTag:'BUTTON',hitTag:'DIV',targetConnected:true,targetContainsHit:false,hitSameAsCaptured:false,
    rejectGeometry:{targetRect:{x:3,y:4,width:51,height:61},scroll:{x:0,y:0},viewport:{width:1000,height:800}},
    refusalContext:{phase:'pointer_validate',hitRect:{x:0,y:0,width:1000,height:800},relation:{hitConnected:true,hitContainsTarget:true},targetStyle:{display:'block',visibility:'visible',pointerEvents:'none',contentVisibility:'visible'},hitStyle:null}}},
   {x:31,y:47},{eligibility:{phase:'collected_eligibility',firstState:'auto',noneObserved:false,finalState:'auto',outcome:'eligible'},postFrame:{phase:'post_frame',state:'none',samplePhase:'before_first_hit',relationPhase:'first_hit',hitConnected:true,hitContainsTarget:true}});
 });
 return readX({tabId:'research-tab',read:{objective:'diagnostic',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:true,maxRepliesPerPost:5,maxScrollsPerPost:0,maxExpandActionsPerPost:1}},f.context);
}
it('projects all click provenance and optional source phases without granting evidence authority',async()=>{
 const r=structuredClone(await pointerResult()),first=r.targets[0].diagnostics!.clickFailures!.first!;
 expect(first).toMatchObject({controlKind:'replies_expand',actionIndex:1,diagnostic:{eligibility:{firstState:'auto'},postFrame:{state:'none'},rejection:{refusalContext:{phase:'pointer_validate'}}}});
 Object.assign(first,{secret:'private-click'});Object.assign(first.diagnostic,{secret:'private-click'});
 expect(JSON.stringify(r)).toContain('private-click');
 for(const objective of ['small','x'.repeat(600000)]){
  const out=serializeXResearchResult({...r,objective});
  expect(JSON.parse(out.text).targets[0].diagnostics).toEqual(out.result.targets[0].diagnostics);
  expect(out.result.targets[0].diagnostics?.clickFailures?.first?.diagnostic.postFrame?.state).toBe('none');
  expect(JSON.stringify(xResearchToolResult(out))).not.toContain('private-click');
 }
 const bad=structuredClone(r);bad.targets[0].diagnostics!.clickFailures!.first!.binding.nodeId++;
 expect(()=>serializeXResearchResult(bad)).toThrow();
});
it('projects search diagnostics identically into details and model text while stripping unknown fields',async()=>{
 const r=await result();expect(r.queries[0].diagnostics?.scroll?.first?.before).toBe(39);
 Object.assign(r.queries[0].diagnostics!.scroll!.first!,{secret:'private-secret'});
 expect(JSON.stringify(r)).toContain('private-secret');
 for(const objective of ['small','x'.repeat(600000)]){
  const out=serializeXResearchResult({...r,objective});
  expect(JSON.parse(out.text).queries[0].diagnostics).toEqual(out.result.queries[0].diagnostics);
  expect(out.result.queries[0].diagnostics?.scroll?.first?.before).toBe(39);
  expect(JSON.stringify(xResearchToolResult(out))).not.toContain('private-secret');
  expect(out.result.budgetUsage.outputBytes).toBe(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)),'utf8'));
 }
 const invalid=structuredClone(r);invalid.queries[0].diagnostics!.scroll!.omittedAttempts=7;
 expect(()=>serializeXResearchResult(invalid)).toThrow();
});
it('drops bounded search diagnostics with precise paths near the complete UTF8 envelope limit',async()=>{
 const r=await result(),small=serializeXResearchResult(r);expect(small.result.queries[0].diagnostics?.scroll).toBeDefined();
 const minimal=structuredClone(r);delete minimal.queries[0].diagnostics;
 let lo=600000,hi=X_RESEARCH_MAX_OUTPUT_BYTES;
 while(lo<hi){const mid=Math.ceil((lo+hi)/2);try{serializeXResearchResult({...minimal,objective:'x'.repeat(mid)});lo=mid;}catch{hi=mid-1;}}
 let capped:ReturnType<typeof serializeXResearchResult<typeof r>>|undefined;
 for(let margin=200;margin<=3000;margin+=200){try{const out=serializeXResearchResult({...r,objective:'x'.repeat(lo-margin)});if(out.result.metadataOmissions?.includes('queries.0.diagnostics.scroll')){capped=out;break;}}catch{ /* marker space */ }}
 expect(capped).toBeDefined();if(!capped)throw Error('cap not reached');
 expect(capped.result.queries[0].diagnostics?.scroll).toBeUndefined();expect(JSON.parse(capped.text).metadataOmissions).toContain('queries.0.diagnostics.scroll');
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
 expect(capped.result.queries[0].budgetUsage.scrolls).toBe(1);
});
it('preserves canonical diagnostics through physical SDK reopen/branch and installed provider model content',async()=>{
 const replyFixture=replyContinuationFixture();
 let reply;try{reply=await replyFixture.run();}finally{replyFixture.close();}
 for(const raw of [await result(),await pointerResult(),reply,withRecovery(await result()),withRecovery(await pointerResult()),await sourceFailureResult('read'),await sourceFailureResult('search')]){
 const payload=xResearchToolResult(serializeXResearchResult(raw));
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kydog-action-diag-'));
 try{
  const manager=SessionManager.create(dir,dir);const base=manager.appendMessage({role:'user',content:'source',timestamp:1});
  const id=manager.appendMessage({role:'toolResult',toolName:'x_research',toolCallId:'diag-call',...payload,isError:false,timestamp:2});
  manager.branch(base);manager.appendMessage({role:'assistant',content:[{type:'text',text:'sibling'}],api:'openai-completions',provider:'openai',model:'fixture',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:3});
  const reopened=SessionManager.open(manager.getSessionFile()!);reopened.branch(id);
  const saved=reopened.getBranch().at(-1)!;
  expect(saved).toMatchObject({type:'message',message:{role:'toolResult',...payload}});
  const messages:any[]=[{role:'user',content:'source',timestamp:1},{role:'assistant',content:[{type:'toolCall',id:'diag-call',name:'x_research',arguments:searchInput}],api:'openai-completions',provider:'deepseek',model:'deepseek-v4-flash',stopReason:'toolUse',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:2},(saved as any).message];
  let wire:any;
  const model=getBuiltinModel('deepseek','deepseek-v4-flash');
  const fetch:typeof globalThis.fetch=async(input,init)=>{wire=JSON.parse(await new Request(input,init).text());return new Response('data: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});};
  const stream=streamSimple(model,{messages},{apiKey:'dummy-test',fetch});for await(const _event of stream){ /* drain */ }
  const content=wire.messages.find((m:any)=>m.role==='tool').content;
  const rows=payload.details.operation==='search'?'queries':'targets';
  expect(JSON.parse(content)[rows][0].diagnostics).toEqual((payload.details as any)[rows][0].diagnostics);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
 }
});

it('retains authenticated bounded preflight through model details and rejects spoof or inconsistent binding',async()=>{
 const r=structuredClone(await pointerResult()),diag=(r.targets[0].diagnostics as any).pointerPreflights;
 expect(diag).toMatchObject({totalAttempts:1,omittedAttempts:0,first:{actionIndex:1,controlKind:'replies_expand',diagnostic:{noneObserved:true,framesObserved:2,finalHitPerformed:true,outcome:'final_hit_refused'}}});
 Object.assign(diag.first.diagnostic,{token:'private-preflight'});expect(JSON.stringify(r)).toContain('private-preflight');
 for(const objective of ['normal','x'.repeat(600000)]){
  const out=serializeXResearchResult({...r,objective});expect(JSON.parse(out.text).targets[0].diagnostics.pointerPreflights).toEqual((out.result.targets[0].diagnostics as any).pointerPreflights);
  expect(JSON.stringify(xResearchToolResult(out))).not.toContain('private-preflight');
 }
 const bad=structuredClone(r);(bad.targets[0].diagnostics as any).pointerPreflights.first.binding.nodeId++;expect(()=>serializeXResearchResult(bad)).toThrow();
 const legacy=structuredClone(r);delete (legacy.targets[0].diagnostics as any).pointerPreflights;expect((serializeXResearchResult(legacy).result.targets[0].diagnostics as any).pointerPreflights).toBeUndefined();
});

it('whole preflight summary has named UTF8 envelope omission and cannot create evidence authority',async()=>{
 const r=await pointerResult();expect((serializeXResearchResult(r).result.targets[0].diagnostics as any).pointerPreflights).toBeDefined();
 const minimal=structuredClone(r);delete minimal.targets[0].diagnostics;let lo=100000,hi=400000;
 while(lo<hi){const mid=Math.ceil((lo+hi)/2);try{serializeXResearchResult({...minimal,objective:'界'.repeat(mid)});lo=mid;}catch{hi=mid-1;}}
 let capped:ReturnType<typeof serializeXResearchResult<typeof r>>|undefined;
 for(let margin=50;margin<4000;margin+=50){try{const out=serializeXResearchResult({...r,objective:'界'.repeat(lo-margin)});if(out.result.metadataOmissions?.includes('targets.0.diagnostics.pointerPreflights')){capped=out;break;}}catch{/* marker space */}}
 expect(capped).toBeDefined();if(!capped)throw Error('omission not reached');
 expect((capped.result.targets[0].diagnostics as any)?.pointerPreflights).toBeUndefined();expect(JSON.parse(capped.text).metadataOmissions).toContain('targets.0.diagnostics.pointerPreflights');
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
});

it('preflight authentication rejects lookalike receipts and projection validates unavailable and count invariants',async()=>{
 const {preflightObserver}=await import('./xResearchReadStages');const r=await pointerResult(),row=r.targets[0],saved=row.diagnostics!.pointerPreflights!.first;
 expect(isPointerPreflight(saved.diagnostic)).toBe(true);expect(Object.isFrozen(saved.diagnostic)).toBe(true);
 const observer=preflightObserver(row,{kind:saved.controlKind,binding:saved.binding},2);observer(saved.diagnostic);
 expect(row.diagnostics!.pointerPreflights!.totalAttempts).toBe(2);
 observer({...saved.diagnostic});expect(row.diagnostics!.pointerPreflights!.totalAttempts).toBe(2);
 for(const flip of [(v:any)=>v.finalHitPerformed=false,(v:any)=>v.framesObserved=0,(v:any)=>v.finalState='none',(v:any)=>v.unavailableFields=['initialState'],(v:any)=>v.finalizationsIssued=0]){
  expect(pointerPreflightSchema.safeParse(saved.diagnostic).success).toBe(true);const bad=structuredClone(saved.diagnostic);flip(bad);expect(pointerPreflightSchema.safeParse(bad).success).toBe(false);
 }
});

it.each([
 ['eligibilityReadsIssued',0],['finalizationsIssued',2],['probeReadsIssued',1],['framesObserved',2],['initialState','unknown'],
] as const)('output projection rejects impossible preflight history after a successful same-case control: %s=%s',async(field,value)=>{
 const r=structuredClone(await pointerResult()),summary=r.targets[0].diagnostics!.pointerPreflights!;
 const diagnostic=summary.first.diagnostic;
 Object.assign(diagnostic,{initialState:'auto',finalState:'auto',noneObserved:false,eligibilityReadsIssued:1,probeReadsIssued:0,finalizationsIssued:1,framesObserved:1,finalHitPerformed:true,outcome:'final_hit_validated',unavailableFields:[]});
 summary.last=summary.first;
 for(const objective of ['normal','x'.repeat(600000)]){
  const out=serializeXResearchResult({...r,objective});
  expect(out.result.targets[0].diagnostics!.pointerPreflights!.first.diagnostic).toEqual(diagnostic);
  expect(JSON.parse(out.text).targets[0].diagnostics.pointerPreflights.first.diagnostic).toEqual(diagnostic);
  const bad=structuredClone({...r,objective}),entry=bad.targets[0].diagnostics!.pointerPreflights!;
  expect(entry.first).toBe(entry.last); // The aggregate stays consistent; only this source field changes.
  Object.assign(entry.first.diagnostic,{[field]:value});
  expect(()=>serializeXResearchResult(bad)).toThrow();
 }
});
it('projection preserves zero-read early invalidation and nullable lost finalization facts',async()=>{
 const r=structuredClone(await pointerResult()),summary=r.targets[0].diagnostics!.pointerPreflights!;
 for(const variant of [
  {initialState:null,finalState:null,noneObserved:false,eligibilityReadsIssued:0,probeReadsIssued:0,finalizationsIssued:0,framesObserved:0,finalHitPerformed:null,outcome:'invalidated',unavailableFields:['initialState','finalState','finalHitPerformed']},
  {initialState:'auto',finalState:null,noneObserved:false,eligibilityReadsIssued:1,probeReadsIssued:0,finalizationsIssued:1,framesObserved:1,finalHitPerformed:null,outcome:'unknown',unavailableFields:['finalState','finalHitPerformed']},
 ]){
  Object.assign(summary.first.diagnostic,variant);summary.last=summary.first;
  for(const objective of ['normal','x'.repeat(600000)]){
   const out=serializeXResearchResult({...r,objective});expect(out.result.targets[0].diagnostics!.pointerPreflights!.first.diagnostic).toMatchObject(variant);
   expect(JSON.parse(out.text).targets[0].diagnostics.pointerPreflights.first.diagnostic).toMatchObject(variant);
  }
 }
});
function withRecovery<T extends import('./xResearchTypes').XResearchResult>(r:T):T {
 const row=r.operation==='search'?r.queries[0]:r.targets[0];
 const source=r.operation==='search'?r.queries[0].diagnostics!.scroll!.first!:r.targets[0].diagnostics!.initialFrame!;
 const generation='generation'in source?source.generation:source.document.generation;
 const binding={snapshotId:source.snapshotId,generation,documentEpoch:3,routeRevision:7,navigationSequence:9,location:source.location};
 const attempt={...binding,actionIndex:1,collectCount:2,newIdentityCount:1,outcome:'progress' as const,firstCollection:{...binding,snapshotId:'recovery_first'},lastCollection:{...binding,snapshotId:'recovery_last'}};
 row.diagnostics!.scrollRecovery={totalRecoveries:1,omittedRecoveries:0,first:attempt,last:attempt};return r;
}
it('projects finite recovery diagnostics with strict invariants into content/details and strips raw private fields',async()=>{
 for(const raw of [withRecovery(await result()),withRecovery(await pointerResult())]){
  const row=raw.operation==='search'?raw.queries[0]:raw.targets[0];
  const summary=row.diagnostics!.scrollRecovery!;Object.assign(summary.first!,{token:'private-recovery',dom:'private-recovery'});Object.assign(summary.first!.lastCollection!,{debug:'private-recovery'});
  expect(JSON.stringify(raw)).toContain('private-recovery');
  const good=serializeXResearchResult(raw),rows=good.result.operation==='search'?'queries':'targets';
  expect((JSON.parse(good.text)[rows][0].diagnostics.scrollRecovery)).toEqual((good.result as any)[rows][0].diagnostics.scrollRecovery);
  expect(JSON.stringify(xResearchToolResult(good))).not.toContain('private-recovery');
  for(const mutate of [(v:any)=>v.omittedRecoveries=1,(v:any)=>v.first.collectCount=0,(v:any)=>v.first.newIdentityCount=-1,(v:any)=>v.first.outcome='complete',(v:any)=>v.first.lastCollection.generation='other',(v:any)=>v.first.lastCollection.routeRevision++]){
   const bad=structuredClone(raw),entry=bad.operation==='search'?bad.queries[0]:bad.targets[0];mutate(entry.diagnostics!.scrollRecovery);expect(()=>serializeXResearchResult(bad)).toThrow();
  }
 }
});
it('names recovery omissions precisely under the complete one MiB UTF8 tool envelope',async()=>{
 for(const raw of [withRecovery(await result()),withRecovery(await pointerResult())]){
  const rows=raw.operation==='search'?'queries':'targets',path=`${rows}.0.diagnostics.scrollRecovery`;
  expect((serializeXResearchResult(raw).result as any)[rows][0].diagnostics.scrollRecovery).toBeDefined();
  const minimal=structuredClone(raw);delete (minimal as any)[rows][0].diagnostics;let lo=100000,hi=400000;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);try{serializeXResearchResult({...minimal,objective:'界'.repeat(mid)});lo=mid;}catch{hi=mid-1;}}
  let capped:ReturnType<typeof serializeXResearchResult>|undefined;
  for(let margin=50;margin<6000;margin+=50){try{const out=serializeXResearchResult({...raw,objective:'界'.repeat(lo-margin)});if(out.result.metadataOmissions?.includes(path)){capped=out;break;}}catch{/* marker space */}}
  expect(capped).toBeDefined();if(!capped)throw Error('recovery omission not reached');
  expect((capped.result as any)[rows][0].diagnostics.scrollRecovery).toBeUndefined();expect(JSON.parse(capped.text).metadataOmissions).toContain(path);
  const bytes=Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)),'utf8');expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);expect(capped.result.budgetUsage.outputBytes).toBe(bytes);
 }
});
it('projects expiry before the first issued recovery collection as unobserved, never checked-empty',async()=>{
 const raw=withRecovery(await result()),summary=raw.queries[0].diagnostics!.scrollRecovery!;
 expect(serializeXResearchResult(raw).result.queries[0].diagnostics!.scrollRecovery!.first!.collectCount).toBe(2);
 Object.assign(summary.first!,{collectCount:0,newIdentityCount:0,outcome:'expired'});
 delete summary.first!.firstCollection;delete summary.first!.lastCollection;
 const out=serializeXResearchResult(raw),saved=out.result.queries[0].diagnostics!.scrollRecovery!.first!;
 expect(saved).toMatchObject({collectCount:0,newIdentityCount:0,outcome:'expired'});
 expect(saved.firstCollection).toBeUndefined();expect(saved.lastCollection).toBeUndefined();
 summary.first!.newIdentityCount=1;expect(()=>serializeXResearchResult(raw)).toThrow();
});

it('projects source failure strictly, rejects illegal phases, and preserves legacy absence',async()=>{
 const raw=await result();
 const sourceFailure={ownerId:'owner',operationId:'operation',tabId:'tab',purpose:'x_collect' as const,phase:'evaluate' as const,cause:'main_deadline' as const,nativeSettlement:'not_observed' as const,nativeSettlementObserved:false};
 raw.queries[0].diagnostics={version:1,sourceFailure:{...sourceFailure,secret:'SECRET'} as never};
 const out=serializeXResearchResult(raw);
 expect(out.result.queries[0].diagnostics?.sourceFailure).toEqual(sourceFailure);
 expect(JSON.parse(out.text).queries[0].diagnostics.sourceFailure).toEqual(sourceFailure);
 expect(JSON.stringify(xResearchToolResult(out))).not.toContain('SECRET');
 for(const mutation of [{phase:'decode'},{purpose:'x_source_release'},{cause:'native_rejection'},{nativeSettlementObserved:true},{cause:'invalid_release_receipt'},{code:'SECRET_CODE'},{operationId:'https://secret'}]){
  raw.queries[0].diagnostics.sourceFailure={...sourceFailure,...mutation} as never;
  expect(()=>serializeXResearchResult(raw)).toThrow();
 }
 delete raw.queries[0].diagnostics.sourceFailure;
 expect(serializeXResearchResult(raw).result.queries[0].diagnostics?.sourceFailure).toBeUndefined();
});

async function sourceFailureResult(operation:'search'|'read'){
 const {createSourceEvaluation,observeSourceNative}=await import('../browser/sourceEvaluationDiagnostic');
 const {retainSourceFailure}=await import('./xSourceDiagnostics');
 const f=fixture([readHtml(post())]),error=Error('PRIVATE_NATIVE_ERROR');
 const context=createSourceEvaluation('owner','research-tab','x_collect');
 observeSourceNative(context,'rejected',error);retainSourceFailure(error,context,'evaluate');
 f.collect.mockRejectedValue(error);
 // The fake queued port forwards the actual host-authenticated error unchanged.
 return operation==='search'?searchX(searchInput,f.context):readX({tabId:'research-tab',read:{objective:'failure',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},f.context);
}
it.each(['read','search'] as const)('retains authenticated %s source failures without initial frames, ignores error property spoof',async operation=>{
 const r=await sourceFailureResult(operation);
 const row=r.operation==='read'?r.targets[0]:r.queries[0];
 expect(row.diagnostics?.sourceFailure).toMatchObject({ownerId:'owner',tabId:'research-tab',purpose:'x_collect',phase:'evaluate',cause:'native_rejection',nativeSettlement:'rejected'});
 for(const objective of ['normal','x'.repeat(600000)]){
  const out=serializeXResearchResult({...r,objective});
  const key=r.operation==='read'?'targets':'queries';
  expect(JSON.parse(out.text)[key][0].diagnostics.sourceFailure).toEqual(row.diagnostics!.sourceFailure);
  expect(JSON.stringify(xResearchToolResult(out))).not.toContain('PRIVATE_NATIVE_ERROR');
 }
 const f=fixture([readHtml(post())]);f.collect.mockRejectedValue(Object.assign(Error('fake'),{sourceFailure:row.diagnostics!.sourceFailure}));
 const spoof=operation==='search'?await searchX(searchInput,f.context):await readX({tabId:'research-tab',read:{objective:'failure',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},f.context);
 expect((spoof.operation==='read'?spoof.targets[0]:spoof.queries[0]).diagnostics?.sourceFailure).toBeUndefined();
});
it.each(['read','search'] as const)('sourceFailure %s omission is exact under the complete UTF8 one MiB SDK envelope',async operation=>{
 const raw=await sourceFailureResult(operation),key=raw.operation==='read'?'targets':'queries';
 const row=raw.operation==='read'?raw.targets[0]:raw.queries[0];
 expect(row.diagnostics?.sourceFailure).toBeDefined();
 const minimal=structuredClone(raw);delete (minimal.operation==='read'?minimal.targets[0]:minimal.queries[0]).diagnostics;
 let lo=600000,hi=X_RESEARCH_MAX_OUTPUT_BYTES;
 while(lo<hi){const mid=Math.ceil((lo+hi)/2);try{serializeXResearchResult({...minimal,objective:'x'.repeat(mid)});lo=mid;}catch{hi=mid-1;}}
 let capped:ReturnType<typeof serializeXResearchResult>|undefined;
 for(let margin=50;margin<=2000;margin+=50){try{const out=serializeXResearchResult({...raw,objective:'x'.repeat(lo-margin)});if(out.result.metadataOmissions?.includes(`${key}.0.diagnostics.sourceFailure`)){capped=out;break;}}catch{/* marker space */}}
 expect(capped).toBeDefined();if(!capped)throw Error('source omission not reached');
 expect(JSON.parse(capped.text).metadataOmissions).toContain(`${key}.0.diagnostics.sourceFailure`);
 expect((capped.result.operation==='read'?capped.result.targets[0]:capped.result.queries[0]).diagnostics?.sourceFailure).toBeUndefined();
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
});
