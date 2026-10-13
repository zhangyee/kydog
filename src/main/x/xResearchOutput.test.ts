import { describe, expect, it } from 'vitest';
import { fixture, post, searchHtml, searchInput, stagedFixture } from '../../test-support/xResearchFixture';
import { readX, readResult } from './xResearchRead';
import { readHtml } from '../../test-support/xResearchFixture';
import { searchX, searchResult } from './xResearchSearch';
import { assertXRequestFits, serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
import { X_RESEARCH_MAX_OUTPUT_BYTES } from './xResearchTypes';
describe('bounded X production tool result',()=>{
  it('keeps actual unchanged-control read reasons distinct from page text and absent reasons',async()=>{
    const bodyFixture=await stagedFixture({noEffect:true});
    const body=await readX({tabId:'tab',read:{objective:'body',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:3}},bodyFixture.context);
    const replyOptions={noEffect:false};
    const replyFixture=await stagedFixture(replyOptions);
    Object.defineProperty(replyOptions,'noEffect',{get:()=>replyFixture.executed.includes('replies_expand')});
    const reply=await readX({tabId:'tab',read:{objective:'replies',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:true,maxRepliesPerPost:30,maxScrollsPerPost:0,maxExpandActionsPerPost:3}},replyFixture.context);
    for(const [actual,reason] of [[body,'body_expand_control_unchanged'],[reply,'replies_expand_control_unchanged']] as const){
      expect(actual.targets[0]).toMatchObject({status:'partial',stopReason:'action_failed',reason});
      const controls=readResult({tabId:'tab',read:{objective:'controls',targets:[{postId:'999'},{postId:'998'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post())]).context);
      controls.targets[0].reason='登录页面说请重试';
      controls.targets[1].reason=null;
      const result={...actual,targets:[actual.targets[0],...controls.targets]};
      const expected={version:1,operation:'read',reasonSource:'reason',totalRows:3,statusCounts:{partial:1,failed:2},stopReasonCounts:{action_failed:1,agent_stopped:2},reasonCounts:{[reason]:1,unknown:2},replyScopeCounts:{unknown:3}};
      for(const candidate of [result,{...result,objective:'x'.repeat(600000)}]){
        const out=serializeXResearchResult(candidate);
        expect(out.result.reportScopeFacts).toEqual(expected);
        expect(JSON.parse(out.text).reportScopeFacts).toEqual(expected);
        expect(JSON.stringify(out.result.reportScopeFacts)).not.toContain('登录页面说请重试');
        expect(out.result.targets.map(row=>row.reason)).toEqual([reason,'登录页面说请重试',null]);
        expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
        if(candidate.objective.length>600000-1)expect(out.result.contentProjection).toBe('x_research_projection_v1');
      }
    }
  });
  it('reports distinct per-call search stops from final rows in normal and capped content',()=>{
    const input=structuredClone(searchInput);
    input.search.queries=Array.from({length:4},(_,i)=>({...searchInput.search.queries[0],id:`q${i}`}));
    const result=searchResult(input,fixture([searchHtml(post())]).context);
    const [empty,wait,stalled,budget]=result.queries;
    Object.assign(empty,{status:'explicit_empty',stopReason:'explicit_ui_end',barrier:{status:'explicit_empty',reason:'localized page text',observationId:'page-1'}});
    Object.assign(wait,{status:'failed',stopReason:'wait_timeout'});
    Object.assign(stalled,{status:'failed',stopReason:'action_failed',barrier:{status:'failed',reason:'scroll_no_movement',observationId:null}});
    Object.assign(budget,{status:'partial',stopReason:'budget_reached'});
    result.reportScopeFacts={version:1,operation:'search',reasonSource:'barrier.reason',totalRows:999,statusCounts:{},stopReasonCounts:{},reasonCounts:{},replyScopeCounts:{}};
    const expected={version:1,operation:'search',reasonSource:'barrier.reason',totalRows:4,statusCounts:{explicit_empty:1,failed:2,partial:1},stopReasonCounts:{explicit_ui_end:1,wait_timeout:1,action_failed:1,budget_reached:1},reasonCounts:{unknown:3,scroll_no_movement:1},replyScopeCounts:{}};
    const normal=serializeXResearchResult(result);
    expect(normal.result.reportScopeFacts).toEqual(expected);
    expect(JSON.parse(normal.text).reportScopeFacts).toEqual(expected);
    expect(JSON.stringify(normal.result.reportScopeFacts)).not.toContain('localized page text');
    const projected=serializeXResearchResult({...result,objective:'x'.repeat(600000)});
    expect(projected.result.contentProjection).toBe('x_research_projection_v1');
    expect(projected.result.reportScopeFacts).toEqual(expected);
    expect(JSON.parse(projected.text).reportScopeFacts).toEqual(expected);
    expect(serializeXResearchResult(projected.result)).toEqual(projected);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(projected)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    const changed=structuredClone(normal.result);changed.queries[1].status='observed';
    expect(serializeXResearchResult(changed).result.reportScopeFacts?.statusCounts).toEqual({explicit_empty:1,observed:1,failed:1,partial:1});
    const next=structuredClone(normal.result);next.callId='another-call';next.queries=[next.queries[0]];
    expect(serializeXResearchResult(next).result.reportScopeFacts?.totalRows).toBe(1);
  });
  it('reports partial read scope and finite reasons without promoting unknown reply parentage',()=>{
    const input={tabId:'tab',read:{objective:'read',targets:Array.from({length:10},(_,i)=>({postId:String(i+100)})),includeArticle:false,includeReplies:true,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}};
    const result=readResult(input,fixture([readHtml(post())]).context);
    const reasons=['post_identity_unproven','post_identity_unproven',...Array(6).fill('scroll_no_movement'),'reply_readiness_timeout','action_failed:browser.click_intercepted'];
    result.targets.forEach((row,i)=>{row.status='partial';row.stopReason=i<2?'identity_unproven':i<8?'action_failed':i===8?'wait_timeout':'action_failed';row.reason=reasons[i];row.replies.scope.completeness='unknown';});
    const root={observationId:'reply-1',sourceKind:'rendered_ui' as const,postId:'901',sourceUrl:'https://x.com/a/status/901',author:{handle:'a',displayName:null,profileUrl:null},text:'reply',observedAt:'2026-10-13T00:00:00.000Z',truncation:{returned:5,totalKnown:5,truncated:false},containerKind:'reply' as const,directParent:null};
    result.targets[0].replies.observations=[root,{...root,observationId:'reply-2',postId:'902',directParent:{postId:'100',sourceUrl:'https://x.com/a/status/100'}}];
    const expected={version:1,operation:'read',reasonSource:'reason',totalRows:10,statusCounts:{partial:10},stopReasonCounts:{identity_unproven:2,action_failed:7,wait_timeout:1},reasonCounts:{post_identity_unproven:2,scroll_no_movement:6,reply_readiness_timeout:1,'action_failed:browser.click_intercepted':1},replyScopeCounts:{unknown:10}};
    for(const source of [result,{...result,objective:'x'.repeat(600000)}]){
      const out=serializeXResearchResult(source);
      expect(out.result.reportScopeFacts).toEqual(expected);
      expect(JSON.parse(out.text).reportScopeFacts).toEqual(expected);
      expect(out.result.targets[0].replies.observations.map(r=>r.containerKind==='reply'?r.directParent:undefined)).toEqual([null,{postId:'100',sourceUrl:'https://x.com/a/status/100'}]);
      expect(JSON.parse(out.text).targets[0].replies.observations.map((r:{directParent:unknown})=>r.directParent)).toEqual([null,{postId:'100',sourceUrl:'https://x.com/a/status/100'}]);
      expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    }
  });
  it('counts exact combined JSON envelope, including escaped text and v2 details',async()=>{
    const result=await searchX(searchInput,fixture([searchHtml(post())]).context);
    const serialized=serializeXResearchResult(result);
    const bytes=Buffer.byteLength(JSON.stringify(xResearchToolResult(serialized)),'utf8');
    expect(serialized.result.budgetUsage.outputBytes).toBe(bytes);
    const row=serialized.result.queries[0];
    const rowJson=JSON.stringify(row);
    expect(row.budgetUsage.outputBytes).toBe(Buffer.byteLength(rowJson)+Buffer.byteLength(JSON.stringify(rowJson))-2);
    expect(serialized.result.truncation.truncated).toBe(false);
    expect(JSON.parse(serialized.text)).toEqual(serialized.result);
    const original=result.queries[0].posts[0];
    original.text='汉字\\"'.repeat(100000);
    original.truncation={returned:original.text.length,totalKnown:original.text.length,truncated:false};
    const capped=serializeXResearchResult(result);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(capped.result.truncation).toMatchObject({truncated:true,totalKnown:original.text.length+8});
    expect(capped.result.queries[0].posts[0].truncation).toMatchObject({truncated:true,totalKnown:original.text.length});
    expect(capped.result.queries[0]).toMatchObject({query:searchInput.search.queries[0],status:'partial',stopReason:'budget_reached'});
    expect(original.text.length).toBe(400000);
  });
  it('exact boundary admitted; one byte over is reduced while all request records survive',async()=>{
    const result=await searchX(searchInput,fixture([searchHtml(post())]).context);
    const body=result.queries[0].posts[0]; body.text='a'.repeat(600000);body.truncation={returned:600000,totalKnown:600000,truncated:false};
    const capped=serializeXResearchResult(result);
    const bytes=Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)),'utf8');
    expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(X_RESEARCH_MAX_OUTPUT_BYTES-bytes).toBeLessThan(5);
    const again=serializeXResearchResult(capped.result);
    expect(again).toEqual(capped);
    expect(capped.result.queries).toHaveLength(1);
    const over=structuredClone(capped.result);
    over.queries[0].posts[0].text+='a';over.queries[0].posts[0].truncation.returned++;
    const overJson=JSON.stringify(over);
    expect(Buffer.byteLength(JSON.stringify({content:[{type:'text',text:overJson}],details:over}))).toBeGreaterThan(X_RESEARCH_MAX_OUTPUT_BYTES);
    const recapped=serializeXResearchResult(over);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(recapped)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(recapped.result.queries[0].posts[0].text.length).toBe(capped.result.queries[0].posts[0].text.length);
  });
  it('prunes secondary metadata while preserving every failed target and root identity',async()=>{
    const f=fixture([readHtml(post())]);
    const result=await readX({tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'},{postId:'999'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:100,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},f.context);
    const root=result.targets[0].root!;
    result.targets[0].replies.observations=Array.from({length:2000},(_,i)=>({...root,postId:String(i+1000),observationId:`reply-${i}`,text:'',author:{handle:'a'.repeat(15),displayName:null,profileUrl:null},directParent:null,containerKind:'reply' as const,truncation:{returned:0,totalKnown:0,truncated:false}}));
    expect(serializeXResearchResult({...result,targets:result.targets.map(t=>({...t,replies:{...t.replies,observations:t.replies.observations.slice(0,1)}}))}).result.truncation.truncated).toBe(false);
    const value=serializeXResearchResult(result);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(value)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(value.result.targets).toHaveLength(2);
    expect(value.result.targets[0].root).toMatchObject({postId:'123',sourceUrl:'https://x.com/alice/status/123'});
    expect(value.result.targets[1]).toMatchObject({postId:'999',status:'failed',reason:'unresolved_target',stopReason:'agent_stopped'});
    expect(value.result.truncation.truncated).toBe(true);
    expect(value.result.targets[0].replies.observations.length).toBeLessThan(2000);
  });
  it('names diagnostic omissions at the 1 MiB boundary while retaining stop and root facts',async()=>{
    const input={tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}};
    const result=await readX(input,fixture([readHtml(post())]).context);
    const row=result.targets[0],frame=row.diagnostics!.initialFrame!;
    expect(serializeXResearchResult(result).result.targets[0].diagnostics?.firstAdmittedFrame?.rootIdentityProven).toBe(true);
    row.diagnostics!.scroll={totalAttempts:1,omittedAttempts:0,first:{actionIndex:1,snapshotId:'xsnap_test',generation:frame.document.generation,location:frame.location,
      targetKind:'document',targetNodeId:7,targetContainsHit:true,conversationRelation:'unknown',rootRelation:'unknown',before:10,after:10,
      scrollHeight:1000,clientHeight:700,written:true,eventObserved:false,frameObserved:false,state:'no_movement'}};
    row.diagnostics!.scroll.last=row.diagnostics!.scroll.first;
    const minimal=structuredClone(result);delete minimal.targets[0].diagnostics;
    let lo=600000,hi=1048576;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);minimal.objective='x'.repeat(mid);try{serializeXResearchResult(minimal);lo=mid;}catch{hi=mid-1;}}
    let out:ReturnType<typeof serializeXResearchResult<typeof result>>|undefined;
    for(let margin=200;margin<=4000;margin+=200){
      result.objective='x'.repeat(lo-margin);
      try {const candidate=serializeXResearchResult(result);if(candidate.result.metadataOmissions?.includes('targets.0.diagnostics.firstAdmittedFrame')){out=candidate;break;}} catch { /* The omission marker itself may need more room. */ }
    }
    expect(out).toBeDefined();
    if(!out) throw new Error('diagnostic cap fixture did not reach an omission');
    expect(out.result.metadataOmissions).toContain('targets.0.diagnostics.scroll');
    expect(out.result.metadataOmissions).toContain('targets.0.diagnostics.firstAdmittedFrame');
    expect(out.result.targets[0].diagnostics?.firstAdmittedFrame).toBeUndefined();
    expect(out.result.targets[0]).toMatchObject({root:{postId:'123'},status:row.status,stopReason:row.stopReason,reason:row.reason});
    expect(JSON.parse(out.text).metadataOmissions).toContain('targets.0.diagnostics.scroll');
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
  });
  it('exact full boundary survives real tab/state growth through declared projection without losing requests',()=>{
    const f=fixture([searchHtml(post())]);const input=structuredClone(searchInput);
    let lo=0,hi=600000;
    while(lo<hi) {const mid=Math.ceil((lo+hi)/2);input.search.objective='a'.repeat(mid);const value=serializeXResearchResult(searchResult(input,f.context));if(!value.result.contentProjection) lo=mid;else hi=mid-1;}
    input.search.objective='a'.repeat(lo);const result=searchResult(input,f.context);
    const full=serializeXResearchResult(result);expect(full.result.budgetUsage.outputBytes).toBe(X_RESEARCH_MAX_OUTPUT_BYTES);
    assertXRequestFits(result);result.browserTabId='tab_12345678';result.queries[0].status='partial';result.queries[0].stopReason='budget_reached';
    const projected=serializeXResearchResult(result);expect(projected.result.contentProjection).toBe('x_research_projection_v1');expect(JSON.parse(projected.text).contentProjection).toBe('x_research_projection_v1');
    expect(projected.result.objective).toBe(input.search.objective);expect(projected.result.queries[0]).toMatchObject({query:input.search.queries[0],status:'partial',stopReason:'budget_reached'});
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(projected)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
  });
  it('Unicode text shortening never introduces half a surrogate pair',async()=>{
    const result=await searchX(searchInput,fixture([searchHtml(post())]).context),body=result.queries[0].posts[0];body.text='😀'.repeat(400000);body.truncation={returned:body.text.length,totalKnown:body.text.length,truncated:false};
    const out=serializeXResearchResult(result);expect(out.result.queries[0].posts[0].text.endsWith('\uD83D')).toBe(false);expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);expect(out.result.queries[0].posts[0].truncation.totalKnown).toBe(800000);
  });
  it('projects every named body with its own literal ID, source and author',async()=>{
    const f=fixture([readHtml(post())]);
    const result=await readX({tabId:'tab',read:{objective:'a'.repeat(600000),targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},f.context);
    const root=result.targets[0].root!;
    const named=(kind:'quoted_post'|'reply'|'article',id:string,handle:string)=>({...root,directParent:null,containerKind:kind,postId:id,sourceUrl:`https://x.com/${handle}/status/${id}`,author:{handle,displayName:null,profileUrl:null},text:`${kind} body`});
    result.targets[0].quotedPosts=[named('quoted_post','456','bob')];result.targets[0].article.body=named('article','789','carol');result.targets[0].replies.observations=[named('reply','234','dave')];
    const out=serializeXResearchResult(result),model=JSON.parse(out.text).targets[0];
    for(const [actual,expected] of [[model.root,root],[model.quotedPosts[0],result.targets[0].quotedPosts[0]],[model.article.body,result.targets[0].article.body],[model.replies.observations[0],result.targets[0].replies.observations[0]]] as const) {
      expect(actual).toMatchObject({postId:expected!.postId,sourceUrl:expected!.sourceUrl,authorHandle:expected!.author!.handle,text:expected!.text});
    }
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)))).toBe(out.result.budgetUsage.outputBytes);
  });

  it('aliases only equal same-row model document URLs and retains legal different source coordinates at cap',async()=>{
    const handle='alice_123456789',url=`https://x.com/${handle}/status/123`;
    const f=fixture([readHtml(post('123',handle))]);
    const result=await readX({tabId:'tab',read:{objective:'a'.repeat(600000),targets:[{url}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},f.context);
    const root=result.targets[0].root!,doc=result.targets[0].documentSource!;
    const equal=serializeXResearchResult(result),equalModel=JSON.parse(equal.text);
    expect(equalModel.targets[0].root).toMatchObject({postId:'123',sourceUrl:root.sourceUrl,authorHandle:handle});
    expect(equalModel.targets[0].documentSource).toEqual({rootObservationId:root.observationId,sourceUrlReference:'root.sourceUrl'});
    expect(equal.result.targets[0].documentSource).toEqual(doc);
    const different=structuredClone(result);
    const redirected=fixture([readHtml(post('123',handle))],{finalUrl:()=>url+'/'});
    const actualDifferent=await readX({tabId:'tab',read:{objective:result.objective,targets:[{url}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},redirected.context);
    different.targets[0]=actualDifferent.targets[0];
    const differentRoot=different.targets[0].root!;
    const fullDifferent=serializeXResearchResult(different);
    expect(JSON.parse(fullDifferent.text).targets[0].documentSource).toMatchObject({rootObservationId:differentRoot.observationId,sourceUrl:url+'/'});
    // Legal public source URLs are shorter than an omission marker. Find the
    // last exact-size envelope retaining both identities, then prove rejection.
    let lo=600000,hi=1048576;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);different.objective='a'.repeat(mid);try{serializeXResearchResult(different);lo=mid;}catch{hi=mid-1;}}
    different.objective='a'.repeat(lo);
    const capped=serializeXResearchResult(different),model=JSON.parse(capped.text);
    expect(model.targets[0].documentSource).toEqual({rootObservationId:differentRoot.observationId,sourceUrl:url+'/'});
    expect(model.targets[0].root).toMatchObject({postId:'123',sourceUrl:root.sourceUrl,authorHandle:handle});
    expect(capped.result.targets[0].documentSource).toEqual(different.targets[0].documentSource);
    expect(capped.result.objective).toBe(different.objective);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)))).toBe(capped.result.budgetUsage.outputBytes);
    expect(capped.result.budgetUsage.outputBytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    different.objective+='a';
    expect(()=>serializeXResearchResult(different)).toThrow(/required-state envelope/);
  });

});

