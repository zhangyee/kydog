import { BrowserScrollAcknowledgementError } from '../browser/actions';
import { describe, expect, it, vi } from 'vitest';
import { KydogError } from '../../shared/errors';
import { fixture, post, query, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { searchX } from './xResearchSearch';

describe('X search orchestration',()=>{
  it('searchRequiresCurrentQueryAndProduct',async()=>{
    const good=fixture([searchHtml(post())]);
    expect((await searchX(searchInput,good.context)).queries[0].posts[0].postId).toBe('123');
    for(const change of [(u:string)=>u.replace('scientific+agents','different'),(u:string)=>u.replace('f=live','f=top'),(u:string)=>u.replace('x.com','other.example')]) {
      const f=fixture([searchHtml(post())],{finalUrl:change});
      const result=await searchX(searchInput,f.context);
      expect(result.queries[0]).toMatchObject({posts:[],status:'partial',stopReason:'identity_unproven'});
    }
    expect((await searchX(searchInput,fixture([searchHtml(post(),'Top')]).context)).queries[0].posts).toEqual([]);
  });
  it('emptyDomIsNotExplicitEmpty',async()=>{
    const empty='<div data-testid="emptyState"><div data-testid="empty_state_header_text">No results for scientific agents</div><div data-testid="empty_state_body_text">Try again</div></div>';
    expect((await searchX(searchInput,fixture([searchHtml(empty)]).context)).queries[0].status).toBe('explicit_empty');
    expect((await searchX(searchInput,fixture([searchHtml('')]).context)).queries[0]).toMatchObject({status:'partial',stopReason:'budget_reached'});
    expect((await searchX(searchInput,fixture([searchHtml('')],{wait:false}).context)).queries[0]).toMatchObject({status:'failed',stopReason:'wait_timeout'});
  });
  it('collectsBeforeVirtualListReplacement and retains each source provenance',async()=>{
    const f=fixture([searchHtml(post('123')+post('456','bob')),searchHtml(post('456','bob')+post('789','carol'))]);
    const result=await searchX(searchInput,f.context);
    expect(result.queries[0].posts.map(p=>[p.postId,p.text])).toEqual([['123','original'],['456','original'],['789','original']]);
    expect(result.queries[0].budgetUsage).toMatchObject({scrolls:1,distinctEntries:3});
    expect(f.context.sources.get('123')![0]).toMatchObject({urlKind:'permalink',purpose:query.purpose,product:'Latest'});
    const next={...f.context,batchId:'second'};
    await searchX({search:{...searchInput.search,queries:[{...query,id:'other',query:'new query'}]}},next);
    expect(next.sources.get('123')!.map(s=>[s.sourceUrl,s.batchId,s.queryId])).toEqual([['https://x.com/alice/status/123','batch','q2'],['https://x.com/alice/status/123','second','other']]);
  });
  it('waits for actual rendered entries, then recollects; auth after timeout has priority',async()=>{
    const f=fixture([searchHtml(''),searchHtml(post())],{afterWaitIndex:1});
    const result=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},f.context);
    expect(result.queries[0].posts[0].postId).toBe('123');
    expect(f.page.wait).toHaveBeenCalledWith(expect.objectContaining({selector:expect.stringContaining('tweet')}),8000);
    const auth='<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input name="password" type="password"></div>';
    const protectedPage=fixture([searchHtml(''),auth],{afterWaitIndex:1,wait:false,finalUrl:()=> 'https://x.com/i/jf/onboarding/web'});
    expect((await searchX(searchInput,protectedPage.context)).queries[0]).toMatchObject({status:'auth_required',stopReason:'access_barrier'});
  });
  it('prioritizes actual auth/cancellation and retains untouched requested rows',async()=>{
    const good=fixture([searchHtml(post())]);expect((await searchX(searchInput,good.context)).queries[0].posts[0].text).toBe('original');
    const auth='<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input name="password" type="password"></div>';
    const f=fixture([auth],{finalUrl:()=> 'https://x.com/i/jf/onboarding/web'});
    const input={search:{...searchInput.search,queries:[query,{...query,id:'untouched'}]}};
    const result=await searchX(input,f.context);
    expect(result).toMatchObject({status:'auth_required',browserTabId:'research-tab',queries:[{status:'auth_required',stopReason:'access_barrier'},{query:{id:'untouched'},status:'auth_required',stopReason:'access_barrier',barrier:{reason:'not_attempted:auth_required'}}]});
    expect(f.open).toHaveBeenCalledTimes(1);
    const controller=new AbortController();controller.abort();
    const cancelled=await searchX(input,{...f.context,signal:controller.signal});
    expect(cancelled.status).toBe('cancelled');expect(f.open).toHaveBeenCalledTimes(1);
  });
  it('allows one fresh collection only after authoritative same-URL generation change',async()=>{
    const f=fixture([searchHtml(post())]);
    f.collect.mockImplementationOnce(async()=>{f.navigate();throw new KydogError('browser.stale_snapshot','route changed');});
    const result=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},f.context);
    expect(result.queries[0].posts[0].postId).toBe('123');
    expect(result.queries[0].collectionTransitions).toMatchObject([{rereadRequested:true,outcome:'same_url_generation_changed',before:{routeRevision:7},after:{routeRevision:8}}]);
    expect(f.collect).toHaveBeenCalledTimes(2);expect(f.act).toHaveBeenCalledTimes(0);
    for(const next of ['https://x.com/search?q=wrong&f=live','https://x.com/bob/status/123']) {
      const wrong=fixture([searchHtml(post())]);wrong.collect.mockImplementationOnce(async()=>{wrong.navigate(next);throw new KydogError('browser.stale_snapshot','route changed');});
      expect((await searchX(searchInput,wrong.context)).queries[0]).toMatchObject({posts:[],stopReason:'identity_unproven',collectionTransitions:[{rereadRequested:false,outcome:'route_changed'}]});
      expect(wrong.collect).toHaveBeenCalledTimes(1);expect(wrong.act).toHaveBeenCalledTimes(0);
    }
    const repeated=fixture([searchHtml(post())]);repeated.collect.mockImplementation(async()=>{repeated.navigate();throw new KydogError('browser.stale_snapshot','route changed');});
    expect((await searchX(searchInput,repeated.context)).queries[0]).toMatchObject({posts:[],stopReason:'identity_unproven'});expect(repeated.collect).toHaveBeenCalledTimes(2);
    const aborter=new AbortController(),cancel=fixture([searchHtml(post())]);cancel.collect.mockImplementationOnce(async()=>{cancel.navigate();aborter.abort();throw new KydogError('browser.stale_snapshot','route changed');});
    expect((await searchX(searchInput,{...cancel.context,signal:aborter.signal})).status).toBe('cancelled');expect(cancel.collect).toHaveBeenCalledTimes(1);
  });
  it('counts executed scrolls only, preserves data and stops call on adapter error',async()=>{
    const valid=fixture([searchHtml(post())]);
    expect((await searchX(searchInput,valid.context)).budgetUsage.scrolls).toBe(1);
    const f=fixture([searchHtml(post())],{scrollError:new KydogError('browser.target_unusable','blocked')});
    expect((await searchX(searchInput,f.context)).queries[0]).toMatchObject({posts:[{postId:'123'}],status:'partial',stopReason:'action_failed',budgetUsage:{scrolls:0}});
    const broken=fixture([searchHtml(post())],{collectErrorAt:1});
    const result=await searchX({search:{...searchInput.search,queries:[query,{...query,id:'later'}]}},broken.context);
    expect(result.queries).toMatchObject([{posts:[{postId:'123'}],stopReason:'action_failed'},{posts:[],status:'failed',stopReason:'agent_stopped'}]);
    expect(broken.open).toHaveBeenCalledTimes(1);
  });
});

