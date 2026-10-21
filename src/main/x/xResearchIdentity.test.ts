import { describe, expect, it } from 'vitest';
import { compareXLocation, toSafeXLocation, proveArticleIdentity, applyReplyEndEvidence, parseXSourcePost, X_MAX_SOURCE_URL_UNITS } from './xResearchIdentity';

describe('X location identity', () => {
  // Losing one coordinate must not erase independent facts from other coordinates.
  it('locationRelationsKeepIndependentFacts', () => {
    expect(compareXLocation('https://x.com/a/status/123', 'https://x.com/a/status/123')).toEqual({ origin: 'same', path: 'same', postId: 'same', query: 'unknown', product: 'unknown', fragment: 'unknown' });
    expect(compareXLocation('https://x.com/a/status/123', 'https://x.com/i/web/status/123')).toMatchObject({ origin: 'same', path: 'different', postId: 'same' });
    expect(compareXLocation('https://x.com/a/status/123', 'https://twitter.com/a/status/123')).toMatchObject({ origin: 'different', path: 'same', postId: 'same' });
    expect(compareXLocation('https://x.com/a/status/123', 'https://x.com/a/status/456')).toMatchObject({ origin: 'same', path: 'different', postId: 'different' });
    const location = 'https://x.com/search?q=paper&f=live#result';
    expect(compareXLocation(location, 'https://x.com/search?f=live&q=paper#result')).toMatchObject({ origin: 'same', path: 'same', query: 'same', product: 'same', fragment: 'same' });
    expect(compareXLocation(location, 'https://x.com/search?q=other&f=live#result')).toMatchObject({ query: 'different', product: 'same', fragment: 'same' });
    expect(compareXLocation(location, 'https://x.com/search?q=paper&f=top#result')).toMatchObject({ query: 'same', product: 'different', fragment: 'same' });
    expect(compareXLocation(location, 'https://x.com/search?q=paper&f=live#other')).toMatchObject({ query: 'same', product: 'same', fragment: 'different' });
    expect(compareXLocation(location, 'https://x.com/search?q=paper')).toMatchObject({ query: 'same', product: 'unknown', fragment: 'unknown' });
    expect(compareXLocation(location, 'https://x.com/search?q=paper&q=other&f=live')).toMatchObject({ query: 'unknown', product: 'same' });
    expect(compareXLocation(location, 'invalid')).toEqual({ origin: 'unknown', path: 'unknown', postId: 'unknown', query: 'unknown', product: 'unknown', fragment: 'unknown' });
  });

  it('redactsSensitiveLocationWithoutInventingEquality', () => {
    expect(toSafeXLocation('https://x.com/a/status/123')).toEqual({ origin: 'https://x.com', path: '/a/status/123', q: null, f: null, fragment: null, redacted: false });
    const first = 'https://user:secret@x.com/i/flow/login?token=one#private-one';
    const second = 'https://other:different@x.com/i/flow/login?token=two#private-two';
    expect(toSafeXLocation(first)).toEqual({ origin: 'https://x.com', path: null, q: null, f: null, fragment: null, redacted: true });
    expect(toSafeXLocation(second)).toEqual(toSafeXLocation(first));
    expect(compareXLocation(first, second)).toMatchObject({ origin: 'same', path: 'same', fragment: 'different', postId: 'unknown' });
    expect(toSafeXLocation('https://x.com/search?q=paper&f=live&token=secret')).toEqual({ origin: 'https://x.com', path: '/search', q: 'paper', f: 'live', fragment: null, redacted: true });
    expect(toSafeXLocation('https://evil.com/private?token=secret')).toEqual({ origin: null, path: null, q: null, f: null, fragment: null, redacted: true });
    expect(toSafeXLocation('invalid')).toEqual({ origin: null, path: null, q: null, f: null, fragment: null, redacted: true });
  });
});