it('preflights the Article navigation-stage diagnostic cost before I/O',()=>{
  const f=fixture([readHtml(post())]);
  const initial=readResult({tabId:'tab',read:{objective:'x',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},f.context);
  let low=1,high=1048576;
  while(low<high){const mid=Math.ceil((low+high)/2);initial.objective='x'.repeat(mid);try{assertXRequestFits(initial);low=mid;}catch{high=mid-1;}}
  initial.objective='x'.repeat(low);
  expect(()=>assertXRequestFits(initial)).not.toThrow();
  const article=structuredClone(initial);article.targets[0].article.requested=true;
  expect(()=>assertXRequestFits(article)).toThrow(/required-state envelope/);
});


it('preserves actual independently collected root and Article identity at the exact combined cap',async()=>{
  const {stagedFixture}=await import('../../test-support/xResearchFixture');
  const f=await stagedFixture({article:'ok'});
  const input={tabId:'research-tab',read:{objective:'a'.repeat(600000),targets:[{url:'https://x.com/alice/status/123'}],includeArticle:true,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:3}};
  expect(()=>assertXRequestFits(readResult(input,f.context))).not.toThrow();
  const result=await readX(input,f.context),row=result.targets[0];
  expect(row.article).toMatchObject({entryObserved:true,actionAttempted:true,navigationStarted:true,bodyObserved:true,body:{postId:'456',sourceUrl:'https://x.com/bob/status/456',author:{handle:'bob'}}});
  expect(row.root).toMatchObject({postId:'123',sourceUrl:'https://x.com/alice/status/123',author:{handle:'alice'}});
  let lo=result.objective.length,hi=1048576;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);result.objective='a'.repeat(mid);try{serializeXResearchResult(result);lo=mid;}catch{hi=mid-1;}}
  result.objective='a'.repeat(lo);
  const out=serializeXResearchResult(result),model=JSON.parse(out.text).targets[0];
  expect(model.root).toMatchObject({postId:row.root!.postId,sourceUrl:row.root!.sourceUrl,authorHandle:'alice'});
  expect(model.article.body).toMatchObject({postId:row.article.body!.postId,sourceUrl:row.article.body!.sourceUrl,authorHandle:'bob'});
  expect(out.result.targets[0].article).toMatchObject({entryObserved:true,actionAttempted:true,navigationStarted:true,bodyObserved:true});
  expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)))).toBe(out.result.budgetUsage.outputBytes);
  expect(out.result.budgetUsage.outputBytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
  result.objective+='a';
  expect(()=>serializeXResearchResult(result)).toThrow(/required-state envelope/);
});

