import { describe, expect, it } from 'vitest';
import { fixture, post, searchHtml, searchInput, stagedFixture } from '../../test-support/xResearchFixture';
import { collectPostFrame, savePostFrame, type XReadStage } from './xResearchReadStages';
import { readX, readResult } from './xResearchRead';
import { readHtml } from '../../test-support/xResearchFixture';
import { searchX, searchResult } from './xResearchSearch';
import { assertXRequestFits, serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
import { XResearchEvidence } from './xResearchEvidence';
import { X_RESEARCH_MAX_OUTPUT_BYTES } from './xResearchTypes';
import { XResearchScopeLedger } from './xResearchScopeFacts';

it.each(['read','search'] as const)('preserves current %s bodies and diagnostics before omitting optional history',async operation=>{
 const text='当前汉字😀'.repeat(1100);
 const quote='<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/eve">@eve</a></div><div data-testid="tweetText">quote body</div><a href="/eve/status/888"><time>today</time></a></div>';
 const raw=operation==='read'
  ?await readX({tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:true,maxRepliesPerPost:100,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post('123','alice',text).replace('</article>',quote+'</article>')+post('789','carol','reply body'))]).context)
  :await searchX(searchInput,fixture([searchHtml(post('123','alice',text))]).context);
 if(raw.operation==='read')raw.targets[0].bodyObservations=[];else raw.queries[0].postObservations=[];
 if(raw.operation==='read'){
  const article=await readX({tabId:'research-tab',read:{objective:'Article',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:true,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:3}},(await stagedFixture({article:'ok'})).context);
  raw.targets[0].article=article.targets[0].article;
  expect(raw.targets[0].article.body!.text).toContain('Article paragraph');expect(raw.targets[0].quotedPosts[0].text).toBe('quote body');
 }
 const current=raw.operation==='read'?raw.targets[0].root!:raw.queries[0].posts[0];
 // Search's source excerpt cap is separate; this DTO pressure case supplies a known body.
 if(raw.operation==='search'){current.text=text;current.truncation={returned:text.length,totalKnown:text.length,truncated:false};}
 const baseline=serializeXResearchResult(raw);
 expect(current.text).toBe(text);
 const history=Array.from({length:100},(_,i)=>({...structuredClone(current),observationId:`old-${i}`,text:'历史'.repeat(2000),truncation:{returned:4000,totalKnown:4000,truncated:false}}));
 if(raw.operation==='read'){raw.targets[0].bodyObservations=history;raw.targets[0].bodyObservationsOmitted=7;}
 else {raw.queries[0].postObservations=history;Object.assign(raw.queries[0],{postObservationsOmitted:7});}
 const scopes=new XResearchScopeLedger();scopes.observe({...baseline.result,callId:'prior-call'});
 const prior=scopes.prior(raw.runId);
 const before=structuredClone(raw),out=serializeXResearchResult(raw,prior);
 const saved=out.result.operation==='read'?out.result.targets[0]:out.result.queries[0];
 const old=baseline.result.operation==='read'?baseline.result.targets[0]:baseline.result.queries[0];
 const retained='root' in saved?saved.bodyObservations!:saved.postObservations!;
 const omitted='root' in saved?saved.bodyObservationsOmitted:(saved as typeof saved&{postObservationsOmitted:number}).postObservationsOmitted;
 const model=JSON.parse(out.text)[operation==='read'?'targets':'queries'][0];
 if('root' in saved && 'root' in old){expect(saved.root).toEqual(old.root);expect(saved.replies).toEqual(old.replies);expect(saved.quotedPosts).toEqual(old.quotedPosts);expect(saved.article).toEqual(old.article);expect(model.root.text).toBe(text);expect(model.replies.observations[0].text).toBe('reply body');expect(model.quotedPosts[0].text).toBe('quote body');expect(model.article.body.text).toBe(old.article.body!.text);}
 else if('posts' in saved && 'posts' in old){expect(saved.posts).toEqual(old.posts);expect(model.posts[0].text).toBe(text);}
 expect(saved.diagnostics).toEqual(old.diagnostics);
 expect(saved.budgetUsage.distinctEntries).toBe(old.budgetUsage.distinctEntries);
 expect(out.result.reportScopeFacts?.totalRows).toBe(1);
 expect(out.result.reportRunScopeFacts?.callCount).toBe(2);
 expect(out.result.reportRunScopeFacts?.[operation].totalRows).toBe(2);
 expect(JSON.parse(out.text).reportRunScopeFacts).toEqual(out.result.reportRunScopeFacts);
 expect(omitted).toBe(107-retained.length);expect(omitted).toBeGreaterThan(7);
 expect(retained).toEqual(history.slice(0,retained.length));
 expect(model[operation==='read'?'bodyObservationsOmitted':'postObservationsOmitted']).toBe(omitted);
 expect(out.result.metadataOmissions).toContain(`${operation==='read'?'targets.0.bodyObservations':'queries.0.postObservations'}`);
 expect(out.result.truncation).toEqual(raw.truncation);
 expect(out.result.delivery).toMatchObject({truncated:true,omittedObservations:100-retained.length});
 expect(raw).toEqual(before);
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)),'utf8')).toBe(out.result.budgetUsage.outputBytes);
 expect(out.result.budgetUsage.outputBytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
 expect(serializeXResearchResult(out.result,prior)).toEqual(out);
},60000);

