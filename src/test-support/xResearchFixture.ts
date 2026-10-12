import { JSDOM } from 'jsdom';
import { vi } from 'vitest';
import { decodeXPage, xPageExpression, type XPageRequest } from '../main/x/xPageSource';
import type { XResearchBrowser, XQueuedPage } from '../main/x/xResearchBrowser';
import type { XResearchContext } from '../main/x/xResearchSearch';

export const query = { id:'q2', query:'scientific agents', purpose:'find accounts', product:'Latest' as const };
export const searchInput = { search:{objective:'research', queries:[query], maxPostsPerQuery:10, maxScrollsPerQuery:1} };
export function post(id='123', name='alice', text='original') {
  return `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${name}">${name}</a><a href="/${name}">@${name}</a></div><div data-testid="tweetText">${text}</div><a href="/${name}/status/${id}"><time>today</time></a></article>`;
}
export const searchHtml = (body:string, product='Latest') => `<main><div data-testid="primaryColumn"><div role="tablist"><a role="tab" aria-selected="true">${product}</a></div>${body}</div></main>`;
export const readHtml = (body:string) => `<main><div data-testid="primaryColumn"><div aria-label="Timeline: Conversation">${body}</div></div></main>`;
export function fixture(pages:string[], options:{finalUrl?:(url:string)=>string; selectedProduct?:string; collectErrorAt?:number; scrollError?:Error; wait?:boolean; afterWaitIndex?:number}={}) {
  let url='https://x.com/home', index=0, collects=0, revision=7, sequence=9;
  const collect = vi.fn(async (request:XPageRequest) => {
    if (collects++===options.collectErrorAt) throw new TypeError('broken adapter');
    const html=pages[Math.min(index,pages.length-1)];
    const dom=new JSDOM(html,{url,runScripts:'outside-only'});
    Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
    Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
    const raw=dom.window.eval(xPageExpression(request));
    return decodeXPage(raw,request,{currentUrl:url,documentEpoch:3,routeRevision:revision,navigationSequence:sequence,navigationEvent:'did-navigate',navigationType:'cross_document',navigationUrl:url},false);
  });
  const act=vi.fn(async (action:any, _snapshot?:unknown, actOptions?:import('../main/x/xResearchBrowser').XActionOptions) => {
    if(options.scrollError) throw options.scrollError;
    if(action.kind==='scroll') actOptions?.scrollAcknowledgement?.onWritten();
    index++; return {action,line:'executed',navigation:null};
  });
  const page={collect,act,wait:vi.fn(async()=>{if(options.afterWaitIndex!==undefined) index=options.afterWaitIndex;return options.wait??true;}),location:()=>({currentUrl:url,documentEpoch:3,routeRevision:revision,navigationSequence:sequence,navigationEvent:'did-navigate',navigationType:'cross_document',navigationUrl:url})} as unknown as XQueuedPage;
  const open=vi.fn(async (requested:string,tabId?:string)=>{
    url=options.finalUrl?.(requested)??requested; index=0;
    return {tabId:tabId??'research-tab',evicted:[],nav:{requestedUrl:requested,outcome:{kind:'ok',finalUrl:url}}};
  });
  const browser={open,withPage:vi.fn(async (_id:string,_signal:unknown,work:(p:XQueuedPage)=>Promise<unknown>)=>work(page))} as unknown as XResearchBrowser;
  const context:XResearchContext={browser,threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map()};
  return {context,open,act,collect,page,navigate:(next=url)=>{url=next;revision++;sequence+=2;},currentUrl:()=>url};
}

