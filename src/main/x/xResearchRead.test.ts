import { KydogError } from '../../shared/errors';
import { describe, expect, it } from 'vitest';
import { fixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
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
    const f=fixture([readHtml(post())]);
    const result=await readX(read(targets,{includeArticle:true,includeReplies:true,maxScrollsPerPost:2}),f.context);
    expect(result.targets).toHaveLength(20); expect(f.open).toHaveBeenCalledTimes(20);
    expect(result.targets[0]).toMatchObject({status:'partial',article:{requested:true,actionAttempted:false,bodyObserved:false},replies:{requested:true,scope:{completeness:'unknown'}},reason:'later_stages_not_implemented'});
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
