import { BrowserScrollAcknowledgementError } from '../browser/actions';
import { KydogError } from '../../shared/errors';
import { describe, expect, it } from 'vitest';
import { fixture, stagedFixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { createXResearchTool } from './xResearchTool';
describe('production X SDK factory',()=>{
  it('uses actual sequential SDK signature, validation and bounded v2 details',async()=>{
    const f=fixture([searchHtml(post())]);
    const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'actual-run'});
    expect(tool).toMatchObject({name:'x_research',executionMode:'sequential'});
    const result=await tool.execute('actual-call',searchInput,undefined,undefined,{} as never);
    expect(result.details).toMatchObject({schemaVersion:2,runId:'actual-run',callId:'actual-call',browserTabId:'research-tab'});
    expect(JSON.parse((result.content[0] as any).text)).toEqual(result.details);
    await expect(tool.execute('bad',{...searchInput,read:{} } as never,undefined,undefined,{} as never)).rejects.toThrow('exactly one');
    expect(f.open).toHaveBeenCalledTimes(1);
  });
  it('rejects metadata alone over exact envelope budget before browser I/O',async()=>{
    const f=fixture([searchHtml(post())]);
    const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
    expect((await tool.execute('small',searchInput,undefined,undefined,{} as never)).details?.schemaVersion).toBe(2);
    const huge={search:{...searchInput.search,objective:'汉'.repeat(400000)}};
    await expect(tool.execute('oversize',huge,undefined,undefined,{} as never)).rejects.toThrow('request metadata exceeds 1 MiB');
    expect(f.open).toHaveBeenCalledTimes(1);
  });
  it('retains actual tab across omitted searches, clears only after proven destruction for next call',async()=>{
    const f=fixture([searchHtml(post())]);const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
    await tool.execute('first',searchInput,undefined,undefined,{} as never);await tool.execute('reuse',searchInput,undefined,undefined,{} as never);
    expect(f.open.mock.calls[1][1]).toBe('research-tab');
    f.open.mockRejectedValueOnce(new KydogError('browser.target_unusable','access failed'));
    await tool.execute('access',searchInput,undefined,undefined,{} as never);await tool.execute('stillbound',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[3][1]).toBe('research-tab');
    f.open.mockRejectedValueOnce(new KydogError('browser.no_tab','closed'));
    const gone=await tool.execute('closed',searchInput,undefined,undefined,{} as never);expect(gone.details?.status).toBe('failed');expect(f.open).toHaveBeenCalledTimes(5);
    await tool.execute('next',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[5][1]).toBeUndefined();
    f.open.mockRejectedValueOnce(new KydogError('browser.not_dispatchable','renderer unavailable'));
    await tool.execute('unavailable',searchInput,undefined,undefined,{} as never);await tool.execute('sameafterunavailable',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[7][1]).toBe('research-tab');
    f.open.mockRejectedValueOnce(new KydogError('browser.no_tab','unknown explicit tab'));
    await tool.execute('unknownexplicit',{...searchInput,tabId:'missing-tab'},undefined,undefined,{} as never);await tool.execute('afterunknown',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[9][1]).toBe('research-tab');
    await tool.execute('explicit',{...searchInput,tabId:'provided-tab'},undefined,undefined,{} as never);expect(f.open.mock.calls[10][1]).toBe('provided-tab');
  });
  it('admits six queries and all20 modest targets under exact required-state sizing',async()=>{
    const rendered=[searchHtml(post())],f=fixture(rendered);const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
    const six={search:{...searchInput.search,queries:Array.from({length:6},(_,i)=>({...searchInput.search.queries[0],id:String(i)}))}};
    expect((await tool.execute('six',six,undefined,undefined,{} as never)).details?.operation).toBe('search');
    rendered[0]=readHtml(post());
    const twenty={tabId:'research-tab',read:{objective:'ordinary targets',targets:Array.from({length:20},()=>({url:'https://x.com/alice/status/123'})),includeArticle:false,includeReplies:false}};
    const result=await tool.execute('twenty',twenty,undefined,undefined,{} as never);expect(result.details?.operation).toBe('read');expect(result.details?.status).toBe('observed');expect(f.open).toHaveBeenCalledTimes(26);
    const withArticles=await tool.execute('twenty-articles',{...twenty,read:{...twenty.read,includeArticle:true}},undefined,undefined,{} as never);
    expect(withArticles.details?.operation).toBe('read');
    if(withArticles.details?.operation==='read') expect(withArticles.details.targets).toHaveLength(20);
  });
  it('checks the actual generated search URL rather than a different space encoding',async()=>{
    const f=fixture([searchHtml(post())]);const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
    expect((await tool.execute('normal',searchInput,undefined,undefined,{} as never)).details?.status).toBe('partial');
    const query='a'+' '.repeat(4095);const input={search:{...searchInput.search,queries:[{...searchInput.search.queries[0],query}]}};
    const result=await tool.execute('boundary',input,undefined,undefined,{} as never);expect(result.details?.status).toBe('partial');expect(new URL(f.open.mock.calls[1][0]).searchParams.get('q')).toBe(query);
    expect(f.open.mock.calls[1][0].length).toBeLessThan(8192);
    for(const query of ['a'.repeat(4100),'汉'.repeat(4096)]) {
      await expect(tool.execute('too-large',{search:{...searchInput.search,queries:[{...searchInput.search.queries[0],query}]}},undefined,undefined,{} as never)).rejects.toThrow('shorten or split');
      expect(f.open).toHaveBeenCalledTimes(2);
    }
  });
  it('admits literal history/media targets without halting their ordinary sibling', async () => {
    const plain = 'https://x.com/alice/status/123';
    const f = fixture([readHtml(post())]);
    const tool = createXResearchTool({browser:f.context.browser, threadId:'thread', sources:f.context.sources, currentRunId:()=> 'run'});
    const read = (targets:{url:string}[]) => ({tabId:'research-tab', read:{objective:'read', targets, includeArticle:false, includeReplies:false}});
    expect((await tool.execute('plain', read([{url:plain}]), undefined, undefined, {} as never)).details).toMatchObject({targets:[{status:'observed', root:{postId:'123'}}]});
    for (const suffix of ['/history', '/photo/1', '/video/1']) {
      const url = plain + suffix;
      const result = await tool.execute('route', read([{url}, {url:plain}]), undefined, undefined, {} as never);
      expect(result.details).toMatchObject({targets:[
        {target:{url}, inputUrl:url, status:'partial', reason:'unsupported_document_route', stopReason:'identity_unproven', root:null, location:{requested:{path:'/alice/status/123'+suffix}, committed:{path:'/alice/status/123'+suffix}}},
        {status:'observed', root:{postId:'123', text:'original'}},
      ]});
      expect(f.open.mock.calls.slice(-2).map(c=>c[0])).toEqual([url, plain]);
    }
    expect(f.collect).toHaveBeenCalledTimes(7);
    const redirected = fixture([readHtml(post())], {finalUrl:()=>plain});
    const redirectedTool = createXResearchTool({browser:redirected.context.browser, threadId:'thread', sources:redirected.context.sources, currentRunId:()=> 'run'});
    for (const suffix of ['/history', '/photo/1', '/video/1']) {
      const url = plain + suffix;
      const result = await redirectedTool.execute('redirect', read([{url}, {url:plain}]), undefined, undefined, {} as never);
      expect(result.details).toMatchObject({targets:[
        {target:{url}, inputUrl:url, root:{postId:'123', sourceUrl:plain}, location:{requested:{path:'/alice/status/123'+suffix}, committed:{path:'/alice/status/123'}, subsequent:{path:'/alice/status/123'}, relation:{path:'different', postId:'same'}}},
        {root:{postId:'123'}},
      ]});
      expect(redirected.open.mock.calls.slice(-2).map(c=>c[0])).toEqual([url,plain]);
    }

  });
  it('preserves fresh validated roots, quotes and sources after an actual false wait', async () => {
    const url = 'https://x.com/alice/status/123';
    const quote = '<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/bob">bob</a><a href="/bob">@bob</a></div><div data-testid="tweetText">quote</div><a href="/bob/status/456"><time>today</time></a></div>';
    const html = readHtml(post().replace('</article>', quote+'</article>'));
    for (const ready of [true, false]) {
      const f = fixture([readHtml(''), html], {wait:ready, afterWaitIndex:1});
      const tool = createXResearchTool({browser:f.context.browser, threadId:'thread', sources:f.context.sources, currentRunId:()=> 'run'});
      const result = await tool.execute('wait', {tabId:'research-tab', read:{objective:'read', targets:[{url}], includeArticle:false, includeReplies:false}}, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({targets:[{status:ready?'observed':'partial', reason:ready?null:'post_wait_timeout', stopReason:ready?'agent_stopped':'wait_timeout', root:{postId:'123', text:'original'}, quotedPosts:[{postId:'456', text:'quote'}], replies:{scope:{rootPostId:'123', stopReason:ready?'agent_stopped':'wait_timeout'}}}]});
      const row = result.details!.operation==='read' ? result.details!.targets[0] : undefined;
      expect(row?.documentSource).toMatchObject({sourceUrl:url, rootObservationId:row?.root?.observationId});
      expect(f.context.sources.get('123')!.map(s=>s.urlKind)).toEqual(['permalink','document']);
      expect(f.context.sources.get('456')![0]).toMatchObject({urlKind:'permalink', sourceUrl:'https://x.com/bob/status/456'});
      expect(f.collect).toHaveBeenCalledTimes(2);
    }
  });
  it('keeps normalized and ID-only actual root identity visible in projected SDK content', async () => {
    const actual = 'https://x.com/alice/status/123';
    const f = fixture([readHtml(post())], {finalUrl:()=>actual});
    const tool = createXResearchTool({browser:f.context.browser, threadId:'thread', sources:f.context.sources, currentRunId:()=> 'run'});
    for (const target of [{url:'https://twitter.com/old/status/123'}, {postId:'123'}]) {
      const result = await tool.execute('projection', {tabId:'research-tab', read:{objective:'a'.repeat(600000), targets:[target], includeArticle:false, includeReplies:false}}, undefined, undefined, {} as never);
      const model = JSON.parse((result.content[0] as any).text);
      expect(model.contentProjection).toBe('x_research_projection_v1');
      expect(model.targets[0].root).toMatchObject({postId:'123', sourceUrl:actual, authorHandle:'alice', text:'original'});
      expect(Buffer.byteLength(JSON.stringify(result))).toBe(result.details!.budgetUsage.outputBytes);
      expect(result.details!.objective.length).toBe(600000);
    }
  });
  it('propagates the actual auth, cancellation or adapter halt cause to untouched targets', async () => {
    const targets = Array.from({length:3},()=>({url:'https://x.com/alice/status/123'}));
    const auth = '<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input type="password" name="password"></div>';
    for (const cause of ['ordinary', 'auth', 'cancel', 'adapter'] as const) {
      const f = fixture([readHtml(post()+post('456','bob','rendered discussion'))]);
      const normalOpen = f.open.getMockImplementation()!;
      f.open.mockImplementation(async (...args) => {
        const opened = await normalOpen(...args);
        if (cause==='cancel' && f.open.mock.calls.length===2) return {...opened, nav:{requestedUrl:args[0], outcome:{kind:'cancelled'}}} as any;
        return opened;
      });
      const normalCollect = f.collect.getMockImplementation()!;
      f.collect.mockImplementation(async request => {
        if (f.open.mock.calls.length===2 && cause==='adapter') throw new TypeError('broken adapter');
        if (f.open.mock.calls.length===2 && cause==='auth') {
          const blocked = fixture([auth]);
          await blocked.open('https://x.com/i/jf/onboarding/web');
          return blocked.collect(request);
        }
        return normalCollect(request);
      });
      const tool = createXResearchTool({browser:f.context.browser, threadId:'thread', sources:f.context.sources, currentRunId:()=> 'run'});
      const result = await tool.execute('mixed', {tabId:'research-tab', read:{objective:'read', targets, includeArticle:false, includeReplies:true}}, undefined, undefined, {} as never);
      expect(result.details!.operation==='read' && result.details!.targets[0].root?.text).toBe('original');
      if (result.details!.operation!=='read') throw new Error('read expected');
      if (cause==='ordinary') {
        expect(result.details!.targets.map(t=>t.root?.text)).toEqual(['original','original','original']);
        expect(f.open).toHaveBeenCalledTimes(3);
      } else {
        const expected = cause==='auth' ? {status:'auth_required', reason:'auth_required', stopReason:'access_barrier'} : cause==='cancel' ? {status:'cancelled', reason:'cancelled', stopReason:'cancelled'} : {status:'failed', reason:'internal_adapter_error:collection', stopReason:'action_failed'};
        expect(result.details!.targets[1]).toMatchObject({...expected, root:null, replies:{scope:{stopReason:expected.stopReason}}});
        expect(result.details!.targets[2]).toMatchObject({status:expected.status, reason:cause==='auth'?'not_attempted:auth_required':cause==='cancel'?'cancelled':'internal_adapter_stopped', stopReason:expected.stopReason, root:null, replies:{scope:{stopReason:expected.stopReason}}});
        expect(f.open).toHaveBeenCalledTimes(2);
      }
    }
  });

  it('gives actually collected auth priority on history/media redirects and wait cancellation independent scope', async()=>{
    const plain='https://x.com/alice/status/123';
    const auth='<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input type="password" name="password"></div>';
    const read=(url:string)=>({tabId:'research-tab',read:{objective:'read',targets:[{url},{url:plain}],includeArticle:false,includeReplies:true}});
    const good=fixture([readHtml(''),readHtml(post())],{afterWaitIndex:1,wait:false});
    const goodTool=createXResearchTool({browser:good.context.browser,threadId:'thread',sources:good.context.sources,currentRunId:()=> 'run'});
    expect((await goodTool.execute('good',read(plain),undefined,undefined,{} as never)).details).toMatchObject({targets:[{root:{postId:'123'},stopReason:'wait_timeout'},{root:{postId:'123'},stopReason:'wait_timeout'}]});
    const delayedAuth='<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input type="password" name="password"></div>';
    const lateBarrier=fixture([readHtml(''),delayedAuth],{afterWaitIndex:1,wait:false});
    const lateWait=(lateBarrier.page.wait as any).getMockImplementation();
    (lateBarrier.page.wait as any).mockImplementation(async(...args:any[])=>{const result=await lateWait(...args);lateBarrier.navigate('https://x.com/i/jf/onboarding/web');return result;});
    const lateTool=createXResearchTool({browser:lateBarrier.context.browser,threadId:'thread',sources:lateBarrier.context.sources,currentRunId:()=> 'run'});
    expect((await lateTool.execute('lateAuth',read(plain),undefined,undefined,{} as never)).details).toMatchObject({targets:[{status:'auth_required',reason:'auth_required',stopReason:'access_barrier'},{status:'auth_required',reason:'not_attempted:auth_required',stopReason:'access_barrier'}]});
    const controller=new AbortController();
    const cancelled=fixture([readHtml(''),readHtml(post())],{afterWaitIndex:1,wait:false});
    const normalWait=(cancelled.page.wait as any).getMockImplementation();
    (cancelled.page.wait as any).mockImplementation(async(...args:any[])=>{const result=await normalWait(...args);controller.abort();return result;});
    const cancelledTool=createXResearchTool({browser:cancelled.context.browser,threadId:'thread',sources:cancelled.context.sources,currentRunId:()=> 'run'});
    const result=await cancelledTool.execute('cancelled',read(plain),controller.signal,undefined,{} as never);
    expect(result.details).toMatchObject({targets:[{root:null,status:'cancelled',reason:'cancelled',stopReason:'cancelled',replies:{scope:{stopReason:'cancelled'}}},{root:null,status:'cancelled',reason:'cancelled',stopReason:'cancelled',replies:{scope:{stopReason:'cancelled'}}}]});
    expect(cancelled.collect).toHaveBeenCalledTimes(1);expect(cancelled.open).toHaveBeenCalledTimes(1);
    for(const suffix of ['/history','/photo/1','/video/1']) {
      for(const html of [auth,'<main></main>']) {
        const f=fixture([html],{finalUrl:()=> 'https://x.com/i/jf/onboarding/web'});
        const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
        const result=await tool.execute('barrier',read(plain+suffix),undefined,undefined,{} as never);
        if(result.details!.operation!=='read') throw new Error('read expected');
        if(html===auth) {
          expect(result.details!.targets[0]).toMatchObject({status:'auth_required',reason:'auth_required',root:null,stopReason:'access_barrier'});
          expect(result.details!.targets[1].reason).toBe('not_attempted:auth_required');expect(f.open).toHaveBeenCalledTimes(1);
        } else {
          expect(result.details!.targets[0]).toMatchObject({status:'partial',root:null,reason:'unsupported_document_route',stopReason:'identity_unproven'});
          expect(f.open).toHaveBeenCalledTimes(2);
        }
      }
    }
  });

  it('stops further queries on an authoritative cancelled navigation receipt without an aborted signal',async()=>{
    const queries=Array.from({length:3},(_,i)=>({...searchInput.search.queries[0],id:String(i)}));
    const input={search:{...searchInput.search,queries,maxPostsPerQuery:1,maxScrollsPerQuery:0}};
    for(const cancelled of [false,true]) {
      const f=fixture([searchHtml(post())]);
      const normalOpen=f.open.getMockImplementation()!;
      f.open.mockImplementation(async(...args)=>{const opened=await normalOpen(...args);return cancelled && f.open.mock.calls.length===2 ? {...opened,nav:{requestedUrl:args[0],outcome:{kind:'cancelled'}}} as any : opened;});
      const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
      const result=await tool.execute('navigation',input,undefined,undefined,{} as never);
      if(result.details!.operation!=='search') throw new Error('search expected');
      expect(result.details!.queries[0]).toMatchObject({posts:[{postId:'123'}],status:'partial',stopReason:'budget_reached'});
      if(cancelled) {
        expect(result.details!.queries[1]).toMatchObject({status:'cancelled',stopReason:'cancelled',posts:[]});
        expect(result.details!.queries[2]).toMatchObject({status:'cancelled',stopReason:'cancelled',posts:[]});
        expect(f.open).toHaveBeenCalledTimes(2);expect(f.collect).toHaveBeenCalledTimes(1);
      } else {
        expect(result.details!.queries.map(q=>q.posts[0].postId)).toEqual(['123','123','123']);
        expect(f.open).toHaveBeenCalledTimes(3);expect(f.collect).toHaveBeenCalledTimes(3);
      }
      expect(f.act).toHaveBeenCalledTimes(0);
    }
  });

});