it.each(['null-preview','explicit-preview','bare-preview','unresolved','omitted'] as const)('preserves historical %s citation obligation as an empty-text shell under pressure',async kind=>{
 const raw=await searchX(searchInput,fixture([searchHtml(post())]).context),row=raw.queries[0];row.postObservations=[];
 const read=await readX({tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post())]).context);
 const cite='[source](https://x.com/alice/status/123)',guard=(value:typeof raw)=>{
  const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(read);ledger.observe(value);return ()=>ledger.guard('/tmp/report.md',cite);
 };
 expect(guard(raw)()).toBeUndefined();
 const preview=kind.includes('preview');
 const protectedHistory={...structuredClone(row.posts[0]),observationId:'protected-last',text:'历史'.repeat(400000),
  truncation:{returned:800000,totalKnown:800000,truncated:false},
  articlePreviews:preview?[{entryObservationId:'entry-history',parentPostId:'123',sourceUrl:'https://x.com/alice/status/123',targetUrl:kind==='null-preview'?null:'https://x.com/bob/status/456'}]:[],
  articlePreviewInventory:{scope:'collection' as const,observed:preview||kind==='omitted'?1:0,retained:preview?1:0,omitted:kind==='omitted'?1:0,unresolved:kind==='unresolved'?1:0}};
 if(kind==='bare-preview')delete (protectedHistory as {articlePreviewInventory?:unknown}).articlePreviewInventory;
 row.postObservations=[{...structuredClone(row.posts[0]),observationId:'optional-first'},protectedHistory];
 row.postObservationsOmitted=9;
 const reason=preview?/needs an accurate entry read/:/inventory is unknown/;
 expect(guard(raw)).toThrow(reason);
 const before=structuredClone(raw),out=serializeXResearchResult(raw),shell=out.result.queries[0].postObservations!.find(p=>p.observationId==='protected-last');
 expect(shell).toEqual({...protectedHistory,text:''});
 expect(out.result.queries[0].posts).toEqual(raw.queries[0].posts);
 expect(out.result.queries[0].postObservationsOmitted).toBe(10);
 expect(guard(out.result)).toThrow(reason);
 const qualified=await readX({tabId:'research-tab',read:{objective:'resolve',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:true,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:3}},(await stagedFixture({article:'ok'})).context);
 const resolved=new XResearchEvidence('/tmp',()=> 'run');resolved.observe(read);resolved.observe(out.result);expect(()=>resolved.guard('/tmp/report.md',cite)).toThrow(reason);
 resolved.observe(qualified);expect(resolved.guard('/tmp/report.md',cite)).toBeUndefined();
 const wholeDrop=structuredClone(out.result);wholeDrop.queries[0].postObservations=[];expect(guard(wholeDrop)()).toBeUndefined();
 for(const flip of ['source','author','parent'] as const){
  const invalid=structuredClone(out.result),p=invalid.queries[0].postObservations!.find(p=>p.observationId==='protected-last')!;
  if(flip==='source')p.sourceUrl=null;else if(flip==='author')p.author!.handle='wrong';else p.postId='999';
  expect(guard(invalid)()).toBeUndefined();
 }
 expect(raw).toEqual(before);
 expect(JSON.parse(out.text).queries[0].postObservations).toContainEqual(expect.objectContaining({observationId:'protected-last',text:'',articlePreviews:protectedHistory.articlePreviews,...(protectedHistory.articlePreviewInventory?{articlePreviewInventory:protectedHistory.articlePreviewInventory}:{})}));
 expect(out.result.budgetUsage.outputBytes).toBe(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)),'utf8'));
 expect(out.result.budgetUsage.outputBytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
 expect(serializeXResearchResult(out.result)).toEqual(out);
},60000);