it('scroll receipt alone never admits the old DOM as a new frame; written ACK failure preserves evidence',async()=>{
 for(const fail of [false,true]){
  const f=fixture([searchHtml(post('123')),searchHtml(post('456','bob'))]);
  const original=f.act.getMockImplementation()!;
  f.act.mockImplementation(async(action,snapshot,options)=>{
   expect(options?.scrollAcknowledgement).toBeDefined();
   if(fail){options!.scrollAcknowledgement!.onWritten();throw new BrowserScrollAcknowledgementError('scroll_ack_timeout','no frame');}
   return original(action,snapshot,options);
  });
  const r=await searchX(searchInput,f.context);
  expect(r.queries[0].posts.map(p=>p.postId)).toEqual(fail?['123']:['123','456']);
  expect(r.queries[0]).toMatchObject({budgetUsage:{scrolls:1},stopReason:fail?'wait_timeout':'budget_reached'});
  if(fail)expect(r.queries[0].barrier?.reason).toBe('scroll_ack_timeout');
 }
});

it('preserves every Article preview on its exact collected parent container, never the duplicate ID container',async()=>{
 const card=(id:string)=>`<div role="link" tabindex="0" href="https://x.com/bob/status/${id}"><div data-testid="User-Name"><a href="/bob">bob</a><a href="/bob">@bob</a></div><img data-testid="article-cover-image"></div>`;
 const a=post('123','alice','first body').replace('</article>',card('456')+card('789')+'</article>');
 const b=post('123','alice','duplicate body');
 const f=fixture([searchHtml(a+b)]);
 const r=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},f.context);
 expect(r.queries[0].posts[0].articlePreviews?.map(e=>e.targetUrl)).toEqual(['https://x.com/bob/status/456','https://x.com/bob/status/789']);
 const collected=await f.collect({stage:'search',expectedUrl:'https://x.com/search?q=scientific+agents&f=live',query:query.query,product:'Latest'});
 expect(collected.entryParents.get(collected.entries[0])).toBe(collected.posts[0]);
 expect(collected.entryParents.get(collected.entries[0])).not.toBe(collected.posts[1]);
 expect(JSON.stringify(r)).not.toContain('entryParents');
});

