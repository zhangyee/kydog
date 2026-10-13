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