it('factory content and canonical details preserve distinct source scroll failures with saved evidence',async()=>{
  for(const cause of [null,'scroll_no_movement','scroll_ack_timeout','ordinary'] as const){
    const scrollError=cause===null?undefined:cause==='ordinary'?Object.assign(new KydogError('browser.wait_timeout','scroll_no_movement scroll_ack_timeout'),{reason:'scroll_no_movement'}):new BrowserScrollAcknowledgementError(cause,cause==='scroll_no_movement'?'scroll_ack_timeout':'scroll_no_movement');
    const f=await stagedFixture({article:'ok',scrollError});
    const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'actual-run'});
    const result=await tool.execute('typed-scroll',{tabId:'research-tab',read:{objective:'source outcome',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:true,includeReplies:true,maxExpandActionsPerPost:4,maxScrollsPerPost:1}},undefined,undefined,{} as never);
    const expected={status:'partial',reason:cause===null?'reply_budget_reached':cause==='ordinary'?'action_failed:browser.wait_timeout':cause,stopReason:cause===null?'budget_reached':cause==='scroll_ack_timeout'?'wait_timeout':'action_failed',root:{postId:'123',author:{handle:'alice'},text:'expanded body'},article:{bodyObserved:true,body:{postId:'456',sourceUrl:'https://x.com/bob/status/456',author:{handle:'bob'}}},replies:{observations:[{postId:'789'},{postId:'790'}],scope:{completeness:'unknown'}},budgetUsage:{scrolls:1,expandActions:3}};
    expect(result.details?.operation).toBe('read');
    if(result.details?.operation!=='read')throw new Error('Expected read result');
    expect(result.details.targets[0]).toMatchObject(expected);
    const model=JSON.parse((result.content[0] as {text:string}).text);
    expect(model.targets[0]).toMatchObject(expected);
  }
});

