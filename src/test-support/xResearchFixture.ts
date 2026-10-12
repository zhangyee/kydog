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
  const act=vi.fn(async (action:any) => {
    if(options.scrollError) throw options.scrollError;
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