describe('bounded X production tool result',()=>{
 it('keeps a protected history obligation when its primary is omitted and another query retains that parent',async()=>{
  const raw=await searchX(searchInput,fixture([searchHtml(post())]).context),first=raw.queries[0];first.postObservations=[];
  const second=structuredClone(first);second.query.id='second';raw.queries.push(second);
  const base=first.posts[0];
  const priorRead=await readX({tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post())]).context);
  const guard=(value:typeof raw)=>{const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(priorRead);ledger.observe(value);return ()=>ledger.guard('/tmp/report.md','[source](https://x.com/alice/status/123)');};
  expect(guard(raw)()).toBeUndefined();
  first.posts[0].articlePreviews=Array.from({length:300},(_,i)=>({entryObservationId:`large-entry-${i}`,parentPostId:'123',sourceUrl:base.sourceUrl!,targetUrl:'https://x.com/bob/status/456'}));
  first.posts[0].articlePreviewInventory={scope:'collection',observed:300,retained:300,omitted:0,unresolved:0};
  first.postObservations=[{...structuredClone(second.posts[0]),observationId:'last-gap',text:'',truncation:{returned:0,totalKnown:20,truncated:true},articlePreviewInventory:{scope:'collection',observed:0,retained:0,omitted:0,unresolved:1}}];
  const baseline=serializeXResearchResult(raw);expect(baseline.result.queries[0].posts).toHaveLength(1);expect(guard(baseline.result)).toThrow(/inventory is unknown/);
  const out=serializeXResearchResult({...raw,objective:'x'.repeat(1020000)});
  expect(out.result.queries[0].posts).toHaveLength(0);expect(out.result.queries[1].posts).toHaveLength(1);
  expect(out.result.queries[0].postObservations).toEqual(first.postObservations);
  expect(guard(out.result)).toThrow(/inventory is unknown/);
  const unsafe=structuredClone(out.result);unsafe.queries[0].postObservations=[];expect(guard(unsafe)()).toBeUndefined();
  expect(out.result.budgetUsage.outputBytes).toBe(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)),'utf8'));
  expect(out.result.budgetUsage.outputBytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
 });
  it('keeps actual unchanged-body read reasons distinct from page text and absent reasons',async()=>{
    const bodyFixture=await stagedFixture({noEffect:true});
    const body=await readX({tabId:'tab',read:{objective:'body',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:true,maxRepliesPerPost:10,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},bodyFixture.context);
    for(const [actual,reason] of [[body,'reply_budget_reached']] as const){
      expect(actual.targets[0]).toMatchObject({status:'partial',stopReason:'budget_reached',reason});
      const controls=readResult({tabId:'tab',read:{objective:'controls',targets:[{postId:'999'},{postId:'998'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post())]).context);
      controls.targets[0].reason='登录页面说请重试';
      controls.targets[1].reason=null;
      const result={...actual,targets:[actual.targets[0],...controls.targets]};
      const expected={version:1,operation:'read',reasonSource:'reason',totalRows:3,statusCounts:{partial:1,failed:2},stopReasonCounts:{budget_reached:1,agent_stopped:2},reasonCounts:{[reason]:1,unknown:2},replyScopeCounts:{unknown:3}};
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
    expect(capped.result.truncation).toEqual(result.truncation);
    expect(capped.result.delivery?.truncated).toBe(true);
    expect(capped.result.queries[0].posts[0].truncation).toEqual(original.truncation);
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
    expect(value.result.delivery?.truncated).toBe(true);
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
 expect(out.result.queries[0].posts.length).toBeGreaterThan(0);expect(out.result.queries[0].posts.length).toBeLessThan(100);expect(out.result.delivery?.truncated).toBe(true);
 for(const p of out.result.queries[0].posts)expect(p.articlePreviews).toEqual(previews);for(const p of model.queries[0].posts)expect(p.articlePreviews).toEqual(previews);
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)))).toBe(out.result.budgetUsage.outputBytes);expect(out.result.budgetUsage.outputBytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
});