it('observes only the final serialized canonical result once and never observes rejected inputs',async()=>{
 const f=fixture([readHtml(post('123','alice','&quot;'.repeat(6000)))]);
 const received:import('../x/xResearchTypes').XResearchResult[]=[];
 const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run',observeResult:r=>received.push(r)});
 const r=await tool.execute('final',{tabId:'research-tab',read:{objective:'a'.repeat(1020000),targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:false}},undefined,undefined,{} as never);
 expect(received).toHaveLength(1);expect(received[0]).toBe(r.details);expect(received[0].contentProjection).toBe('x_research_projection_v1');expect(received[0].truncation.truncated).toBe(true);
 expect(Buffer.byteLength(JSON.stringify(r))).toBe(received[0].budgetUsage.outputBytes);
 await expect(tool.execute('invalid',{search:{},read:{}} as never,undefined,undefined,{} as never)).rejects.toThrow();expect(received).toHaveLength(1);
});

 it('refuses an inactive run before browser I/O without manufacturing provenance',async()=>{
  const f=fixture([searchHtml(post())]); let run:string|null='protocol-run';
  const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=>run});
  expect((await tool.execute('live',searchInput,undefined,undefined,{} as never)).details?.runId).toBe('protocol-run');
  run=null;
  await expect(tool.execute('idle',searchInput,undefined,undefined,{} as never)).rejects.toThrow('active run');
  expect(f.open).toHaveBeenCalledTimes(1);
 });