it('retains preview and exact entry identity in projected and metadata-compacted canonical output', async()=>{
 const f=fixture([readHtml(post())]);
 const r=await readX({tabId:'tab',read:{objective:'a'.repeat(600000),targets:[{url:'https://x.com/alice/status/123'}],includeArticle:true,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},f.context);
 const identity={entryObservationId:'entry-real',parentPostId:'123',sourceUrl:'https://x.com/alice/status/123',targetUrl:'https://x.com/bob/status/456'};
 const second={...identity,entryObservationId:'second-entry',targetUrl:'https://x.com/carol/status/789'};
 r.targets[0].root!.articlePreviews=[identity,second];
 r.targets[0].article.entry={observationId:'entry-real',parentPostId:'123',sourceUrl:identity.sourceUrl,targetUrl:identity.targetUrl,author:{handle:'bob',profileUrl:null,displayName:null},label:'label',binding:{nodeId:1,index:1,snapshotId:'s',generation:'g'}};
 r.targets[0].article.entryObserved=true;r.targets[0].article.actionAttempted=true;
 let value=serializeXResearchResult(r);
 expect(JSON.parse(value.text).targets[0].root.articlePreviews).toEqual([identity,second]);
 expect(JSON.parse(value.text).targets[0].article.entryIdentity).toEqual(identity);
 // Giant optional label forces metadata pruning; the identity remains independently usable.
 r.targets[0].article.entry.label='x'.repeat(1100000);
 value=serializeXResearchResult(r);
 expect(value.result.targets[0].article.entry).toBeNull();
 expect(value.result.targets[0].article.entryIdentity).toEqual(identity);
 expect(value.result.targets[0].root!.articlePreviews).toEqual([identity,second]);
 expect(JSON.parse(value.text).targets[0].article.entryIdentity).toEqual(identity);
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(value)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
});
it('drops optional search posts with their complete preview lists at the exact cap, never just an entry fact',async()=>{
 const r=await searchX(searchInput,fixture([searchHtml(post())]).context),base=r.queries[0].posts[0];
 const previews=Array.from({length:20},(_,i)=>({entryObservationId:`entry-${i}`,parentPostId:'123',sourceUrl:'https://x.com/alice/status/123',targetUrl:`https://x.com/bob/status/${i+1000}`}));
 r.queries[0].posts=[{...base,articlePreviews:previews}];expect(serializeXResearchResult(r).result.queries[0].posts[0].articlePreviews).toEqual(previews);
 r.objective='a'.repeat(600000);
 r.queries[0].posts=Array.from({length:100},(_,i)=>({...base,observationId:`post-${i}`,articlePreviews:previews}));
 const out=serializeXResearchResult(r),model=JSON.parse(out.text);
 expect(out.result.queries[0].posts.length).toBeGreaterThan(0);expect(out.result.queries[0].posts.length).toBeLessThan(100);expect(out.result.truncation.truncated).toBe(true);
 for(const p of out.result.queries[0].posts)expect(p.articlePreviews).toEqual(previews);for(const p of model.queries[0].posts)expect(p.articlePreviews).toEqual(previews);
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)))).toBe(out.result.budgetUsage.outputBytes);expect(out.result.budgetUsage.outputBytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
});