it('bounds modern protected history through artifact coverage while preserving legacy rejection and read audit gaps',async()=>{
 const card=(id:string)=>`<div role="link" tabindex="0" href="https://x.com/bob/status/${id}"><div data-testid="User-Name"><a href="/bob">bob</a><a href="/bob">@bob</a></div><img data-testid="article-cover-image"></div>`;
 const posts=Array.from({length:60},(_,i)=>post(String(1000+i),'alice').replace('</article>',card(String(2000+i)).repeat(i<30?0:3)+'</article>')).join('');
 const search=await searchX({search:{...searchInput.search,maxPostsPerQuery:100}},fixture([searchHtml(posts),searchHtml(posts)]).context);
 // Exact duplicated-container observations are real independently collected frames.
 expect(search.queries[0].postObservations!.length).toBeGreaterThan(0);
 expect(serializeXResearchResult(search).result.queries[0].posts).toHaveLength(60);
 search.objective='a'.repeat(1010000);
 const oldHistory=structuredClone(search);for(const row of oldHistory.queries)delete row.collectionStop;
 expect(()=>serializeXResearchResult(oldHistory)).toThrow(/required-state envelope/);
 const bounded=serializeXResearchResult(search);
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(bounded)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
 expect(bounded.result.delivery!.articleObligationCoverage).toBe('not_inline');
 expect(bounded.result.delivery!.omittedFields).toContain('queries.0.postObservations');
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
  expect(capped.result.delivery?.truncated).toBe(true);
  expect(saved.root).toEqual(root);
  const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(capped.result);
  // A later ordinary body supplies citable text but cannot erase the retained Article obligation.
  ledger.observe(plain.result);
  expect(()=>ledger.guard('/tmp/report.md','[root](https://x.com/alice/status/123)')).toThrow(/Article/);
  expect(serializeXResearchResult(capped.result)).toEqual(capped);
});