it('restores an owned tab, rejects a foreign binding and only replaces a missing tab on the next request',async()=>{
 const f=fixture([searchHtml(post())]);let status:'available'|'foreign'|'missing'='available';let retained:string|undefined='recovered-tab';
 const tool=createXResearchTool({browser:{...f.context.browser,tabStatus:()=>status},threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run',tabBinding:{get:()=>retained,set:id=>{retained=id;}}});
 await tool.execute('owned',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[0][1]).toBe('recovered-tab');
 status='foreign';await expect(tool.execute('foreign',searchInput,undefined,undefined,{} as never)).rejects.toThrow('another thread');expect(f.open).toHaveBeenCalledTimes(1);
 status='missing';const missing=await tool.execute('missing',searchInput,undefined,undefined,{} as never);expect(missing.details?.status).toBe('failed');expect(f.open).toHaveBeenCalledTimes(1);
 status='available';await tool.execute('new',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[1][1]).toBeUndefined();
});

it('retains earlier precise root preview inventory across later body expansion and an accurate selected attempt',async()=>{
 const card=(id:string)=>`<div role="link" tabindex="0" href="https://x.com/bob/status/${id}"><div data-testid="User-Name"><a href="/bob">bob</a><a href="/bob">@bob</a></div><img data-testid="article-cover-image"></div>`;
 const initial=post().replace('</article>','<button role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button>'+card('456')+card('789')+'</article>');
 const expanded=post('123','alice','expanded body').replace('</article>',card('456')+'</article>');
 const f=fixture([readHtml(initial),readHtml(expanded)]);const act=f.act.getMockImplementation()!;
 f.act.mockImplementation(async(...args)=>{if(f.act.mock.calls.length===2)throw new KydogError('browser.target_unusable','rejected exact entry');return act(...args);});
 const {XResearchEvidence}=await import('../x/xResearchEvidence');const evidence=new XResearchEvidence('/tmp',()=> 'run');
 const tool=createXResearchTool({browser:f.context.browser,threadId:'thread',sources:evidence.sources,currentRunId:()=> 'run',observeResult:r=>evidence.observe(r)});
 const r=await tool.execute('frames',{tabId:'research-tab',read:{objective:'frames',targets:[{url:'https://x.com/alice/status/123'}],includeReplies:false}},undefined,undefined,{} as never);
 expect(r.details).toMatchObject({targets:[{root:{text:'expanded body',articlePreviewInventory:{observed:1,retained:1,omitted:0}},article:{actionAttempted:true},articlePreviewObservations:expect.arrayContaining([expect.objectContaining({articlePreviewInventory:{scope:'collection',observed:2,retained:1,omitted:1,unresolved:0}})])}]});
 expect(()=>evidence.guard('/tmp/report.md','[source](https://x.com/alice/status/123)')).toThrow('inventory');
});

it('authoritative destruction during an action permits a new tab only on the following request',async()=>{
 const f=fixture([searchHtml(post())]);let present=true;
 const tool=createXResearchTool({browser:{...f.context.browser,tabStatus:()=>present?'available':'missing'},threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run'});
 await tool.execute('exists',searchInput,undefined,undefined,{} as never);expect(f.open).toHaveBeenCalledTimes(1);
 f.act.mockImplementationOnce(async()=>{present=false;throw new KydogError('browser.not_dispatchable','target destroyed');});
 const lost=await tool.execute('destroyed',searchInput,undefined,undefined,{} as never);expect(lost.details).toMatchObject({browserTabId:'research-tab',queries:[{posts:[{postId:'123'}],status:'partial'}]});expect(f.open).toHaveBeenCalledTimes(2);
 present=true;await tool.execute('next-request',searchInput,undefined,undefined,{} as never);expect(f.open.mock.calls[2][1]).toBeUndefined();
});