/** Offline BrowserService boundary: the production port owns provenance and bindings. */
export async function stagedFixture(options: { scrollError?: Error; article?: 'ok'|'reject'|'nav-failed'|'auth'|'wrong-author'|'title-only'; virtualize?: boolean; abortAfterAction?: AbortController; noEffect?: boolean; resetOnReturn?: boolean; staleInitial?: number; staleReturn?: number; staleArticle?: number; returnDifferentUrl?: boolean; abortOnReturnCollect?: AbortController; returnWait?: boolean; waitResult?: boolean; discussion?: 'ready'|'never'|'auth'|'missing'|'route'|'cancel'|'stale'|'late'; discussionAbort?: AbortController } = {}) {
  const { createXResearchBrowser } = await import('../main/x/xResearchBrowser');
  const { KydogError } = await import('../shared/errors');
  const parentUrl='https://x.com/alice/status/123', articleUrl='https://x.com/bob/status/456';
  const author=(name:string)=>`<div data-testid="User-Name"><a href="/${name}">@${name}</a></div>`;
  const entry=`<div role="link" tabindex="0">${author('bob')}<div data-testid="article-cover-image">Article preview</div></div>`;
  const bodyButton='<button role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button>';
  const replyButton='<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>';
  let discussionReady=!options.discussion;
  let expanded=false, replies=false, url=parentUrl, generation=1, current:any;
  const parent=()=>readHtml(post('123','alice',expanded?'expanded body':'preview').replace('</article>',(expanded?'':bodyButton)+(options.article?entry:'')+'</article>')+(discussionReady?post('789','carol','first reply')+(replies?post('790','dave','second reply'):replyButton):''));
  const render=(html:string)=>{
    current=new JSDOM(html,{url,runScripts:'outside-only'});
    Object.defineProperty(current.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
    Object.defineProperty(current.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  };
  const facts=()=>({currentUrl:url,documentEpoch:generation,routeRevision:0,navigationSequence:generation,navigationEvent:'did-navigate' as const,navigationType:'cross_document' as const,navigationUrl:url});
  const nav=(finalUrl:string)=>({navigationId:String(generation),startedAt:0,deadlineAt:1,outcome:{kind:'ok' as const,finalUrl}});
  render(parent());
  const executed:string[]=[], opens:string[]=[];
  let entryGeneration:string|null=null;
  const stale={initial:options.staleInitial??0,returned:options.staleReturn??0,article:options.staleArticle??0};
  let collections=0, waits=0, discussionCollections=0;
  const service={researchTabStatus:()=>'available',
    enqueue:async(_id:string,work:()=>Promise<unknown>)=>work(), withAgentDriving:async(_id:string,_thread:string,work:()=>Promise<unknown>)=>work(),
    onTabDestroyed:()=>()=>{},onTabUnavailable:()=>()=>{},locationFacts:facts,prepareForDomRead:async()=>{},
    evalInPage:async(_id:string,code:string)=>{
      collections++;
      if(options.discussion && expanded && url===parentUrl && ++discussionCollections>1) {
        if(options.discussion==='ready' || options.discussion==='late'){discussionReady=true;render(parent());}
        if(options.discussion==='missing') render(readHtml(post('999','eve','replacement')));
        if(options.discussion==='route'){url='https://x.com/alice/status/123/history';current.reconfigure({url});}
        if(options.discussion==='cancel') options.discussionAbort!.abort();
      }
      if(options.discussion==='auth' && discussionCollections===1) setTimeout(()=>{url='https://x.com/i/jf/onboarding/web';generation++;render('<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input name="password" type="password"></div>');},0);
      const raw=current.window.eval(code);
      if(options.discussion==='stale' && discussionCollections>1) generation++;
      if(options.discussion==='late' && discussionCollections>1) await new Promise(resolve=>setTimeout(resolve,8001));
      const phase=url===articleUrl?'article':opens.length>1?'returned':'initial';
      if(stale[phase]>0){stale[phase]--;generation++;if(phase==='returned'&&options.returnDifferentUrl){url='https://x.com/mallory/status/999';current.reconfigure({url});}if(phase==='returned') options.abortOnReturnCollect?.abort();}
      return raw;
    },waitFor:async()=>{waits++;if(options.returnWait && opens.length>1) render(parent());return options.waitResult??true;},
    open:async(args:any)=>{opens.push(args.url);url=args.url;generation++;if(options.resetOnReturn && opens.length>1) expanded=false;render(options.returnWait && opens.length>1?readHtml(''):parent());return {tabId:'research-tab',evicted:[],nav:nav(url)};},
    dispatchAndObserveNavigation:async(_id:string,action:any,snapshot:any,dispatchOptions?:import('../main/browser/browserService').BrowserDispatchOptions)=>{
      const purpose=snapshot.nodes.find((n:any)=>n.index===action.index)?.collectedPermission?.purpose;
      if (purpose==='article_entry') {
        entryGeneration=snapshot.generation;
        if(options.article==='reject') throw new KydogError('browser.target_unusable','Safety rejected');
        executed.push(purpose);
        if(options.article==='nav-failed') return {line:'clicked',navigation:{navigationId:'failed',outcome:{kind:'failed',error:'navigation failed'}}};
        url=options.article==='auth'?'https://x.com/i/jf/onboarding/web':articleUrl;generation++;
        render(options.article==='auth'?'<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input name="password" type="password"></div>':`<main><article data-testid="tweet">${author(options.article==='wrong-author'?'mallory':'bob')}<article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">Same title</div><div data-testid="twitterArticleRichTextView"><div data-testid="longformRichTextComponent" contenteditable="false">${options.article==='title-only'?'':'<div data-block="true">Article paragraph</div><h2 data-block="true">Heading</h2>'}</div></div></article></article></main>`);
        return {line:'clicked',navigation:nav(url)};
      }
      executed.push(purpose??action.kind);
      if(action.kind==='scroll') { dispatchOptions?.scrollAcknowledgement?.onWritten(); if(options.scrollError) throw options.scrollError; }
      if(purpose==='body_expand') expanded=true;
      if(purpose==='replies_expand') replies=true;
      if (!options.noEffect) render(options.virtualize && action.kind==='scroll'?readHtml(post('999','eve','replacement reply')):parent());
      options.abortAfterAction?.abort();
      return {line:'executed',navigation:null};
    },
  };
  const browser=createXResearchBrowser(service as never,'thread');
  const context:XResearchContext={browser,threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map(),signal:options.abortAfterAction?.signal??options.abortOnReturnCollect?.signal??options.discussionAbort?.signal};
  return {context,executed,opens,entryGeneration:()=>entryGeneration,collections:()=>collections,waits:()=>waits};
}