it('articleUsesItsOwnIdentityStage and rejects an unrelated navigation, origin or title alone',async()=>{
  const { stagedFixture }=await import('../../test-support/xResearchFixture');
  const f=await stagedFixture({article:'ok'});
  await f.context.browser.open('https://x.com/alice/status/123','research-tab');
  await f.context.browser.withPage('research-tab',undefined,async page=>{
    const parent=await page.collect({stage:'post',expectedUrl:'https://x.com/alice/status/123',postId:'123'}),entry=parent.entries[0];
    const action=await page.act({kind:'click',index:entry.binding.index,snapshotId:entry.binding.snapshotId},parent.snapshot);
    const article=await page.collect({stage:'article',expectedUrl:'https://x.com/bob/status/456',entry,via:{kind:'action',result:action}});
    expect(proveArticleIdentity(entry,article,action.navigation)).toEqual({proven:true,stage:'body',reason:null});
    for(const destination of ['https://x.com/bob/status/999','https://other.example/bob/status/456']) {
      expect(proveArticleIdentity(entry,article,{...action.navigation!,outcome:{kind:'ok_same_document',finalUrl:destination}})).toMatchObject({proven:false,stage:'navigation'});
    }
    expect(proveArticleIdentity({...entry,author:{handle:'mallory',displayName:null,profileUrl:null}},article,action.navigation)).toMatchObject({proven:false,stage:'body'});
    expect(proveArticleIdentity(entry,{...article,article:null},action.navigation)).toMatchObject({proven:false,stage:'body'});
    expect(proveArticleIdentity({...entry,targetUrl:'https://x.com/bob/status/999'},article,action.navigation)).toMatchObject({proven:false,stage:'navigation'});
  });
});
it('replyScopeDoesNotInferParentOrExhaustion across root, branch and sort flips',()=>{
  const base={rootPostId:'123',branch:{postId:'789',sourceUrl:'https://x.com/carol/status/789'},sort:{label:'Most relevant',value:null},stopReason:'budget_reached' as const,displayedReplyCount:{text:'999 replies',value:999},completeness:'unknown' as const,endEvidence:null};
  const end={observationId:'explicit-observation',text:'Observed end of this branch',sourceUrl:'https://x.com/alice/status/123',observedAt:'2026-10-12T00:00:00Z',rootPostId:'123',branch:base.branch,sort:base.sort};
  expect(applyReplyEndEvidence(base,end)).toMatchObject({completeness:'ui_scope_end_observed',endEvidence:end,stopReason:'explicit_ui_end'});
  for(const changed of [{...end,rootPostId:'456'},{...end,branch:null},{...end,branch:{...end.branch,postId:'790'}},{...end,sort:null},{...end,sort:{label:'Recent',value:null}}]) expect(applyReplyEndEvidence(base,changed)).toMatchObject({completeness:'unknown',stopReason:'budget_reached',endEvidence:null});
  expect(applyReplyEndEvidence(base,null)).toMatchObject({completeness:'unknown',stopReason:'budget_reached',endEvidence:null});
});


it('derives the exact source bound from allowed origin, handle, uint64 and history route',()=>{
  const url='https://twitter.com/Ab_0123456789xy/status/18446744073709551615/history/';
  expect(url.length).toBe(X_MAX_SOURCE_URL_UNITS);
  expect(parseXSourcePost(url)).toMatchObject({url,handle:'Ab_0123456789xy',id:'18446744073709551615'});
  expect(parseXSourcePost(url+' ')).toBeNull();
  expect(parseXSourcePost(url.replace('/history/','/photo/1'))).toBeNull();
});

it('Article admission requires all private parent coordinates to match the network root and the current one-shot entry',async()=>{
 const {stagedFixture}=await import('../../test-support/xResearchFixture');const {matchesXArticleParent}=await import('./xResearchIdentity');
 const f=await stagedFixture({article:'ok'}),request={stage:'post' as const,expectedUrl:'https://x.com/alice/status/123',postId:'123',collectReplies:false};
 await f.context.browser.open(request.expectedUrl,'research-tab',undefined,request);
 await f.context.browser.withPage('research-tab',undefined,async page=>{
  const observed=await page.collect(request),entry=observed.entries[0],root=observed.root!;expect(matchesXArticleParent(observed,entry,root)).toBe(true);
  for(const altered of [{...root,postId:'999'},{...root,sourceUrl:'https://x.com/other/status/123'},{...root,author:{...root.author!,handle:'other'}}])expect(matchesXArticleParent(observed,entry,altered)).toBe(false);
  expect(matchesXArticleParent(observed,{...entry},root)).toBe(false);
  await page.act({kind:'click',index:entry.binding.index,snapshotId:entry.binding.snapshotId},observed.snapshot);expect(f.executed).toEqual(['article_entry']);
  await expect(page.act({kind:'click',index:entry.binding.index,snapshotId:entry.binding.snapshotId},observed.snapshot)).rejects.toMatchObject({code:'browser.stale_snapshot'});expect(f.executed).toEqual(['article_entry']);
 });
});

it('a complete private native Article inventory can prove zero but cannot erase wire presence or cross parent coordinates',async()=>{
 const {fixture,post,readHtml}=await import('../../test-support/xResearchFixture');const {readResult}=await import('./xResearchRead');const {savePostFrame}=await import('./xResearchReadStages');
 const input={tabId:'tab',read:{objective:'inventory',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}};
 for(const mode of ['zero','wire','postId','sourceUrl','author','missing'] as const){
  const f=fixture([readHtml(mode==='missing'?'':post())]);await f.open(input.read.targets[0].url);const observed=await f.page.collect({stage:'post',postId:'123',expectedUrl:input.read.targets[0].url,collectReplies:false});const row=readResult(input,f.context).targets[0];
  if(mode!=='missing'){
   const root=(observed.network!.pages[0] as import('./xNetworkSource').XNetworkReadPage).root!;
   if(mode==='wire')root.articlePreviewInventory={scope:'collection',observed:0,retained:0,omitted:0,unresolved:1};
   if(mode==='postId')root.postId='999';if(mode==='sourceUrl')root.sourceUrl='https://x.com/other/status/123';if(mode==='author')root.author!.handle='other';
  }
  savePostFrame(row,observed,input.read,f.context);
  if(mode==='zero')expect(row.root?.articlePreviewInventory).toEqual({scope:'collection',observed:0,retained:0,omitted:0,unresolved:0});
  else if(mode==='wire')expect(row.root?.articlePreviewInventory?.unresolved).toBe(1);
  else expect(row.root?.articlePreviewInventory).toBeUndefined();
  expect(JSON.stringify(observed)).not.toContain('articleParentInventories');
 }
});