it('budgets independent bodies before scoped history and protects every own-parent preview gap',async()=>{
  const cover='<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/writer">@writer</a></div><div data-testid="article-cover-image">Article</div></div>';
  const html=Array.from({length:100},(_,i)=>post(String(1000+i),'b',('汉\\"😀').repeat(500)).replace('</article>',cover+'</article>')).join('');
  const input={tabId:'tab',read:{objective:'budget',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:true,maxRepliesPerPost:101,maxScrollsPerPost:1,maxExpandActionsPerPost:0}};
  const actual=await readX(input,fixture([readHtml(post()+post('222','c','retained history')),readHtml(html)],{unscopedAfterIndex:1}).context);
  expect(actual.targets[0].unscopedPosts?.observations).toHaveLength(100);
  expect(actual.targets[0].unscopedPosts?.previewGaps).toHaveLength(100);
  for(const count of [1,20]){
    const source=structuredClone(actual);source.targets=Array.from({length:count},()=>structuredClone(actual.targets[0]));
    const out=serializeXResearchResult(source),bytes=Buffer.byteLength(JSON.stringify(xResearchToolResult(out)),'utf8');
    expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(out.result.budgetUsage.outputBytes).toBe(bytes);
    const projected=JSON.parse(out.text);
    for(const [index,row] of out.result.targets.entries()){
      expect(row.root?.text).toBe('original');expect(row.replies.observations[0].text).toBe('retained history');
      expect(row.unscopedPosts?.previewGaps).toEqual(source.targets[index].unscopedPosts?.previewGaps);
      expect(projected.targets[index].unscopedPosts.previewGaps).toEqual(row.unscopedPosts?.previewGaps);
      expect(row.unscopedPosts!.inventory.retained+row.unscopedPosts!.inventory.omitted).toBe(100);
      expect(row.unscopedPosts!.inventory).toEqual(source.targets[index].unscopedPosts!.inventory);
      expect(row.budgetUsage.distinctEntries).toBe(source.targets[index].budgetUsage.distinctEntries);
      expect(row).toMatchObject({reason:'reply_budget_reached',stopReason:'budget_reached'});
      for(const p of row.unscopedPosts!.observations)expect(p).toMatchObject({relationToTarget:'unproven',observedContainer:'post'});
    }
    const ledger=new XResearchEvidence('/tmp',()=> 'run');
    const old=await readX({...input,read:{...input.read,targets:[{url:'https://x.com/b/status/1099'}],includeReplies:false,maxScrollsPerPost:0}},fixture([readHtml(post('1099','b','older own body'))]).context);
    ledger.observe(old);expect(ledger.guard('/tmp/report.md','[source](https://x.com/b/status/1099)')).toBeUndefined();
    ledger.observe(out.result);expect(()=>ledger.guard('/tmp/report.md','[source](https://x.com/b/status/1099)')).toThrow(/inventory is unknown/);
    expect(serializeXResearchResult(out.result)).toEqual(out);
  }
  expect(()=>serializeXResearchResult({...actual,objective:'x'.repeat(X_RESEARCH_MAX_OUTPUT_BYTES)})).toThrow(/required-state envelope/);
});

it('preserves and validates three source inventories and names whole-inventory UTF8 budget omissions',async()=>{
  const labels='<div role="status">'+ '文'.repeat(512)+'</div>';
  const input={tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}};
  const result=await readX(input,fixture([readHtml(post()+labels.repeat(32))]).context);
  const out=serializeXResearchResult(result),diagnostics=out.result.targets[0].diagnostics!;
  expect(diagnostics.initialFrame?.replyUiInventory?.capture).toMatchObject({state:'checked',returned:32});
  expect(JSON.parse(out.text).targets[0].diagnostics).toEqual(diagnostics);
  const bad=structuredClone(result);bad.targets[0].diagnostics!.terminalFrame=structuredClone(result.targets[0].diagnostics!.terminalFrame);
  bad.targets[0].diagnostics!.terminalFrame!.replyUiInventory!.capture={state:'checked'} as never;
  expect(()=>serializeXResearchResult(bad)).toThrow();
  const capped=serializeXResearchResult({...result,objective:'x'.repeat(850000)});
  const paths=capped.result.metadataOmissions??[];
  expect(paths).toContain('targets.0.diagnostics.initialFrame.replyUiInventory');
  expect(capped.result.targets[0].diagnostics?.initialFrame?.sourceEndDetector).toBe('not_implemented');
  expect(capped.result.targets[0].diagnostics?.initialFrame?.replyUiInventory).toBeUndefined();
  for(const key of ['initialFrame','firstAdmittedFrame','terminalFrame'] as const){
    if(!capped.result.targets[0].diagnostics?.[key]?.replyUiInventory) expect(paths).toContain(`targets.0.diagnostics.${key}.replyUiInventory`);
  }
  expect(JSON.parse(capped.text).metadataOmissions).toEqual(paths);
  expect(JSON.parse(capped.text).targets[0].diagnostics).toEqual(capped.result.targets[0].diagnostics);
  expect(capped.result.budgetUsage.outputBytes).toBe(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)),'utf8'));
  expect(capped.result.budgetUsage.outputBytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
  expect(serializeXResearchResult(capped.result)).toEqual(capped);
});


