import { BrowserScrollAcknowledgementError } from '../browser/actions';
import { KydogError } from '../../shared/errors';
import { describe, expect, it, vi } from 'vitest';
import { fixture, stagedFixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { searchX } from './xResearchSearch';
import { readX } from './xResearchRead';
const read=(targets:any[],extra={})=>({tabId:'research-tab',read:{objective:'read',targets,includeArticle:false,includeReplies:false,maxRepliesPerPost:30,maxScrollsPerPost:0,maxExpandActionsPerPost:0,...extra}});
describe('ordinary X read orchestration',()=>{
  it('readUsesObservedPermalink; unresolved postId never generates URL',async()=>{
    const f=fixture([searchHtml(post())]); await searchX(searchInput,f.context);
    const reader=fixture([readHtml(post())]); reader.context.sources=f.context.sources;
    expect((await readX(read([{postId:'123'}]),reader.context)).targets[0]).toMatchObject({root:{text:'original'},sourceUrl:'https://x.com/alice/status/123',status:'observed'});
    const result=await readX(read([{postId:'999'}]),reader.context);
    expect(result.targets[0]).toMatchObject({status:'failed',reason:'unresolved_target',root:null});
    expect(reader.open).toHaveBeenCalledTimes(1);
  });
  it('normalization requires final origin, post identity and own root together',async()=>{
    const target={url:'https://twitter.com/old/status/123'};
    const good=fixture([readHtml(post())],{finalUrl:()=> 'https://x.com/alice/status/123'});
    expect((await readX(read([target]),good.context)).targets[0].root?.text).toBe('original');
    for(const [url,html] of [['https://other.example/alice/status/123',readHtml(post())],['https://x.com/alice/status/456',readHtml(post())],['https://x.com/alice/status/123',readHtml(post('123','bob'))],['https://x.com/alice/status/123',searchHtml(post())]]) {
      const result=await readX(read([target]),fixture([html],{finalUrl:()=>url}).context);
      expect(result.targets[0]).toMatchObject({root:null,status:'partial',stopReason:'identity_unproven'});
    }
  });
  it('all 20 explicit targets retained and later stages are truthful partial',async()=>{
    const targets=Array.from({length:20},()=>({url:'https://x.com/alice/status/123'}));
    const f=fixture([readHtml(post()+post('456','bob','rendered discussion'))]);
    const result=await readX(read(targets,{includeArticle:true,includeReplies:true,maxScrollsPerPost:2}),f.context);
    expect(result.targets).toHaveLength(20); expect(f.open).toHaveBeenCalledTimes(20);
    expect(result.targets[0]).toMatchObject({status:'partial',article:{requested:true,actionAttempted:false,bodyObserved:false},replies:{requested:true,scope:{completeness:'unknown'}},reason:'no_entry_observed'});
  });
  it('waits for absent collected content without treating it as identity success',async()=>{
    const f=fixture([readHtml(''),readHtml(post())],{afterWaitIndex:1});
    expect((await readX(read([{url:'https://x.com/alice/status/123'}]),f.context)).targets[0].root?.text).toBe('original');
    expect(f.page.wait).toHaveBeenCalledTimes(1);
    const wrong=fixture([readHtml(post('123','bob')),readHtml(post())],{afterWaitIndex:1});
    expect((await readX(read([{url:'https://x.com/alice/status/123'}]),wrong.context)).targets[0].stopReason).toBe('identity_unproven');
    expect(wrong.page.wait).toHaveBeenCalledTimes(0);
  });
  it('unsafe explicit URL safely fails one target without echoing sensitive coordinates',async()=>{
    const f=fixture([readHtml(post())]);
    const good=await readX(read([{url:'https://x.com/alice/status/123'}]),f.context);
    expect(good.targets[0]).toMatchObject({inputKind:'url',inputUrlRedacted:false,inputUrl:'https://x.com/alice/status/123',root:{text:'original'}});
    const mixed=await readX(read([{url:'https://x.com/alice/status/123?token=secret#private'},{url:'https://x.com/alice/status/123'}]),f.context);
    expect(mixed.targets[0]).toMatchObject({target:{postId:'123'},inputKind:'url',inputUrlRedacted:true,inputUrl:null,status:'failed',reason:'unsafe_target_url',root:null,sourceUrl:null,stopReason:'identity_unproven',location:{requested:{redacted:true},committed:null,subsequent:null}});
    expect(mixed.targets[1].root?.text).toBe('original');
    expect(mixed.targets[0].location?.requested).toEqual({origin:'https://x.com',path:'/alice/status/123',q:null,f:null,fragment:null,redacted:true});
    expect(f.open).toHaveBeenCalledTimes(2);
  });
  it('serializes actual document provenance paired with root and resolves newest document literally',async()=>{
    const f=fixture([readHtml(post().replace('/status/123"','/status/123/history"'))]);
    const result=await readX(read([{url:'https://x.com/alice/status/123'}]),f.context);
    expect(result.targets[0].documentSource).toMatchObject({urlKind:'document',sourceUrl:'https://x.com/alice/status/123',rootObservationId:result.targets[0].root!.observationId});
    expect(f.context.sources.get('123')!.map(s=>[s.urlKind,s.sourceUrl])).toEqual([['permalink','https://x.com/alice/status/123/history'],['document','https://x.com/alice/status/123']]);
    await readX(read([{postId:'123'}]),f.context);expect(f.open.mock.calls[1][0]).toBe('https://x.com/alice/status/123');
    const sensitive=fixture([readHtml(post())],{finalUrl:()=> 'https://x.com/alice/status/123?token=secret'});
    expect((await readX(read([{url:'https://x.com/alice/status/123'}]),sensitive.context)).targets[0].documentSource).toBeNull();
    expect(sensitive.context.sources.get('123')!.map(s=>s.urlKind)).toEqual(['permalink']);
  });
  it('same-URL root freshness recollects but different author/path is refused',async()=>{
    const f=fixture([readHtml(post())]);f.collect.mockImplementationOnce(async()=>{f.navigate();throw new KydogError('browser.stale_snapshot','route changed');});
    expect((await readX(read([{url:'https://x.com/alice/status/123'}]),f.context)).targets[0].root?.text).toBe('original');
    const wrong=fixture([readHtml(post('123','bob'))]);wrong.collect.mockImplementationOnce(async()=>{wrong.navigate('https://x.com/bob/status/123');throw new KydogError('browser.stale_snapshot','route changed');});
    expect((await readX(read([{url:'https://x.com/alice/status/123'}]),wrong.context)).targets[0]).toMatchObject({root:null,stopReason:'identity_unproven'});expect(wrong.collect).toHaveBeenCalledTimes(1);
  });
  it('history source is navigated literally, never stripped or old versions admitted',async()=>{
    const f=fixture([searchHtml(post().replace('/status/123"','/status/123/history"'))]); await searchX(searchInput,f.context);
    const good=fixture([readHtml(post())]); good.context.sources=f.context.sources;
    await readX(read([{postId:'123'}]),good.context);
    expect(good.open.mock.calls[0][0]).toBe('https://x.com/alice/status/123/history');
    const history=fixture(['<main><div data-testid="primaryColumn"><div aria-label="Timeline: Edit History">'+post('999')+'</div></div></main>']); history.context.sources=f.context.sources;
    expect((await readX(read([{postId:'123'}]),history.context)).targets[0]).toMatchObject({root:null,replies:{observations:[],scope:{completeness:'unknown'}},stopReason:'identity_unproven'});
  });
});


describe('bounded independent read stages',()=>{
  it('articleAttemptFactsAreSeparate and parent/replies survive every Article barrier',async()=>{
    const options={includeArticle:true,includeReplies:true,maxExpandActionsPerPost:4,maxScrollsPerPost:0};
    const good=await stagedFixture({article:'ok'});
    const actual=(await readX(read([{url:'https://x.com/alice/status/123'}],options),good.context)).targets[0];
    expect(actual).toMatchObject({root:{postId:'123',text:'expanded body'},article:{requested:true,entryObserved:true,actionAttempted:true,navigationStarted:true,bodyObserved:true,body:{postId:'456',sourceUrl:'https://x.com/bob/status/456',author:{handle:'bob'},text:'Article paragraph\n\nHeading'}},replies:{observations:[{postId:'789'},{postId:'790'}],scope:{completeness:'unknown'}},budgetUsage:{expandActions:3,scrolls:0}});
    expect(good.opens).toEqual(['https://x.com/alice/status/123','https://x.com/alice/status/123']);
    for(const mode of ['reject','nav-failed','auth','wrong-author','title-only'] as const) {
      const f=await stagedFixture({article:mode});
      const row=(await readX(read([{url:'https://x.com/alice/status/123'}],options),f.context)).targets[0];
      expect(row.root?.text,mode).toBe('expanded body');
      expect(row.article,mode).toMatchObject({requested:true,entryObserved:true,actionAttempted:true,navigationStarted:mode!=='reject',bodyObserved:false,body:null,barrier:{status:mode==='auth'?'auth_required':'partial'}});
      expect(row.article.barrier?.reason,mode).toMatch(mode==='reject'?/action/:mode==='nav-failed'?/navigation/:mode==='auth'?/onboarding/:/identity|body/);
      if(mode==='auth') expect(row).toMatchObject({status:'auth_required',stopReason:'access_barrier'});
    }
    const noEntry=await stagedFixture();
    expect((await readX(read([{url:'https://x.com/alice/status/123'}],options),noEntry.context)).targets[0].article).toMatchObject({requested:true,entryObserved:false,actionAttempted:false,navigationStarted:false,bodyObserved:false,barrier:{reason:'no_entry_observed'}});
  });
  it('saves frames before replacement, bounds real actions, and stops when focal identity is lost',async()=>{
    const f=await stagedFixture({virtualize:true});
    const row=(await readX(read([{url:'https://x.com/alice/status/123'}],{includeReplies:true,maxExpandActionsPerPost:2,maxScrollsPerPost:3}),f.context)).targets[0];
    expect(row).toMatchObject({root:{text:'expanded body'},replies:{observations:[{postId:'789',directParent:null},{postId:'790',directParent:null}],scope:{rootPostId:'123',completeness:'unknown',stopReason:'identity_unproven'}},budgetUsage:{scrolls:1,expandActions:2},stopReason:'identity_unproven'});
    expect(f.executed).toEqual(['body_expand','replies_expand','scroll']);
    const limited=await stagedFixture();
    const result=(await readX(read([{url:'https://x.com/alice/status/123'}],{includeReplies:true,maxRepliesPerPost:1,maxExpandActionsPerPost:1,maxScrollsPerPost:3}),limited.context)).targets[0];
    expect(result.replies.observations.map(p=>p.postId)).toEqual(['789']);
    expect(result).toMatchObject({stopReason:'budget_reached',replies:{scope:{completeness:'unknown'}},budgetUsage:{scrolls:0,expandActions:1}});
    const cancelled=await stagedFixture({abortAfterAction:new AbortController()});
    const stopped=(await readX(read([{url:'https://x.com/alice/status/123'}],{includeReplies:true,maxExpandActionsPerPost:3,maxScrollsPerPost:3}),cancelled.context)).targets[0];
    expect(stopped).toMatchObject({root:{text:'preview'},status:'cancelled',stopReason:'cancelled'});
    expect(cancelled.executed).toEqual(['body_expand']);
  });
});

it('does not replay the same physical unchanged control or lose pre-Article expanded evidence on return',async()=>{
  const request=read([{url:'https://x.com/alice/status/123'}],{includeArticle:true,includeReplies:true,maxExpandActionsPerPost:6,maxScrollsPerPost:0});
  const good=await stagedFixture({article:'ok',resetOnReturn:true});
  const row=(await readX(request,good.context)).targets[0];
  expect(row.root?.text).toBe('expanded body');
  expect(row.documentSource?.rootObservationId).toBe(row.root?.observationId);
  expect(row.article.body?.text).toBe('Article paragraph\n\nHeading');
  expect(row.article.entry?.binding.generation).toBe(good.entryGeneration());
  const unchanged=await stagedFixture({noEffect:true});
  const stopped=(await readX(read([{url:'https://x.com/alice/status/123'}],{maxExpandActionsPerPost:6}),unchanged.context)).targets[0];
  expect(unchanged.executed).toEqual(['body_expand']);
  expect(stopped).toMatchObject({status:'partial',reason:'body_expand_control_unchanged',budgetUsage:{expandActions:1}});
});


it('each successful explicit navigation receives one fresh observation without resetting action budgets',async()=>{
  const request=read([{url:'https://x.com/alice/status/123'}],{includeArticle:true,includeReplies:true,maxExpandActionsPerPost:3,maxScrollsPerPost:0});
  const good=await stagedFixture({article:'ok',staleInitial:1,staleReturn:1});
  const row=(await readX(request,good.context)).targets[0];
  expect(row).toMatchObject({root:{text:'expanded body'},article:{bodyObserved:true,body:{postId:'456'}},replies:{observations:[{postId:'789'},{postId:'790'}]},budgetUsage:{expandActions:3,scrolls:0},stopReason:'budget_reached'});
  expect(row.collectionTransitions).toMatchObject([{navigationPhase:'initial_post',navigationId:'2',rereadRequested:true},{navigationPhase:'return_post',navigationId:'5',rereadRequested:true}]);
  expect(good.executed).toEqual(['body_expand','article_entry','replies_expand']);
  for(const options of [{staleReturn:2},{staleReturn:1,returnDifferentUrl:true}]) {
    const rejected=await stagedFixture({article:'ok',staleInitial:1,...options});
    const result=(await readX(request,rejected.context)).targets[0];
    expect(result).toMatchObject({root:{text:'expanded body'},article:{bodyObserved:true},stopReason:'identity_unproven',budgetUsage:{expandActions:2}});
    expect(result.collectionTransitions.at(-1)).toMatchObject({navigationPhase:'return_post',rereadRequested:false,outcome:options.returnDifferentUrl?'route_changed':'repeated_invalidation'});
    expect(rejected.executed).toEqual(['body_expand','article_entry']);
  }
  const invalidProof=await stagedFixture({article:'ok',staleInitial:1,staleArticle:1});
  const rejectedArticle=(await readX(request,invalidProof.context)).targets[0];
  expect(rejectedArticle.collectionTransitions).toMatchObject([{navigationPhase:'initial_post',rereadRequested:true},{navigationPhase:'article',rereadRequested:true}]);
  expect(rejectedArticle.article).toMatchObject({actionAttempted:true,navigationStarted:true,bodyObserved:false,barrier:{reason:'article_body_identity_unproven'}});
  expect(invalidProof.executed).toEqual(['body_expand','article_entry','replies_expand']);
  const abort=new AbortController(),cancelled=await stagedFixture({article:'ok',staleInitial:1,staleReturn:1,abortOnReturnCollect:abort});
  const stopped=(await readX(request,cancelled.context)).targets[0];
  expect(stopped).toMatchObject({status:'cancelled',stopReason:'cancelled',root:{text:'expanded body'},article:{bodyObserved:true}});
  expect(cancelled.executed).toEqual(['body_expand','article_entry']);
  // Initial rejected+fresh, expanded body, Article, and cancelled first return only.
  expect(cancelled.collections()).toBe(5);
});


it('waits for the actual parent after Article and retains evidence even when readiness times out',async()=>{
  const request=read([{url:'https://x.com/alice/status/123'}],{includeArticle:true,includeReplies:true,maxExpandActionsPerPost:3});
  const good=await stagedFixture({article:'ok',returnWait:true,staleReturn:1});
  const row=(await readX(request,good.context)).targets[0];
  expect(good.waits()).toBe(1);
  expect(row).toMatchObject({root:{text:'expanded body'},article:{bodyObserved:true},replies:{observations:[{postId:'789'},{postId:'790'}]},budgetUsage:{expandActions:3}});
  const timeout=await stagedFixture({article:'ok',returnWait:true,waitResult:false});
  const stopped=(await readX(request,timeout.context)).targets[0];
  expect(stopped).toMatchObject({root:{text:'expanded body'},article:{bodyObserved:true},reason:'post_wait_timeout',stopReason:'wait_timeout',budgetUsage:{expandActions:2}});
  expect(timeout.executed).toEqual(['body_expand','article_entry']);
});

it('waits for source-proven discussion before any budgeted scroll or expansion and never treats deadline as completeness',async()=>{
  vi.useFakeTimers();
  try {
    const request=read([{url:'https://x.com/alice/status/123'}],{includeReplies:true,maxExpandActionsPerPost:3,maxScrollsPerPost:0});
    const run=async(mode:NonNullable<Parameters<typeof stagedFixture>[0]>['discussion'])=>{
      const f=await stagedFixture({discussion:mode,discussionAbort:new AbortController()});
      const pending=readX(request,f.context);
      await vi.runAllTimersAsync();
      return {f,row:(await pending).targets[0]};
    };
    const good=await run('ready');
    expect(good.row).toMatchObject({root:{text:'expanded body'},replies:{observations:[{postId:'789'},{postId:'790'}]},budgetUsage:{expandActions:2,scrolls:0}});
    expect(good.f.executed).toEqual(['body_expand','replies_expand']);
    for(const mode of ['never','late','auth','missing','route','cancel','stale'] as const) {
      const {f,row}=await run(mode);
      expect(f.executed,mode).toEqual(['body_expand']);
      expect(row.root?.text,mode).toBe('expanded body');
      expect(row.replies.scope.completeness,mode).toBe('unknown');
      expect(row.stopReason,mode).toBe(mode==='auth'?'access_barrier':mode==='cancel'?'cancelled':mode==='never'||mode==='late'?'wait_timeout':'identity_unproven');
      if(mode==='never'||mode==='late') expect(row.reason).toBe('reply_readiness_timeout');
      if(mode==='late') expect(row.replies.observations[0].postId).toBe('789');
      if(mode==='stale') expect(row.collectionTransitions.map(t=>t.rereadRequested)).toEqual([true,false]);
    }
  } finally {vi.useRealTimers();}
});

it('discussion counts source-confirmed scroll writes before ACK failure and never retries them',async()=>{
  for(const fail of [false,true]) {
    const f=fixture([readHtml(post()+post('456','bob','reply'))]);let receiptObserved=false;
    f.act.mockImplementation(async(...args:unknown[])=>{
      const options=args[2] as {scrollAcknowledgement?:{onWritten:()=>void}}|undefined;
      options?.scrollAcknowledgement?.onWritten();receiptObserved=!!options?.scrollAcknowledgement;
      if(fail)throw new KydogError('browser.wait_timeout','scroll_ack_timeout');
      return {action:args[0],line:'executed',navigation:null};
    });
    const row=(await readX(read([{url:'https://x.com/alice/status/123'}],{includeReplies:true,maxScrollsPerPost:1}),f.context)).targets[0];
    expect(receiptObserved).toBe(true);expect(row.budgetUsage.scrolls).toBe(1);expect(f.act).toHaveBeenCalledTimes(1);
    expect(row.root?.postId).toBe('123');expect(row.replies.observations[0].postId).toBe('456');expect(row.replies.scope.completeness).toBe('unknown');
    if(fail)expect(row.status).toBe('partial');
  }
});


it('preserves typed no-movement versus ACK-timeout with independent Article/root/replies and ignores prose',async()=>{
  const request=read([{url:'https://x.com/alice/status/123'}],{includeArticle:true,includeReplies:true,maxExpandActionsPerPost:4,maxScrollsPerPost:1});
  const cases=[
    {error:undefined,reason:'reply_budget_reached',stopReason:'budget_reached'},
    {error:new BrowserScrollAcknowledgementError('scroll_no_movement','scroll_ack_timeout'),reason:'scroll_no_movement',stopReason:'action_failed'},
    {error:new BrowserScrollAcknowledgementError('scroll_ack_timeout','scroll_no_movement'),reason:'scroll_ack_timeout',stopReason:'wait_timeout'},
    {error:Object.assign(new KydogError('browser.wait_timeout','scroll_no_movement scroll_ack_timeout'),{reason:'scroll_no_movement'}),reason:'action_failed:browser.wait_timeout',stopReason:'action_failed'},
  ];
  for(const sample of cases){
    const f=await stagedFixture({article:'ok',scrollError:sample.error});
    const row=(await readX(request,f.context)).targets[0];
    expect(row).toMatchObject({status:'partial',reason:sample.reason,stopReason:sample.stopReason,root:{postId:'123',text:'expanded body'},article:{bodyObserved:true,body:{postId:'456',text:'Article paragraph\n\nHeading'}},replies:{observations:[{postId:'789'},{postId:'790'}],scope:{completeness:'unknown',stopReason:sample.stopReason}},budgetUsage:{scrolls:1,expandActions:3}});
    expect(f.executed).toEqual(['body_expand','article_entry','replies_expand','scroll']);
  }
});