it('retains source ACKs per issued attempt, independently of writes and repeated callbacks',async()=>{
 vi.useFakeTimers();try{
 for(const mode of ['success','no_movement','timeout','invalidated','cancelled','unwritten'] as const){
  const f=fixture([searchHtml(post())]);let attempts=0;const snapshots:string[]=[];
  f.act.mockImplementation(async(_action,snapshot,options)=>{
   attempts++;const snap=snapshot as import('../browser/snapshot').AxSnapshot;snapshots.push(snap.snapshotId);
   if(mode==='unwritten'&&attempts===3)throw new KydogError('browser.stale_snapshot','before write');
   const ack=options!.scrollAcknowledgement!;ack.onWritten();const terminal=attempts===3&&mode!=='success';
   const receipt={generation:snap.generation,targetKind:'element' as const,targetNodeId:70+attempts,targetContainsHit:true,conversationRelation:'unknown' as const,rootRelation:'unknown' as const,before:17+attempts,after:terminal?17+attempts:617+attempts,scrollHeight:2700,clientHeight:601,written:true,eventObserved:!terminal,frameObserved:!terminal,state:terminal?(mode==='no_movement'?'no_movement':mode==='invalidated'?'invalidated':'expired'):'frame_observed'} as import('../browser/actions').BrowserScrollReceipt;
   ack.onReceipt?.({...receipt,state:'pending',eventObserved:false,frameObserved:false});ack.onReceipt?.(receipt);
   if(terminal)throw mode==='cancelled'?new KydogError('browser.cancelled','cancelled'):new BrowserScrollAcknowledgementError(mode==='no_movement'?'scroll_no_movement':'scroll_ack_timeout','terminal');
   return {action:_action,line:'done',navigation:null};
  });
  const pending=searchX({search:{...searchInput.search,maxScrollsPerQuery:3}},f.context);await vi.runAllTimersAsync();const row=(await pending).queries[0];
  expect(row.diagnostics?.scroll,mode).toMatchObject({totalAttempts:3,omittedAttempts:1,first:{actionIndex:1,snapshotId:snapshots[0],targetNodeId:71,before:18,after:618,state:'frame_observed'},last:{actionIndex:mode==='unwritten'?2:3,snapshotId:snapshots[mode==='unwritten'?1:2],targetNodeId:mode==='unwritten'?72:73}});
  expect(row.budgetUsage.scrolls).toBe(mode==='unwritten'?2:3);
  expect(row.diagnostics?.scroll?.last?.generation).toBeTruthy();
  expect(row.diagnostics?.scroll?.last?.location).toMatchObject({origin:'https://x.com',path:'/search',q:'scientific agents',f:'live'});
  expect(row.diagnostics?.scroll?.last?.state).toBe(mode==='unwritten'||mode==='success'?'frame_observed':mode==='no_movement'?'no_movement':mode==='invalidated'?'invalidated':'expired');
 }
 }finally{vi.useRealTimers();}
});