it('carries distinct initial admitted terminal collections through content and canonical details',async()=>{
  const options={afterWaitIndex:1};
  const f=fixture([readHtml('<h2>initial without root</h2>'),readHtml(post()+'<div role="status">admitted literal</div>'),readHtml(post()+'<button>terminal End of conversation</button>')],options);
  const input={tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}};
  const result=readResult(input,f.context),row=result.targets[0],stage:XReadStage={current:'navigation',actionIndex:0,attemptedControls:new Set()};
  await f.open('https://x.com/alice/status/123','tab');
  const request={stage:'post' as const,postId:'123',expectedUrl:'https://x.com/alice/status/123'};
  const initial=await collectPostFrame(f.page,request,row,stage,f.context);
  await f.page.wait({selector:'[data-testid="tweet"]',state:'present'},1000);
  const admitted=await collectPostFrame(f.page,request,row,stage,f.context);
  expect(savePostFrame(row,admitted,input.read,f.context)).toBe(true);
  options.afterWaitIndex=2;await f.page.wait({selector:'[data-testid="tweet"]',state:'present'},1000);
  const terminal=await collectPostFrame(f.page,request,row,stage,f.context);
  expect(savePostFrame(row,terminal,input.read,f.context)).toBe(true);
  result.sourceKind='page_graphql';
  const out=serializeXResearchResult(result),tool=xResearchToolResult(out);
  const frames=out.result.targets[0].diagnostics!;
  expect([frames.initialFrame?.snapshotId,frames.firstAdmittedFrame?.snapshotId,frames.terminalFrame?.snapshotId]).toEqual([initial.snapshot.snapshotId,admitted.snapshot.snapshotId,terminal.snapshot.snapshotId]);
  expect(new Set([initial.snapshot.snapshotId,admitted.snapshot.snapshotId,terminal.snapshot.snapshotId]).size).toBe(3);
  expect([frames.initialFrame,frames.firstAdmittedFrame,frames.terminalFrame].map(frame=>frame?.replyUiInventory?.capture)).toMatchObject([
    {nodes:[{text:'initial without root'}]},{nodes:[{text:'admitted literal'}]},{nodes:[{text:'terminal End of conversation'}]},
  ]);
  expect(JSON.parse(tool.content[0].text).targets[0].diagnostics).toEqual(frames);
  if(tool.details.operation!=='read')throw new Error('read result required');
  expect(tool.details.targets[0].diagnostics).toEqual(frames);
  const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(out.result);
  expect(ledger.guard('/tmp/x-research-diagnostics-2026-10-12.md','[source](https://x.com/alice/status/123)')).toEqual({createOnly:true});
  expect(admitted.diagnosticFrame?.rootIdentityProven).toBe(true);
  expect(initial.diagnosticFrame?.rootIdentityProven).toBe(false);
  expect(terminal.replyScope).toEqual(admitted.replyScope);
  expect(row.replies.scope.extent).toBe('unknown');
});

