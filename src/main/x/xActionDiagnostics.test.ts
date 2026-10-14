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
  ack.onReceipt?.({generation:(snapshot as import('../browser/snapshot').AxSnapshot).generation,targetKind:'document',targetNodeId:27,targetContainsHit:true,conversationRelation:'unknown',rootRelation:'unknown',before:39,after:739,scrollHeight:2800,clientHeight:701,written:true,eventObserved:true,frameObserved:true,state:'frame_observed'});
  return {action,line:'done',navigation:null};
 });
 return searchX(searchInput,f.context);
}
async function pointerResult(){
 const f=fixture([readHtml(post().replace('</article>','<button role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button></article>'))]);
 f.act.mockImplementation(async(action,snapshot,options)=>{
  const snap=snapshot as import('../browser/snapshot').AxSnapshot,node=snap.nodes.find(n=>n.index===action.index)!;
  (options as any)?.onPointerPreflight?.(sealPointerPreflight({phase:'collected_preflight',tabId:'research-tab',snapshotId:snap.snapshotId,generation:snap.generation,nodeId:node.nodeId,initialState:'auto',finalState:'auto',noneObserved:true,eligibilityReadsIssued:1,probeReadsIssued:1,finalizationsIssued:2,framesObserved:2,finalHitPerformed:true,outcome:'final_hit_refused',unavailableFields:[]}));
  throw retainPointerFailure(new KydogError('browser.click_intercepted','private'),{tabId:'research-tab',snapshotId:snap.snapshotId,generation:snap.generation,nodeId:node.nodeId},'pointer_validate',{
   ok:false,reason:'intercepted',pointerFailure:{point:{x:31,y:47},targetTag:'BUTTON',hitTag:'DIV',targetConnected:true,targetContainsHit:false,hitSameAsCaptured:false,
    rejectGeometry:{targetRect:{x:3,y:4,width:51,height:61},scroll:{x:0,y:0},viewport:{width:1000,height:800}},
    refusalContext:{phase:'pointer_validate',hitRect:{x:0,y:0,width:1000,height:800},relation:{hitConnected:true,hitContainsTarget:true},targetStyle:{display:'block',visibility:'visible',pointerEvents:'none',contentVisibility:'visible'},hitStyle:null}}},
   {x:31,y:47},{eligibility:{phase:'collected_eligibility',firstState:'auto',noneObserved:false,finalState:'auto',outcome:'eligible'},postFrame:{phase:'post_frame',state:'none',samplePhase:'before_first_hit',relationPhase:'first_hit',hitConnected:true,hitContainsTarget:true}});
 });
 return readX({tabId:'research-tab',read:{objective:'diagnostic',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:1}},f.context);
}
it('projects all click provenance and optional source phases without granting evidence authority',async()=>{
 const r=structuredClone(await pointerResult()),first=r.targets[0].diagnostics!.clickFailures!.first!;
 expect(first).toMatchObject({controlKind:'body_expand',actionIndex:1,diagnostic:{eligibility:{firstState:'auto'},postFrame:{state:'none'},rejection:{refusalContext:{phase:'pointer_validate'}}}});
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
 for(const raw of [await result(),await pointerResult(),reply]){
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
 expect(diag).toMatchObject({totalAttempts:1,omittedAttempts:0,first:{actionIndex:1,controlKind:'body_expand',diagnostic:{noneObserved:true,framesObserved:2,finalHitPerformed:true,outcome:'final_hit_refused'}}});
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
