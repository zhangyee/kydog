import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { createXResearchBrowser, type XOpenResult } from './xResearchBrowser';
import { readX } from './xResearchRead';
import { serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
import { XResearchEvidence } from './xResearchEvidence';
import { X_RESEARCH_MAX_OUTPUT_BYTES } from './xResearchTypes';

// Existing immersive source structure from xPage.test.ts, without conversation/tweetText root.
const articleHtml = (author = 'bob', body = 'Article paragraph') => `<main><article data-testid="tweet"><div data-testid="User-Name"><a href="/${author}">@${author}</a></div><article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">Same title</div><div data-testid="twitterArticleRichTextView"><div data-testid="longformRichTextComponent" contenteditable="false"><div data-block="true">${body}</div></div></div></article></article></main>`;
const url='https://x.com/bob/status/456';
function fixture() {
  let html=articleHtml(), rawUrl=url;
  const facts={currentUrl:url,documentEpoch:1,routeRevision:0,navigationSequence:1,navigationEvent:'did-navigate' as const,navigationType:'cross_document' as const,navigationUrl:url};
  const service={researchTabStatus:()=> 'available',
    enqueue:async(_id:string,work:()=>Promise<unknown>)=>work(),withAgentDriving:async(_id:string,_thread:string,work:()=>Promise<unknown>)=>work(),
    onTabDestroyed:()=>()=>{},onTabUnavailable:()=>()=>{},locationFacts:()=>({...facts}),prepareForDomRead:async()=>{},
    open:vi.fn(async(args:{url:string})=>({tabId:'tab',evicted:[],nav:{navigationId:'actual-navigation',startedAt:0,deadlineAt:1,outcome:{kind:'ok',finalUrl:args.url}}})),
    evalInPage:async(_id:string,code:string)=>{
      const dom=new JSDOM(html,{url:rawUrl,runScripts:'outside-only'});
      Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
      Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
      try{return dom.window.eval(code);}finally{dom.window.close();}
    },
    waitFor:vi.fn(async()=>true),dispatchAndObserveNavigation:vi.fn(async()=>{throw Error('No direct Article action');}),
  };
  const browser=createXResearchBrowser(service as never,'thread');
  const context={browser,threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map()};
  return {service,browser,context,facts,setHtml:(value:string)=>{html=value;},setRaw:(value:string)=>{rawUrl=value;}};
}

it('admits directly opened Article own body through the production port/read/serializer/evidence without a parent action',async()=>{
  const f=fixture();
  const input={tabId:'tab',read:{objective:'direct Article',targets:[{url}],includeArticle:true,includeReplies:true,maxRepliesPerPost:30,maxScrollsPerPost:2,maxExpandActionsPerPost:2}};
  const value=serializeXResearchResult(await readX(input,f.context));
  expect(value.result.targets[0]).toMatchObject({root:null,sourceUrl:url,status:'partial',reason:'direct_article_discussion_unobserved',article:{entryObserved:false,actionAttempted:false,navigationStarted:false,bodyObserved:true,entry:null,body:{postId:'456',sourceUrl:url,author:{handle:'bob'},text:'Article paragraph'},provenance:{kind:'direct_open',navigationId:'actual-navigation',sourceUrl:url}},replies:{observations:[],scope:{completeness:'unknown'}},budgetUsage:{distinctEntries:1,scrolls:0,expandActions:0}});
  expect(f.service.open).toHaveBeenCalledTimes(1);expect(f.service.waitFor).toHaveBeenCalledTimes(0);expect(f.service.dispatchAndObserveNavigation).toHaveBeenCalledTimes(0);
  const body=value.result.targets[0].article.body!;
  expect(value.result.targets[0].article.provenance?.bodyObservationId).toBe(body.observationId);
  expect(JSON.parse(value.text).targets[0].article.body.text).toBe('Article paragraph');
  const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(value.result);
  expect(ledger.observations).toContainEqual(expect.objectContaining({observationId:body.observationId,text:'Article paragraph',sourceUrl:url,containerKind:'article'}));
  expect(()=>ledger.guard('/tmp/report.md',`[article](${url})`)).not.toThrow();
  const restored=new XResearchEvidence('/tmp',()=> 'next');restored.restore([{type:'message',id:'branch',message:{role:'toolResult',toolName:'x_research',toolCallId:'call',isError:false,details:value.result}}]);
  expect(restored.observations).toContainEqual(expect.objectContaining({observationId:body.observationId,origin:'history',text:'Article paragraph'}));
  expect(()=>restored.guard('/tmp/report.md',`[article](${url})`)).not.toThrow();
  const excluded=await readX({...input,read:{...input.read,includeArticle:false,includeReplies:false}},f.context);
  expect(excluded.targets[0].article.body).toBeNull();
  const capped=serializeXResearchResult({...value.result,objective:'x'.repeat(900000)});
  expect(capped.result.contentProjection).toBe('x_research_projection_v1');
  expect(JSON.parse(capped.text).targets[0].article.provenance).toEqual(value.result.targets[0].article.provenance);
  expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
});

it('requires original same-tab open and exact requested/committed/current generation plus same-container author and body',async()=>{
  const f=fixture(),opened=await f.browser.open(url,'tab');
  const collect=(directOpen:XOpenResult|undefined=opened,tabId='tab',expectedUrl=url)=>f.browser.withPage(tabId,undefined,page=>page.collect({stage:'post',postId:'456',expectedUrl,directOpen}));
  expect((await collect()).article?.body.text).toBe('Article paragraph');
  for(const fake of [structuredClone(opened),{...opened},undefined]) {
    const request={stage:'post' as const,postId:'456',expectedUrl:url,...(fake?{directOpen:fake}:{})};
    expect((await f.browser.withPage('tab',undefined,page=>page.collect(request))).article).toBeNull();
  }
  expect((await collect(opened,'other-tab')).article).toBeNull();
  for(const key of ['documentEpoch','routeRevision','navigationSequence'] as const) {
    f.facts[key]++;expect((await collect()).article).toBeNull();f.facts[key]--;
  }
  f.setRaw('https://x.com/bob/status/457');expect((await collect()).article).toBeNull();f.setRaw(url);
  f.setHtml(articleHtml('mallory'));expect((await collect()).article).toBeNull();
  f.setHtml(articleHtml('bob',''));expect((await collect()).article).toBeNull();
  f.setHtml(articleHtml());
  const redirect=await f.browser.open('https://x.com/alice/status/456','tab');
  expect((await collect(redirect)).article).toBeNull();
  expect((await collect(opened,'tab','https://x.com/alice/status/456')).article).toBeNull();
  expect((await collect()).article?.body.text).toBe('Article paragraph');
});


it('retains failed actual navigation and rejects mismatched direct body provenance in restored evidence',async()=>{
  const f=fixture();
  const input={tabId:'tab',read:{objective:'direct',targets:[{url}],includeArticle:true,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}};
  const good=serializeXResearchResult(await readX(input,f.context));
  expect(good.result.targets[0]).toMatchObject({status:'observed',article:{bodyObserved:true}});
  const ledger=new XResearchEvidence('/tmp',()=> 'run');ledger.observe(good.result);
  expect(()=>ledger.guard('/tmp/report.md',`[body](${url})`)).not.toThrow();
  for (const field of ['sourceUrl','bodyObservationId'] as const) {
    const wrong=structuredClone(good.result);wrong.targets[0].article.provenance![field]='wrong';
    ledger.restore([{type:'message',message:{role:'toolResult',toolName:'x_research',isError:false,toolCallId:'call',details:wrong}}]);
    expect(()=>ledger.guard('/tmp/report.md',`[body](${url})`)).toThrow('unobserved');
  }
  f.service.open.mockResolvedValueOnce({tabId:'tab',evicted:[],nav:{navigationId:'failed-nav',startedAt:0,deadlineAt:1,outcome:{kind:'failed',error:'failed navigation'}}} as never);
  const failed=await readX(input,f.context);
  expect(failed.targets[0]).toMatchObject({status:'failed',reason:'navigation_failed',article:{bodyObserved:false,body:null},location:{committedNavigationOutcome:'failed'}});
  expect(f.service.open).toHaveBeenCalledTimes(2);
});

const ownLink=(href='/bob/status/456/analytics')=>`<div role="group"><div><a role="link" href="${href}">views</a></div></div>`;
const withIdentity=(identity=ownLink(),author='bob',body='Article paragraph')=>articleHtml(author,body).replace('<div data-testid="twitter-article-title">',identity+'<div data-testid="twitter-article-title">');
const directInput={tabId:'tab',read:{objective:'direct native identity',targets:[{url}],includeArticle:true,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}};

it('uses independent owned native identity after a real collector generation change and retains it through cap and SDK restore',async()=>{
  const f=fixture();f.setHtml(withIdentity());
  const original=f.service.evalInPage;let collections=0;
  f.service.evalInPage=async(...args)=>{const raw=await original(...args);if(args[1].startsWith('/* kydog-x-root-release */')) return raw;if(++collections===1){f.facts.routeRevision++;f.facts.navigationSequence+=2;}return raw;};
  const value=serializeXResearchResult(await readX(directInput,f.context));
  const row=value.result.targets[0];
  expect(row).toMatchObject({status:'observed',root:null,article:{bodyObserved:true,entryObserved:false,actionAttempted:false,navigationStarted:false,body:{text:'Article paragraph'},provenance:{navigationId:'actual-navigation',nativeIdentity:{kind:'owned_analytics',href:'/bob/status/456/analytics',documentGeneration:'1:1:3'}}},collectionTransitions:[{outcome:'same_url_generation_changed',rereadRequested:true}]});
  expect(collections).toBe(2);
  const capped=serializeXResearchResult({...value.result,objective:'x'.repeat(900000)});
  expect(JSON.parse(capped.text).targets[0].article.provenance).toEqual(row.article.provenance);
  expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
  const {SessionManager}=await import('@earendil-works/pi-coding-agent');
  const manager=SessionManager.inMemory('/tmp');manager.appendMessage({role:'user',content:'read',timestamp:0});
  const append=(details:unknown)=>manager.appendMessage({role:'toolResult',toolName:'x_research',toolCallId:'call',isError:false,content:[{type:'text',text:value.text}],details,timestamp:1});
  append(value.result);
  const ledger=new XResearchEvidence('/tmp',()=> 'restored');ledger.restore(manager.getBranch());
  expect(ledger.observations).toContainEqual(expect.objectContaining({text:'Article paragraph',observationId:row.article.body!.observationId,origin:'history'}));
  expect(()=>ledger.guard('/tmp/report.md',`[body](${url})`)).not.toThrow();
  for(const bad of [{kind:'owned_analytics',href:'/bob/status/457/analytics',documentGeneration:'1:1:3'},{kind:'owned_analytics',href:'/bob/status/456/analytics',documentGeneration:'1:0:1'},{kind:'unknown'},null]) {
    const wrong=structuredClone(value.result);Object.assign(wrong.targets[0].article.provenance!,{nativeIdentity:bad});
    const branch=SessionManager.inMemory('/tmp');branch.appendMessage({role:'toolResult',toolName:'x_research',toolCallId:'call',isError:false,content:[{type:'text',text:''}],details:wrong,timestamp:1});
    ledger.restore(branch.getBranch());expect(()=>ledger.guard('/tmp/report.md',`[body](${url})`)).toThrow('unobserved');
  }
});

it('never ignores conflicting owned identity, and never substitutes content links or weak open facts',async()=>{
  const f=fixture();f.setHtml(withIdentity());const opened=await f.browser.open(url,'tab');
  const collect=(directOpen=opened,tab='tab')=>f.browser.withPage(tab,undefined,page=>page.collect({stage:'post',expectedUrl:url,postId:'456',directOpen}));
  expect((await collect()).article?.body.text).toBe('Article paragraph');
  for(const href of ['/bob/status/457/analytics','/alice/status/456/analytics','https://twitter.com/bob/status/456/analytics','https://evil.test/bob/status/456/analytics','/bob/status/456/analytics?q=1','/bob/status/456/analytics#x','/bob/status/456','bad']) {
    f.setHtml(withIdentity(ownLink(href)));expect((await collect()).article).toBeNull();
  }
  f.setHtml(withIdentity(ownLink()+ownLink()));expect((await collect()).article).toBeNull();
  f.setHtml(withIdentity());f.facts.routeRevision++;f.facts.navigationSequence++;
  expect((await collect()).article?.body.text).toBe('Article paragraph');
  for(const html of [articleHtml(),articleHtml('bob','Article paragraph'+ownLink()),withIdentity(`<article data-testid="tweet">${ownLink()}</article>`),withIdentity(`<div role="link" tabindex="0">${ownLink()}</div>`),withIdentity(`<article data-testid="twitterArticleReadView">${ownLink()}</article>`),withIdentity(ownLink(),'alice'),withIdentity(ownLink(),'bob','')]) {
    f.setHtml(html);expect((await collect()).article).toBeNull();
  }
  f.setHtml(withIdentity());
  expect((await f.browser.withPage('tab',undefined,page=>page.collect({stage:'post',postId:'456',expectedUrl:url}))).article).toBeNull();
  expect((await collect({...opened})).article).toBeNull();expect((await collect(structuredClone(opened))).article).toBeNull();expect((await collect(opened,'other')).article).toBeNull();
  f.facts.documentEpoch++;expect((await collect()).article).toBeNull();f.facts.documentEpoch--;
  f.setRaw('https://x.com/bob/status/457');expect((await collect()).article).toBeNull();f.setRaw(url);
  expect((await collect()).article?.body.text).toBe('Article paragraph');
  f.setHtml(withIdentity(ownLink('x'.repeat(9000))));
  await expect(collect()).rejects.toMatchObject({code:'x.invalid_page'});
  f.setHtml(withIdentity());
  const original=f.service.evalInPage;
  for(const ownIdentityLinks of [{totalKnown:2,hrefs:['/bob/status/456/analytics']},{totalKnown:1,hrefs:[]},{totalKnown:1,hrefs:[null]},{totalKnown:0,hrefs:['/bob/status/456/analytics']}]) {
    f.service.evalInPage=async(...args)=>{const raw=await original(...args) as {article:{ownIdentityLinks:unknown}};if(args[1].startsWith('/* kydog-x-root-release */')) return raw;raw.article.ownIdentityLinks=ownIdentityLinks;return raw;};
    expect((await collect()).article).toBeNull();
  }
  f.service.evalInPage=async(...args)=>{const raw=await original(...args);if(args[1].startsWith('/* kydog-x-root-release */')) return raw;f.facts.routeRevision++;return raw;};
  await expect(collect()).rejects.toMatchObject({code:'browser.stale_snapshot'});
});