it('delivery trimming keeps collection facts, source truncation and scope/run aggregates intact',async()=>{
 const raw=await searchX(searchInput,fixture([searchHtml(post())]).context),row=raw.queries[0];
 row.status='observed';row.stopReason='agent_stopped';raw.status='observed';
 row.collectionStop={status:'observed',stopReason:'agent_stopped',reason:null};
 row.budgetBinding=[{dimension:'posts',used:1,limit:500,origin:'default'}];
 row.postObservations=Array.from({length:100},(_,i)=>({...structuredClone(row.posts[0]),observationId:`history-${i}`,text:'历史'.repeat(4000),truncation:{returned:8000,totalKnown:8000,truncated:false}}));
 raw.truncation={returned:800008,totalKnown:800008,truncated:false};
 row.budgetUsage.distinctEntries=41;raw.budgetUsage.distinctEntries=41;
 const ledger=new XResearchScopeLedger();ledger.observe({...raw,callId:'prior'});
 const out=serializeXResearchResult(raw,ledger.prior(raw.runId));
 expect(out.result.delivery).toMatchObject({truncated:true,omittedObservations:expect.any(Number)});
 expect(out.result.delivery!.omittedObservations).toBeGreaterThan(0);
 expect(out.result.delivery!.omittedFields).toContain('queries.0.postObservations');
 expect(out.result).toMatchObject({status:'observed',truncation:raw.truncation,budgetUsage:{distinctEntries:41},reportScopeFacts:{statusCounts:{observed:1},stopReasonCounts:{agent_stopped:1}},reportRunScopeFacts:{callCount:2,search:{statusCounts:{observed:2}}}});
 expect(out.result.queries[0]).toMatchObject({status:'observed',stopReason:'agent_stopped',collectionStop:row.collectionStop,budgetBinding:row.budgetBinding,budgetUsage:{distinctEntries:41}});
 expect(out.result.queries[0].posts[0].truncation).toEqual(row.posts[0].truncation);
 expect(JSON.parse(out.text)).toMatchObject({delivery:out.result.delivery,queries:[{collectionStop:row.collectionStop,budgetBinding:row.budgetBinding}]});
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)))).toBeLessThanOrEqual(1048576);
});

it('admission reserves artifact and delivery metadata before collection reaches the envelope boundary',()=>{
 const raw=searchResult(searchInput,fixture([]).context);
 raw.objective='x'.repeat(1040000);
 expect(()=>assertXRequestFits({...raw,objective:'research'})).not.toThrow();
 expect(()=>assertXRequestFits(raw)).toThrow('required-state envelope');
});

it('marks obligation coverage inline when omitted bodies carry no Article obligations',async()=>{
 const raw=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},fixture([searchHtml(post())]).context);
 raw.objective='x'.repeat(900000);
 raw.queries[0].posts=Array.from({length:500},(_,i)=>({...structuredClone(raw.queries[0].posts[0]),observationId:`plain-${i}`}));
 const projected=serializeXResearchResult(raw).result;
 expect(projected.delivery!.omittedObservations).toBeGreaterThan(0);
 expect(projected.delivery!.articleObligationCoverage).toBe('inline');
 expect(projected.delivery!.omittedFields).toContain('queries.0.posts');
});

it('keeps pre-artifact v2 delivery interpretation for historical results without collectionStop',async()=>{
 const raw=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},fixture([searchHtml(post())]).context);
 delete raw.queries[0].collectionStop;
 raw.queries[0].posts[0].text='汉'.repeat(300000);
 raw.queries[0].posts[0].truncation={returned:300000,totalKnown:300000,truncated:false};
 const projected=serializeXResearchResult(raw).result;
 expect(projected.truncation).toMatchObject({truncated:true,totalKnown:300000});
 expect(projected.queries[0].posts[0].truncation.truncated).toBe(true);
 expect(projected.queries[0].posts[0].text.length).toBeLessThan(300000);
 // The same body under a modern collection preserves source truncation instead.
 raw.queries[0].collectionStop={status:raw.queries[0].status,stopReason:raw.queries[0].stopReason,reason:null};
 expect(serializeXResearchResult(raw).result.delivery?.truncated).toBe(true);
 expect(projected.delivery).toBeUndefined();
});
