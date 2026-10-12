import { describe, expect, it } from 'vitest';
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
    expect(result).toMatchObject({status:'auth_required',browserTabId:'research-tab',queries:[{status:'auth_required',stopReason:'access_barrier'},{query:{id:'untouched'},stopReason:'agent_stopped'}]});
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