it('keeps repeated candidate observations as one atomic cap group and preserves read audit omission as unknown',async()=>{
 const card=(id:string)=>`<div role="link" tabindex="0" href="https://x.com/bob/status/${id}"><div data-testid="User-Name"><a href="/bob">bob</a><a href="/bob">@bob</a></div><img data-testid="article-cover-image"></div>`;
 const posts=Array.from({length:60},(_,i)=>post(String(1000+i),'alice').replace('</article>',card(String(2000+i)).repeat(i<30?0:3)+'</article>')).join('');
 const search=await searchX({search:{...searchInput.search,maxPostsPerQuery:100}},fixture([searchHtml(posts),searchHtml(posts)]).context);
 // Exact duplicated-container observations are real independently collected frames.
 expect(search.queries[0].postObservations!.length).toBeGreaterThan(0);
 search.objective='a'.repeat(1010000);
 const capped=serializeXResearchResult(search);
 const ids=new Set(capped.result.queries[0].posts.map(p=>p.postId));
 expect(ids.size).toBeGreaterThan(0);expect(ids.size).toBeLessThan(search.queries[0].posts.length);
 expect(capped.result.truncation.truncated).toBe(true);
 for(const p of capped.result.queries[0].postObservations??[])expect(ids.has(p.postId)).toBe(true);
 for(const id of ids)expect((capped.result.queries[0].postObservations??[]).filter(p=>p.postId===id).length).toBe(search.queries[0].postObservations!.filter(p=>p.postId===id).length);
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
 const r=await readX({tabId:'research-tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post())]).context);
 const baseline=structuredClone(r);const row=r.targets[0],root=row.root!;
 row.articlePreviewObservations=Array.from({length:50},(_,i)=>({observationId:'scope-'+i,postId:root.postId!,sourceUrl:root.sourceUrl!,authorHandle:'alice',articlePreviews:[{entryObservationId:'entry-'+i,parentPostId:'123',sourceUrl:root.sourceUrl!,targetUrl:'https://x.com/bob/status/456'}],articlePreviewInventory:{scope:'collection',observed:2,retained:1,omitted:1,unresolved:0}}));
 expect(serializeXResearchResult(r).result.targets[0].articlePreviewObservations).toHaveLength(50);
 r.objective='b'.repeat(1020000);
 const limited=serializeXResearchResult(r);
 expect(limited.result.targets[0].inventoryAuditOmitted).toMatchObject({count:50,first:{observationId:'scope-0',sourceUrl:root.sourceUrl}});
 expect(JSON.parse(limited.text).targets[0].inventoryAuditOmitted).toEqual(limited.result.targets[0].inventoryAuditOmitted);
 const {XResearchEvidence}=await import('./xResearchEvidence');const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(baseline);expect(ledger.guard('/tmp/a.md','[source](https://x.com/alice/status/123)')).toBeUndefined();ledger.observe(limited.result);
 // Explicit omission cannot disappear into a false known-empty inventory.
 expect(()=>ledger.guard('/tmp/a.md','[source](https://x.com/alice/status/123)')).toThrow('inventory');
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(limited)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
});


it('caps displaced body observations honestly and retains their known Article citation obligations',async()=>{
  const {retainReadBody}=await import('./xResearchReadStages');
  const {XResearchEvidence}=await import('./xResearchEvidence');
  const result=await readX({tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post())]).context);
  const row=result.targets[0],root=row.root!;
  const plain=serializeXResearchResult(result);const admitted=new XResearchEvidence('/tmp',()=> 'run');admitted.observe(plain.result);
  expect(()=>admitted.guard('/tmp/report.md','[root](https://x.com/alice/status/123)')).not.toThrow();
  // Exact independently named observations, not fragments concatenated into a body.
  for(let n=0;n<900;n++)retainReadBody(row,{...structuredClone(root),observationId:`earlier-${n}`,text:'',truncation:{returned:0,totalKnown:0,truncated:false},articlePreviews:[{entryObservationId:`entry-${n}`,parentPostId:'123',sourceUrl:root.sourceUrl!,targetUrl:'https://x.com/bob/status/456'}],articlePreviewInventory:{scope:'collection',observed:1,retained:1,omitted:0,unresolved:0}});
  const capped=serializeXResearchResult(result),model=JSON.parse(capped.text),saved=capped.result.targets[0];
  expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
  expect(saved.bodyObservationsOmitted).toBeGreaterThan(0);
  expect(saved.bodyObservations!.length+saved.bodyObservationsOmitted!).toBe(900);
  expect(model.targets[0].bodyObservationsOmitted).toBe(saved.bodyObservationsOmitted);
  expect(capped.result.truncation.truncated).toBe(true);
  expect(saved.root).toMatchObject({observationId:root.observationId,sourceUrl:root.sourceUrl,truncation:{totalKnown:8,truncated:true}});
  const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(capped.result);
  // A later ordinary body supplies citable text but cannot erase the retained Article obligation.
  ledger.observe(plain.result);
  expect(()=>ledger.guard('/tmp/report.md','[root](https://x.com/alice/status/123)')).toThrow(/Article/);
  expect(serializeXResearchResult(capped.result)).toEqual(capped);
});
