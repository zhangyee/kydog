import { expect, it } from 'vitest';
import { fixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { searchResult } from './xResearchSearch';
import { readResult, readX } from './xResearchRead';
import { XResearchScopeLedger } from './xResearchScopeFacts';
import { serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
import { X_RESEARCH_MAX_OUTPUT_BYTES, type XResearchResult } from './xResearchTypes';

function search(callId='search-one',runId='scope-run',count=1) {
 const input=structuredClone(searchInput);input.search.queries=Array.from({length:count},(_,i)=>({...input.search.queries[0],id:'q'+i}));
 const result=searchResult(input,{...fixture([searchHtml(post())]).context,callId,runId,batchId:'batch-'+callId});
 result.queries.forEach(row=>Object.assign(row,{status:'partial',stopReason:'budget_reached'}));
 return result;
}
function read(callId='read-one',runId='scope-run',count=1) {
 const result=readResult({tabId:'tab',read:{objective:'read',targets:Array.from({length:count},(_,i)=>({postId:String(i+100)})),includeArticle:false,includeReplies:true,maxRepliesPerPost:30,maxScrollsPerPost:6,maxExpandActionsPerPost:6}},
 {...fixture([readHtml(post())]).context,callId,runId,batchId:'batch-'+callId});
 result.targets.forEach(row=>Object.assign(row,{status:'partial',stopReason:'identity_unproven',reason:'post_identity_unproven'}));return result;
}
const envelope=(details:unknown,toolCallId:string)=>({type:'message',message:{role:'toolResult',toolName:'x_research',toolCallId,isError:false,details}});

// Catches counting latest batch alone, merging operations, or trusting caller summaries.
it('adds the exact 4+2 budget search rows, two empty and one failed, separately from six partial reads',()=>{
 const ledger=new XResearchScopeLedger(),a=search('a','scope-run',6),b=search('b','scope-run',3),r=read('r','scope-run',6);
 a.queries.slice(4).forEach(row=>Object.assign(row,{status:'explicit_empty',stopReason:'explicit_ui_end'}));
 Object.assign(b.queries[2],{status:'failed',stopReason:'action_failed',barrier:{status:'failed',reason:'scroll_no_movement',observationId:null}});
 a.reportScopeFacts={version:1,operation:'search',reasonSource:'barrier.reason',totalRows:900,statusCounts:{},stopReasonCounts:{},reasonCounts:{},replyScopeCounts:{}};
 ledger.observe(a);ledger.observe(b);ledger.observe(r);
 const actual=ledger.prior('scope-run').withCurrent(r);
 expect(actual).toEqual({version:1,runId:'scope-run',callCount:3,unavailableCallCount:0,
 search:{version:1,operation:'search',reasonSource:'barrier.reason',totalRows:9,statusCounts:{partial:6,explicit_empty:2,failed:1},stopReasonCounts:{budget_reached:6,explicit_ui_end:2,action_failed:1},reasonCounts:{unknown:8,scroll_no_movement:1},replyScopeCounts:{}},
 read:{version:1,operation:'read',reasonSource:'reason',totalRows:6,statusCounts:{partial:6},stopReasonCounts:{identity_unproven:6},reasonCounts:{post_identity_unproven:6},replyScopeCounts:{unknown:6}}});
 const unknown=read('unknown');unknown.targets[0].reason='localized unsupported speculation';ledger.observe(unknown);
 expect(ledger.prior('scope-run').withCurrent(r).read.reasonCounts).toEqual({post_identity_unproven:6,unknown:1});
});

// Catches totals-only dedupe, accidental ID reuse, and conflict recovery by last writer.
it('deduplicates exact scope rows and marks changed row identity/order/status/reason or operation unavailable once',()=>{
 const original=search('same','scope-run',2),current=read('current');
 const mutations:Array<(v:typeof original)=>void>=[
 v=>{v.queries[0].status='observed';},v=>{v.queries[0].stopReason='wait_timeout';},
 v=>{v.queries[0].barrier={status:'failed',reason:'different unknown',observationId:null};},
 v=>{v.queries.reverse();},v=>{v.queries[0].query.id='other';},v=>{v.batchId='different-batch';},
 ];
 for(const mutate of mutations){
 const ledger=new XResearchScopeLedger();ledger.observe(original);ledger.observe(structuredClone(original));
 expect(ledger.prior('scope-run').withCurrent(current)).toMatchObject({callCount:2,unavailableCallCount:0,search:{totalRows:2}});
 const changed=structuredClone(original);mutate(changed);ledger.observe(changed);ledger.observe(original);
 expect(ledger.prior('scope-run').withCurrent(current)).toMatchObject({callCount:1,unavailableCallCount:1,search:{totalRows:0},read:{totalRows:1}});
 }
 const ledger=new XResearchScopeLedger();ledger.observe(original);ledger.observe({...original,callId:'distinct'});
 expect(ledger.prior('scope-run').withCurrent(current).search.totalRows).toBe(4);
 ledger.observe(read('same'));
 expect(ledger.prior('scope-run').withCurrent(current)).toMatchObject({callCount:2,unavailableCallCount:1,search:{totalRows:2}});
 ledger.observe(search('same','different-run',6));
 expect(ledger.prior('different-run').withCurrent(read('r','different-run'))).toMatchObject({runId:'different-run',callCount:2,search:{totalRows:6},read:{totalRows:1}});
 expect(ledger.prior('scope-run').withCurrent(current).search.totalRows).toBe(2);
});

// Catches trusting model content, missing scope rows as zero, and branch append merging.
it('restores only successful matching SDK envelopes and marks known malformed canonical scope unavailable',()=>{
 const source=search('source'),current=read('current'),ledger=new XResearchScopeLedger();
 ledger.restore([envelope(source,source.callId)]);
 expect(ledger.prior('scope-run').withCurrent(current)).toMatchObject({callCount:2,unavailableCallCount:0,search:{totalRows:1}});
 const good=envelope(source,source.callId);
 for(const invalid of [
 {...good,type:'custom'}, {...good,message:{...good.message,role:'assistant'}},
 {...good,message:{...good.message,toolName:'other'}}, {...good,message:{...good.message,isError:true}},
 {...good,message:{...good.message,toolCallId:'mismatch'}},
 envelope({...source,schemaVersion:1},source.callId),
 {...good,message:{...good.message,details:undefined,content:[{type:'text',text:JSON.stringify(source)}]}},
 ]){
 ledger.restore([invalid]);expect(ledger.prior('scope-run').withCurrent(current)).toMatchObject({callCount:1,unavailableCallCount:0,search:{totalRows:0}});
 }
 for(const invalid of [
 {...source,queries:undefined},{...source,queries:[]},
 {...source,queries:[{...source.queries[0],status:'invented'}]},
 {...source,queries:[{...source.queries[0],stopReason:undefined}]},
 {...source,queries:[{...source.queries[0],query:undefined}]},
 {...read('source'),targets:[{...read('source').targets[0],replies:{requested:true,observations:[],scope:{completeness:'unknown'}}}]},
 {...read('source'),targets:[{...read('source').targets[0],reason:undefined}]},
 {...read('source'),targets:[{...read('source').targets[0],target:undefined}]},
 {...read('source'),targets:[{...read('source').targets[0],article:undefined}]},
 ]){
 ledger.restore([good]);expect(ledger.prior('scope-run').withCurrent(current).search.totalRows).toBe(1);
 ledger.restore([envelope(invalid,source.callId)]);
 expect(ledger.prior('scope-run').withCurrent(current)).toMatchObject({callCount:1,unavailableCallCount:1,search:{totalRows:0},read:{totalRows:1}});
 }
 ledger.restore([good]);expect(ledger.prior('scope-run').withCurrent(current).search.totalRows).toBe(1);
 ledger.restore([]);expect(ledger.prior('scope-run').withCurrent(current).search.totalRows).toBe(0);
});

// Catches measuring with a stale run summary and accepting an untrusted aggregate.
it('keeps trusted prior immutable, recomputes final scope through projection and full SDK fixed-point bytes',()=>{
 const ledger=new XResearchScopeLedger(),previous=search('previous','scope-run',2),current=read('current');ledger.observe(previous);
 const prior=ledger.prior('scope-run');
 const plain=serializeXResearchResult(current,prior);
 expect(plain.result.reportRunScopeFacts).toMatchObject({callCount:2,search:{totalRows:2},read:{totalRows:1,reasonCounts:{post_identity_unproven:1}}});
 ledger.observe(search('later','scope-run',3));
 const projected=serializeXResearchResult({...current,objective:'x'.repeat(600000)},prior);
 expect(projected.result.contentProjection).toBe('x_research_projection_v1');
 expect(projected.result.reportRunScopeFacts).toEqual(plain.result.reportRunScopeFacts);
 expect(JSON.parse(projected.text).reportRunScopeFacts).toEqual(projected.result.reportRunScopeFacts);
 expect(serializeXResearchResult(projected.result,prior)).toEqual(projected);
 const bytes=Buffer.byteLength(JSON.stringify(xResearchToolResult(projected)));
 expect(bytes).toBe(projected.result.budgetUsage.outputBytes);expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
 expect(serializeXResearchResult(projected.result).result.reportRunScopeFacts).toBeUndefined();
 const restored=new XResearchScopeLedger();restored.restore([envelope(projected.result,current.callId)]);
 expect(restored.prior('scope-run').withCurrent(previous)).toMatchObject({callCount:2,search:{totalRows:2},read:{totalRows:1}});
 restored.restore([envelope(JSON.parse(projected.text),current.callId)]);
 expect(restored.prior('scope-run').withCurrent(previous)).toMatchObject({callCount:1,unavailableCallCount:1,search:{totalRows:2},read:{totalRows:0}});
 const changed=structuredClone(current);changed.targets[0].reason='reply_readiness_timeout';
 expect(serializeXResearchResult(changed,prior).result.reportRunScopeFacts?.read.reasonCounts).toEqual({reply_readiness_timeout:1});
 const fake={...current,reportRunScopeFacts:{...plain.result.reportRunScopeFacts!,callCount:999}} as XResearchResult;
 expect(serializeXResearchResult(fake,prior).result.reportRunScopeFacts).toEqual(plain.result.reportRunScopeFacts);
});

// Catches conflating delivery omissions with the collection source scope.
it('preserves source scope when delivery omits body history and restores the same aggregate',async()=>{
 const {retainReadBody}=await import('./xResearchReadStages');
 const current=await readX({tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},
 {...fixture([readHtml(post())]).context,runId:'scope-run',callId:'final-read',batchId:'final-batch'});
 const row=current.targets[0];Object.assign(row,{status:'observed',stopReason:'agent_stopped',reason:null});
 const ledger=new XResearchScopeLedger(),priorSearch=search('prior-search','scope-run',2);ledger.observe(priorSearch);
 const prior=ledger.prior('scope-run'),plain=serializeXResearchResult(current,prior);
 expect(plain.result.reportRunScopeFacts?.read).toMatchObject({totalRows:1,statusCounts:{observed:1},stopReasonCounts:{agent_stopped:1},reasonCounts:{unknown:1}});
 const root=row.root!;
 for(let n=0;n<900;n++)retainReadBody(row,{...structuredClone(root),observationId:`earlier-${n}`,text:'',truncation:{returned:0,totalKnown:0,truncated:false},articlePreviews:[{entryObservationId:`entry-${n}`,parentPostId:'123',sourceUrl:root.sourceUrl!,targetUrl:'https://x.com/bob/status/456'}],articlePreviewInventory:{scope:'collection',observed:1,retained:1,omitted:0,unresolved:0}});
 const capped=serializeXResearchResult(current,prior);
 expect(capped.result.targets[0].bodyObservationsOmitted).toBeGreaterThan(0);
 expect(capped.result.reportRunScopeFacts).toMatchObject({callCount:2,unavailableCallCount:0,search:{totalRows:2},read:{totalRows:1,statusCounts:{observed:1},stopReasonCounts:{agent_stopped:1},reasonCounts:{unknown:1}}});
 expect(JSON.parse(capped.text).reportRunScopeFacts).toEqual(capped.result.reportRunScopeFacts);
 const bytes=Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)));
 expect(bytes).toBe(capped.result.budgetUsage.outputBytes);expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
 ledger.observe(capped.result);
 expect(serializeXResearchResult(capped.result,ledger.prior('scope-run'))).toEqual(capped);
 ledger.restore([envelope(priorSearch,priorSearch.callId),envelope(capped.result,current.callId)]);
 expect(serializeXResearchResult(capped.result,ledger.prior('scope-run'))).toEqual(capped);
});
