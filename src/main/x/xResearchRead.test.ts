import { JSDOM } from 'jsdom';
import { createXResearchBrowser } from './xResearchBrowser';
import { xSourceRootReleaseExpression } from './xPageSource';
import { readDiscussion } from './xResearchReadStages';
import { logger } from '../log';
import { retainPointerFailure, pointerFailureDiagnostic } from '../browser/pointerDiagnostic';
import { BrowserScrollAcknowledgementError } from '../browser/actions';
import { KydogError } from '../../shared/errors';
import { describe, expect, it, vi } from 'vitest';
import { fixture, stagedFixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { searchX } from './xResearchSearch';
import { readX } from './xResearchRead';
import { serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
const read=(targets:any[],extra={})=>({tabId:'research-tab',read:{objective:'read',targets,includeArticle:false,includeReplies:false,maxRepliesPerPost:30,maxScrollsPerPost:0,maxExpandActionsPerPost:0,...extra}});
describe('ordinary X read orchestration',()=>{
  it('retains source bodies at the root-loss boundary without continuing or inheriting reply scope',async()=>{
    const own='https://x.com/bob/status/456';
    const f=fixture([readHtml(post()+post('456','bob','historical reply')),readHtml(post('456','bob','current own body')+post('789','carol','fresh own body'))]);
    const row=(await readX(read([{url:'https://x.com/alice/status/123'}],{includeReplies:true,maxScrollsPerPost:3}),f.context)).targets[0];
    expect(f.act.mock.calls.map(call=>call[0].kind)).toEqual(['scroll']);
    expect(row).toMatchObject({status:'partial',reason:'post_identity_unproven',stopReason:'identity_unproven',root:{text:'original'},replies:{observations:[{text:'historical reply',sourceUrl:own}],scope:{completeness:'unknown'}}});
    expect(row.unscopedPosts?.observations.map(p=>[p.postId,p.text,p.relationToTarget])).toEqual([['456','current own body','unproven'],['789','fresh own body','unproven']]);
    expect(row.budgetUsage.distinctEntries).toBe(3);
    expect(row.unscopedPosts?.observations[0].observationId).not.toBe(row.replies.observations[0].observationId);
    expect(f.context.sources.get('456')).toHaveLength(1);
    expect(f.context.sources.get('789')).toBeUndefined();
    for(const includeReplies of [true,false]){
      const cover='<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/writer">@writer</a></div><div data-testid="article-cover-image">Article</div></div>';
      const initial=fixture([readHtml(post('456','bob','current own body').replace('</article>',cover+'</article>'))]);
      const result=await readX(read([{url:'https://x.com/alice/status/123'}],{includeReplies,maxScrollsPerPost:3}),initial.context);
      expect(result.targets[0]).toMatchObject({root:null,status:'partial',stopReason:'identity_unproven'});
      expect(result.targets[0].unscopedPosts?.observations.map(p=>p.text)).toEqual(includeReplies?['current own body']:undefined);
      expect(result.targets[0].unscopedPosts?.previewGaps).toEqual(includeReplies?[{sourceUrl:own,unresolved:1}]:undefined);
      expect(initial.act).toHaveBeenCalledTimes(0);
    }
  });
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
    const row=(await readX(read([{url:'https://x.com/alice/status/123'}]),f.context)).targets[0];
    expect(row.root?.text).toBe('original');
    expect(row.diagnostics).toMatchObject({initialFrame:{rootIdentityProven:false},firstAdmittedFrame:{rootIdentityProven:true}});
    expect(row.diagnostics?.firstAdmittedFrame?.snapshotId).toBe(row.diagnostics?.terminalFrame?.snapshotId);
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
    expect(row.diagnostics).toMatchObject({version:1,initialFrame:{rootIdentityProven:true,rootCandidateCount:1},terminalFrame:{rootIdentityProven:false}});
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
    expect(good.row.diagnostics?.readiness).toMatchObject({timedOut:false,initial:{replyCount:0},terminal:{replyCount:1}});
    expect(good.f.executed).toEqual(['body_expand','replies_expand']);
    for(const mode of ['never','late','auth','missing','route','cancel','stale'] as const) {
      const {f,row}=await run(mode);
      expect(f.executed,mode).toEqual(['body_expand']);
      expect(row.root?.text,mode).toBe('expanded body');
      expect(row.replies.scope.completeness,mode).toBe('unknown');
      expect(row.stopReason,mode).toBe(mode==='auth'?'access_barrier':mode==='cancel'?'cancelled':mode==='never'||mode==='late'?'wait_timeout':'identity_unproven');
      if(mode==='never'||mode==='late') expect(row.reason).toBe('reply_readiness_timeout');
      if(mode==='never') expect(row.diagnostics?.readiness).toMatchObject({timedOut:true,initial:{replyCount:0,expandControlCount:0,explicitEndObserved:false},terminal:{replyCount:0,expandControlCount:0,explicitEndObserved:false}});
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

it('preserves the same validated scroll receipt through failure, canonical details and model content',async()=>{
  for (const failed of [false,true]) {
    const f=fixture([readHtml(post()+post('456','bob','reply'))]);
    f.act.mockImplementation(async (action,rawSnapshot,options)=>{
      const snapshot=rawSnapshot as import('../browser/snapshot').AxSnapshot;
      const callback=options!.scrollAcknowledgement!;
      callback.onWritten();
      const source={generation:snapshot.generation,targetKind:'document' as const,targetNodeId:7,targetContainsHit:true,conversationRelation:'unknown' as const,rootRelation:'unknown' as const,
        scrollHeight:1600,clientHeight:600,before:240,after:failed?240:840,written:true,eventObserved:!failed,frameObserved:!failed,
        state:failed?'no_movement' as const:'frame_observed' as const};
      callback.onReceipt?.(source);
      if(failed) throw new BrowserScrollAcknowledgementError('scroll_no_movement','opaque');
      return {action,line:'scrolled',navigation:null};
    });
    const actual=await readX(read([{url:'https://x.com/alice/status/123'}],{includeReplies:true,maxScrollsPerPost:1}),f.context);
    const row=actual.targets[0];
    expect(row.diagnostics?.initialFrame?.snapshotId).toBe(row.diagnostics?.scroll?.first?.snapshotId);
    if(failed) expect(row.diagnostics?.terminalFrame?.snapshotId).toBe(row.diagnostics?.initialFrame?.snapshotId);
    else expect(row.diagnostics?.terminalFrame?.snapshotId).not.toBe(row.diagnostics?.initialFrame?.snapshotId);
    expect(row.diagnostics?.scroll).toMatchObject({totalAttempts:1,omittedAttempts:0,first:{actionIndex:1,targetKind:'document',targetNodeId:7,
      before:240,after:failed?240:840,scrollHeight:1600,clientHeight:600,state:failed?'no_movement':'frame_observed'},
      last:{state:failed?'no_movement':'frame_observed'}});
    // This legacy fixture creates a new isolated world on every collection. Recovery must reject it.
    expect(row).toMatchObject({reason:failed?'post_identity_unproven':'reply_budget_reached',budgetUsage:{scrolls:1},replies:{scope:{completeness:'unknown'}}});
    if(failed)expect(row.diagnostics?.scrollRecovery?.first).toMatchObject({collectCount:1,outcome:'identity_unproven'});
    expect(f.act).toHaveBeenCalledTimes(1);
    const serialized=serializeXResearchResult(actual);
    const details=xResearchToolResult(serialized).details;
    expect(details.operation).toBe('read');
    if(details.operation!=='read') throw new Error('read details expected');
    expect(details.targets[0].diagnostics?.scroll).toEqual(row.diagnostics?.scroll);
    expect(details.targets[0].diagnostics?.initialFrame?.snapshotId).toBe(row.diagnostics?.initialFrame?.snapshotId);
    expect(details.targets[0].diagnostics?.terminalFrame?.snapshotId).toBe(row.diagnostics?.terminalFrame?.snapshotId);
    expect(JSON.parse(serialized.text).targets[0].diagnostics.scroll).toEqual(row.diagnostics?.scroll);
    expect(JSON.parse(serialized.text).targets[0].diagnostics.initialFrame.snapshotId).toBe(row.diagnostics?.initialFrame?.snapshotId);
    const projected=serializeXResearchResult({...actual,contentProjection:'x_research_projection_v1'});
    expect(JSON.parse(projected.text).targets[0].diagnostics.scroll).toEqual(row.diagnostics?.scroll);
    expect(JSON.parse(projected.text).targets[0].diagnostics.terminalFrame.snapshotId).toBe(row.diagnostics?.terminalFrame?.snapshotId);
    expect(serialized.text).not.toContain('opaque');
  }
});

it('counts actual scroll actions once while retaining only first and last receipts',async()=>{
  const f=fixture([readHtml(post()+post('456','bob','reply'))]);
  let actions=0;
  f.act.mockImplementation(async (action,rawSnapshot,options)=>{
    const snapshot=rawSnapshot as import('../browser/snapshot').AxSnapshot;
    actions++;
    options!.scrollAcknowledgement!.onWritten();
    options!.scrollAcknowledgement!.onReceipt?.({generation:snapshot.generation,targetKind:'element',targetNodeId:9,targetContainsHit:true,conversationRelation:'inside',rootRelation:'unknown',
      scrollHeight:2000,clientHeight:300,before:actions*10,after:actions*10+100,written:true,eventObserved:true,frameObserved:true,state:'frame_observed'});
    return {action,line:'scrolled',navigation:null};
  });
  const row=(await readX(read([{url:'https://x.com/alice/status/123'}],{includeReplies:true,maxScrollsPerPost:3}),f.context)).targets[0];
  expect(f.act).toHaveBeenCalledTimes(3);
  expect(actions).toBe(3);
  expect(row.diagnostics?.scroll).toMatchObject({totalAttempts:3,omittedAttempts:1,first:{actionIndex:1,before:10},last:{actionIndex:3,before:30}});
  expect(row.budgetUsage.scrolls).toBe(3);
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


it('logs only authentic reply expansion receipts with saved control and producer identities, preserving the original rejection', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    let genuine: KydogError | undefined;
    for (const mode of ['genuine-A', 'genuine-B', 'property', 'prototype', 'wrong-snapshot', 'wrong-generation', 'wrong-node', 'ordinary']) {
      const f = fixture([readHtml(post() + post('789', 'carol', 'first reply') + '<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>')]);
      Object.assign(f.context, { runId: `run-${mode}`, callId: `call-${mode}`, batchId: `batch-${mode}` });
      let thrown: unknown;
      f.act.mockImplementation(async (action, snapshot) => {
        const snap = snapshot as import('../browser/snapshot').AxSnapshot;
        const node = snap.nodes.find(n => n.index === action.index)!;
        expect(node.collectedPermission?.purpose).toBe('replies_expand');
        const error = new KydogError('browser.click_intercepted', 'private-text private-class https://private.example/');
        if (mode.startsWith('genuine') || mode.startsWith('wrong-')) {
          genuine = retainPointerFailure(error, { tabId: 'research-tab', snapshotId: mode === 'wrong-snapshot' ? 'other-snapshot' : snap.snapshotId,
            generation: mode === 'wrong-generation' ? 'other-generation' : snap.generation, nodeId: mode === 'wrong-node' ? node.nodeId + 1 : node.nodeId }, 'measure', {
            ok: false, reason: 'intercepted', x: 61, y: 63, pointerFailure: { point: { x: 61, y: 63 }, targetTag: 'BUTTON', hitTag: 'ASIDE', targetConnected: true, targetContainsHit: false, hitSameAsCaptured: null,
              rejectGeometry: { targetRect: { x: 11, y: 23, width: 100, height: 80 }, hitRect: { x: 1, y: 2, width: 700, height: 900 }, scroll: { x: 0, y: 17 }, viewport: { width: 900, height: 700 } } },
          });
          thrown = genuine;
        } else if (mode === 'property') thrown = Object.assign(error, { diagnostic: pointerFailureDiagnostic(genuine) });
        else if (mode === 'prototype') thrown = Object.assign(Object.create(Object.getPrototypeOf(genuine!)), error, { diagnostic: pointerFailureDiagnostic(genuine) });
        else thrown = error;
        throw thrown;
      });
      const result = await readX(read([{ url: 'https://x.com/alice/status/123' }], { includeReplies: true, maxExpandActionsPerPost: 2 }), f.context);
      expect(result.targets[0]).toMatchObject({ root: { text: 'original' }, reason: 'action_failed:browser.click_intercepted', budgetUsage: { expandActions: 0 } });
      expect(f.act).toHaveBeenCalledTimes(1);
      expect(f.collect).toHaveBeenCalledTimes(1);
      if (mode.startsWith('genuine')) {
        expect(result.targets[0].diagnostics?.pointerFailure).toMatchObject({actionIndex:1,targetPostId:'123',controlKind:'replies_expand',sourceRelation:'unknown',diagnostic:{nodeId:expect.any(Number),stage:'measure'}});
        expect(warn).toHaveBeenLastCalledWith('xResearch', 'Reply expansion pointer interception', {
          runId: `run-${mode}`, callId: `call-${mode}`, batchId: `batch-${mode}`, diagnostic: pointerFailureDiagnostic(thrown),
        });
        expect(pointerFailureDiagnostic(thrown)).toMatchObject({ stage: 'measure', nodeId: expect.any(Number) });
        expect(JSON.stringify(warn.mock.calls.at(-1))).not.toContain('private-');
      } else expect(result.targets[0].diagnostics?.pointerFailure).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(mode === 'genuine-A' ? 1 : 2);
    }
  } finally { warn.mockRestore(); }
});


it('reply action catch rethrows the same authenticated error without another collection or action', async () => {
  const f = fixture([readHtml(post() + post('789', 'carol', 'reply') + '<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>')]);
  const input = read([{ url: 'https://x.com/alice/status/123' }], { includeReplies: true, maxExpandActionsPerPost: 2 });
  const row = (await readX({ ...input, read: { ...input.read, includeReplies: false } }, f.context)).targets[0];
  const request = { stage: 'post' as const, expectedUrl: 'https://x.com/alice/status/123', postId: '123' };
  const observed = await f.page.collect(request);
  const control = observed.controls.find(c => c.kind === 'replies_expand')!;
  expect(control).toBeDefined();
  const original = retainPointerFailure(new KydogError('browser.click_intercepted', 'private'), { tabId: 'research-tab', ...control.binding }, 'measure', { ok: false, reason: 'intercepted', x: 3, y: 9 });
  expect(pointerFailureDiagnostic(original)).toMatchObject({ nodeId: control.binding.nodeId, rejection: null });
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    f.act.mockRejectedValue(original);
    const before = f.collect.mock.calls.length;
    await expect(readDiscussion(f.page, observed, request, row, input.read, { current: 'collection', actionIndex:0, attemptedControls: new Set() }, f.context)).rejects.toBe(original);
    expect(f.act).toHaveBeenCalledTimes(1);
    expect(f.collect).toHaveBeenCalledTimes(before);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(row.budgetUsage.expandActions).toBe(0);
  } finally { warn.mockRestore(); }
});


it('preserves exact successive root, quote and reply bodies through canonical/model evidence and branch restore', async () => {
  const { serializeXResearchResult } = await import('./xResearchOutput');
  const { XResearchEvidence } = await import('./xResearchEvidence');
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const frame = (root: string, quote: string, reply: string, extra = '') => readHtml(post('123','alice',root).replace('</article>', `<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/bob">@bob</a></div><div data-testid="tweetText">${quote}</div><a href="/bob/status/456"><time>today</time></a></div></article>`)+post('789','carol',reply)+extra);
  for (const shorter of [false, true]) {
    const first: [string,string,string] = ['Expanded root retained evidence','Expanded quoted evidence','Expanded reply evidence'];
    const later: [string,string,string] = shorter ? ['Root preview','Quote preview','Reply preview'] : first;
    const f=fixture([frame(...first),frame(...later,post('790','dave','new reply'))]);
    const observed: import('./xPageSource').XPageObservation[]=[];
    const collect=f.collect.getMockImplementation()!;
    f.collect.mockImplementation(async request=>{const value=await collect(request);observed.push(value);return value;});
    const result=await readX(read([{url:'https://x.com/alice/status/123'}],{includeReplies:true,maxRepliesPerPost:2,maxScrollsPerPost:1}),f.context);
    expect(result.targets[0]).toMatchObject({root:{text:later[0]},quotedPosts:[{text:later[1]}],replies:{observations:[{text:later[2]},{text:'new reply'}]},budgetUsage:{scrolls:1,distinctEntries:4},stopReason:'budget_reached'});
    const serialized=serializeXResearchResult(result);
    const projected=serializeXResearchResult({...result,objective:'x'.repeat(600000)});
    expect(projected.result.contentProjection).toBe('x_research_projection_v1');
    const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(serialized.result);
    const manager=SessionManager.inMemory('/tmp');
    const base=manager.appendMessage({role:'user',content:'read',timestamp:0});
    manager.appendMessage({role:'toolResult',toolName:'x_research',toolCallId:'call',isError:false,content:[{type:'text',text:serialized.text}],details:serialized.result,timestamp:1});
    const restored=new XResearchEvidence('/tmp',()=> 'later-run');restored.restore(manager.getBranch());
    for (const page of observed) for (const p of [page.root!,...page.quotedPosts,...page.replies]) {
      for (const records of [ledger.observations,restored.observations]) expect(records).toContainEqual(expect.objectContaining({observationId:p.observationId,text:p.text,authorHandle:p.author!.handle,sourceUrl:p.sourceUrl,postId:p.postId}));
      expect(serialized.text).toContain(p.observationId);
      expect(serialized.text).toContain(p.text);
      expect(projected.text).toContain(p.observationId);
      expect(projected.text).toContain(p.text);
    }
    expect(ledger.observations).toHaveLength(7);
    expect(restored.observations).toHaveLength(7);
    expect(()=>restored.guard('/tmp/report.md','[root](https://x.com/alice/status/123) [quote](https://x.com/bob/status/456) [reply](https://x.com/carol/status/789)')).not.toThrow();
    manager.branch(base);restored.restore(manager.getBranch());expect(restored.observations).toHaveLength(0);
  }
});

it('retains a 7009-unit focal body with no expansion control through read, output, evidence and SDK restore', async () => {
  const { serializeXResearchResult } = await import('./xResearchOutput');
  const { XResearchEvidence } = await import('./xResearchEvidence');
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const body = 'a'.repeat(7008) + 'Z';
  const f = fixture([readHtml(post('123', 'alice', body))]);
  const result = await readX(read([{url:'https://x.com/alice/status/123'}]), f.context);
  const root = result.targets[0].root!;
  expect(root).toMatchObject({
    postId:'123', sourceUrl:'https://x.com/alice/status/123', author:{handle:'alice'},
    text:body, truncation:{returned:7009,totalKnown:7009,truncated:false},
    observationId:expect.any(String),
  });
  const serialized = serializeXResearchResult(result);
  expect(serialized.result.targets[0].root).toMatchObject({observationId:root.observationId,text:body});
  expect(serialized.text).toContain(body);
  const ledger = new XResearchEvidence('/tmp', () => 'run');
  ledger.observe(serialized.result);
  expect(ledger.observations).toContainEqual(expect.objectContaining({observationId:root.observationId,text:body,authorHandle:'alice',sourceUrl:root.sourceUrl,postId:'123'}));
  const manager = SessionManager.inMemory('/tmp');
  manager.appendMessage({role:'user',content:'read',timestamp:0});
  manager.appendMessage({role:'toolResult',toolName:'x_research',toolCallId:'call',isError:false,content:[{type:'text',text:serialized.text}],details:serialized.result,timestamp:1});
  const restored = new XResearchEvidence('/tmp', () => 'later-run');
  restored.restore(manager.getBranch());
  expect(restored.observations).toContainEqual(expect.objectContaining({observationId:root.observationId,text:body,authorHandle:'alice',sourceUrl:root.sourceUrl,postId:'123'}));
});


it.each(['throw','false'] as const)('retains already admitted read row and serialized diagnostics when fixed release returns %s',async mode=>{
  const url='https://x.com/alice/status/123',dom=new JSDOM(readHtml(post()),{url,runScripts:'outside-only'});
  Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
  let failRelease=false;
  const facts={currentUrl:url,documentEpoch:1,routeRevision:2,navigationSequence:3,navigationEvent:'did-navigate' as const,navigationType:'cross_document' as const,navigationUrl:url};
  const service={researchTabStatus:()=> 'available',enqueue:async(_id:string,fn:()=>Promise<unknown>)=>fn(),withAgentDriving:async(_id:string,_thread:string,fn:()=>Promise<unknown>)=>fn(),
    onTabDestroyed:()=>()=>{},onTabUnavailable:()=>()=>{},locationFacts:()=>({...facts}),prepareForDomRead:async()=>{},
    open:async()=>({tabId:'tab',evicted:[],nav:{navigationId:'nav',outcome:{kind:'ok',finalUrl:url}}}),
    evalInPage:async(_id:string,code:string)=>{
      if(failRelease && code.startsWith('/* kydog-x-root-release */')){
        expect(dom.window.eval('!!window.__kydogXRootState.pending || !!window.__kydogXRootState.anchor')).toBe(true);
        if(mode==='throw') throw Error('private_raw_error_token');return {released:false};
      }
      return dom.window.eval(code);
    }};
  const context={browser:createXResearchBrowser(service as never,'thread'),threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map()};
  const log=vi.spyOn(logger,'error').mockImplementation(()=>{});
  try{
    const good=await readX(read([{url}]),context);
    expect(good.targets[0]).toMatchObject({status:'observed',root:{text:'original',sourceUrl:url},diagnostics:{firstAdmittedFrame:{sourceRootState:{root:{connection:'connected'}}}}});
    expect(dom.window.eval('window.__kydogXRootState')).toBeUndefined();
    failRelease=true;
    const failed=await readX(read([{url}]),context),row=failed.targets[0];
    expect(row).toMatchObject({status:'partial',root:{text:'original',sourceUrl:url},sourceUrl:url,diagnostics:{firstAdmittedFrame:{rootIdentityProven:true,sourceRootState:{root:{connection:'connected'},identity:{coordinates:'same'}}}}});
    expect(row.reason).toBe('internal_adapter_error:collection');
    const serialized=serializeXResearchResult(failed),model=JSON.parse(serialized.text);
    expect(serialized.result.targets[0].root?.text).toBe('original');
    expect(model.targets[0].diagnostics.firstAdmittedFrame.sourceRootState).toEqual(row.diagnostics?.firstAdmittedFrame?.sourceRootState);
    expect(model.targets[0].root.sourceUrl).toBe(url);
    const receipt=row.diagnostics?.sourceFailure;
    expect(receipt).toMatchObject({purpose:'x_source_release',phase:'release',cause:mode==='throw'?'wrapper_failure':'invalid_release_receipt',nativeSettlement:'not_observed'});
    expect(model.targets[0].diagnostics.sourceFailure).toEqual(receipt);
    expect(serialized.result.targets[0].diagnostics?.sourceFailure).toEqual(receipt);
    expect(log).toHaveBeenCalledWith('x_research','source_root_cleanup_failed',{...receipt,workFailed:false,sourceUsed:true,failureCategory:mode==='throw'?'evaluation_rejected':'invalid_release_receipt'});
    const publicControl=structuredClone(good);publicControl.objective='private_raw_error_token';
    expect(serializeXResearchResult(publicControl).text).toContain('private_raw_error_token');
    expect(serialized.text).not.toContain('private_raw_error_token');
  }finally{
    const lease=dom.window.eval('window.__kydogXRootState?.lease');if(lease) dom.window.eval(xSourceRootReleaseExpression(String(lease)));
    dom.window.close();log.mockRestore();
  }
});

it('retains authenticated failures for each exact original click purpose and preserves reply compatibility',async()=>{
 const {retainPointerFailure}=await import('../browser/pointerDiagnostic');
 for(const purpose of ['body_expand','article_entry','replies_expand','article_and_replies'] as const){
  const f=await stagedFixture({semanticLabels:true,article:'ok'});const original=f.context.browser.withPage.bind(f.context.browser);
  f.context.browser.withPage=async(tab,signal,work)=>original(tab,signal,page=>work({...page,act:async(action,snapshot,options)=>{
   const node=snapshot.nodes.find(n=>'index' in action&&n.index===action.index)!;
   if(node.collectedPermission?.purpose!==purpose && !(purpose==='article_and_replies' && ['article_entry','replies_expand'].includes(node.collectedPermission?.purpose??'')))return page.act(action,snapshot,options);
   throw retainPointerFailure(new KydogError('browser.click_intercepted','private'),{tabId:tab,snapshotId:snapshot.snapshotId,generation:snapshot.generation,nodeId:node.nodeId},'measure',{ok:false,reason:'intercepted',x:61,y:37});
  }}));
  const result=await readX({tabId:'tab',read:{objective:'diagnose',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:true,includeReplies:true,maxRepliesPerPost:20,maxScrollsPerPost:0,maxExpandActionsPerPost:4}},f.context);
  const row=result.targets[0],entry=row.diagnostics?.clickFailures?.first;
  expect(entry,purpose).toMatchObject({controlKind:purpose==='article_and_replies'?'article_entry':purpose,targetPostId:'123',actionIndex:purpose==='body_expand'?1:purpose==='article_entry'||purpose==='article_and_replies'?2:3,diagnostic:{stage:'measure',point:{x:61,y:37}}});
  expect(row.diagnostics?.clickFailures).toMatchObject({totalFailures:purpose==='article_and_replies'?2:1,omittedFailures:0,...(purpose==='article_and_replies'?{last:{controlKind:'replies_expand',actionIndex:3}}:{last:entry})});
  expect(entry?.binding.snapshotId).toBe(entry?.diagnostic.snapshotId);
  if(purpose==='replies_expand')expect(row.diagnostics?.pointerFailure?.diagnostic).toEqual(entry?.diagnostic);
 }
});
