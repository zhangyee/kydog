import { JSDOM } from 'jsdom';
import {randomUUID} from 'node:crypto';
import type {XTextObservation} from '../main/x/xResearchTypes';
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
export function fixture(pages:string[], options:{finalUrl?:(url:string)=>string; collectErrorAt?:number; scrollError?:Error; wait?:boolean; afterWaitIndex?:number; unscopedAfterIndex?:number}={}) {
  let url='https://x.com/home', index=0, collects=0, revision=7, sequence=9;
  let readProof:import('../main/x/xNetworkSource').XNetworkProvenance|undefined;
  const collect = vi.fn(async (request:XPageRequest) => {
    if (collects++===options.collectErrorAt) throw new TypeError('broken adapter');
    const html=pages[Math.min(index,pages.length-1)];
    const dom=new JSDOM(html,{url,runScripts:'outside-only'});
    Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
    Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
    const raw=dom.window.eval(xPageExpression(request));
    const observation=decodeXPage(raw,request,{currentUrl:url,documentEpoch:3,routeRevision:revision,navigationSequence:sequence,navigationEvent:'did-navigate',navigationType:'cross_document',navigationUrl:url},{parentArticle:false});
    // Legacy output/SDK unit fixtures are DTO test doubles, NOT captured wire
    // evidence. The dedicated xNetwork* tests exercise real source decoding.
    if(request.stage==='search'){
      const provenance={leaseId:'fixture-lease',requestRef:randomUUID(),navigationId:'fixture-document',documentEpoch:3,routeRevision:revision,navigationSequence:sequence,operation:'SearchTimeline',observedAt:'2026-10-15T00:00:00Z'};
      const posts:XTextObservation[]=[...dom.window.document.querySelectorAll('article[data-testid="tweet"]')].map(el=>{
        const stamp=el.querySelector('a[href] time')?.parentElement as HTMLAnchorElement;const m=/\/(\w+)\/status\/(\d+)/.exec(stamp?.href??'');if(!m)return null;
        const text=el.querySelector('[data-testid="tweetText"]')?.textContent??'';
        const previews=[...el.querySelectorAll('[role="link"][tabindex="0"]')].filter(a=>a.querySelector('[data-testid="article-cover-image"]')).map(a=>({entryObservationId:randomUUID(),parentPostId:m[2],sourceUrl:stamp.href,targetUrl:a.getAttribute('href')?new URL(a.getAttribute('href')!,url).href:null}));
        return {sourceKind:'page_graphql',networkProvenance:provenance,observationId:randomUUID(),postId:m[2],sourceUrl:stamp.href,author:{handle:m[1],displayName:m[1],profileUrl:`https://x.com/${m[1]}`},containerKind:'root_post',text,observedAt:provenance.observedAt,truncation:{returned:text.length,totalKnown:text.length,truncated:false},...(previews.length?{articlePreviews:previews,articlePreviewInventory:{scope:'collection',observed:previews.length,retained:previews.length,omitted:0,unresolved:0}}:{})} as XTextObservation;
      }).filter((p):p is XTextObservation=>p!==null);
      if(posts.length){observation.network={pages:[{provenance,inputCursor:null,outputCursor:'fixture',end:'unknown',posts,quotedPosts:[],unsupported:[]}],proof:provenance};observation.identityProven=true;}
    }
    if(request.stage==='post'&&!observation.article){
      // Explicit network DTO double for orchestration/evidence tests. HTML here is
      // test input only; production never derives network text or relations from DOM.
      const provenance={leaseId:'fixture-read-'+revision,requestRef:randomUUID(),navigationId:'fixture-document',documentEpoch:3,routeRevision:revision,navigationSequence:sequence,operation:'TweetDetail',observedAt:'2026-10-15T00:00:00Z'};
      const current=/^https:\/\/(?:x.com|twitter.com)\/(\w+)\/status\/(\d+)(?:\/history)?\/?$/.exec(url);
      const textOf=(el:Element,kind:'root_post'|'reply'|'quoted_post'):XTextObservation|null=>{
        const own=(selector:string)=>[...el.querySelectorAll(selector)].filter(n=>n.closest('[role="link"][tabindex="0"],article[data-testid="tweet"]')===el);
        const stamp=own('a[href] time')[0]?.parentElement as HTMLAnchorElement;const m=/^https:\/\/(?:x.com|twitter.com)\/(\w+)\/status\/(\d+)(?:\/history)?$/.exec(stamp?.href??'');
        const handles=own('[data-testid="User-Name"] a[href]').map(a=>new URL((a as HTMLAnchorElement).href).pathname.slice(1));
        if(!m||!handles.includes(m[1]))return null;
        const text=own('[data-testid="tweetText"]').map(n=>n.textContent??'').join('\n');
        const hasPreview=!!el.querySelector('[data-testid="article-cover-image"]');
        const base={observationId:randomUUID(),sourceKind:'page_graphql' as const,networkProvenance:provenance,postId:m[2],sourceUrl:stamp.href,author:{handle:m[1],displayName:m[1],profileUrl:`https://x.com/${m[1]}`},...(hasPreview?{articlePreviewInventory:{scope:'collection' as const,observed:0,retained:0,omitted:0,unresolved:1}}:{}),text,observedAt:provenance.observedAt,truncation:{returned:text.length,totalKnown:text.length,truncated:false}};
        return kind==='reply'?{...base,containerKind:kind,directParent:{postId:request.postId,sourceUrl:null},conversationId:request.postId}:{...base,containerKind:kind};
      };
      const roots=[...dom.window.document.querySelectorAll('[aria-label="Timeline: Conversation"] article[data-testid="tweet"]')].filter(el=>!el.parentElement?.closest('article[data-testid="tweet"]'));
      const candidates=roots.map(el=>textOf(el,'root_post')).filter((p):p is XTextObservation=>!!p);
      const root=candidates.find(p=>p.postId===request.postId&&current?.[1]===p.author?.handle&&current?.[2]===p.postId)??null;
      if(root)readProof=provenance;
      const replies=request.collectReplies===false?[]:roots.map(el=>textOf(el,'reply')).filter((p):p is XTextObservation=>!!p&&p.postId!==request.postId);
      const quotePairs=roots.flatMap(el=>[...el.querySelectorAll('[role="link"][tabindex="0"]')].map(q=>({quote:textOf(q,'quoted_post'),parent:textOf(el,'root_post')?.postId}))).filter(p=>!!p.quote&&!!p.parent);
      const quotes=quotePairs.map(p=>p.quote!);
      const quoteParents=Object.fromEntries(quotePairs.map(p=>[p.quote!.observationId,p.parent!]));
      const unscopedPosts=(!readProof||index===(options.unscopedAfterIndex??-1))&&request.collectReplies!==false?replies.map(p=>({...p,containerKind:'unscoped_post' as const,relationToTarget:'unproven' as const,observedContainer:'post' as const})):[];
      const networkPage={unsupported:[],provenance,inputCursor:index?'fixture-'+(index-1):null,outputCursor:'fixture-'+index,end:'unknown' as const,posts:[...(root?[root]:[]),...replies],root,replies:readProof&&index!==options.unscopedAfterIndex?replies:[],quotedPosts:quotes,quoteParents,unscopedPosts,branchKey:null,sortKey:'Relevance',continuationKind:'Bottom' as const,terminationDirections:[]};
      observation.root=root;observation.replies=replies;observation.quotedPosts=quotes;
      observation.identityProven=!!readProof&&readProof.routeRevision===revision;
      observation.network={pages:[networkPage],proof:readProof??provenance};
    }
    return observation;
  });
  const act=vi.fn(async (action:any, _snapshot?:unknown, actOptions?:import('../main/x/xResearchBrowser').XActionOptions) => {
    if(options.scrollError) throw options.scrollError;
    if(action.kind==='scroll') actOptions?.scrollAcknowledgement?.onWritten();
    index++; return {action,line:'executed',navigation:null};
  });
  const page={collect,act,wait:vi.fn(async()=>{if(options.afterWaitIndex!==undefined) index=options.afterWaitIndex;return options.wait??true;}),location:()=>({currentUrl:url,documentEpoch:3,routeRevision:revision,navigationSequence:sequence,navigationEvent:'did-navigate',navigationType:'cross_document',navigationUrl:url})} as unknown as XQueuedPage;
  const open=vi.fn(async (requested:string,tabId?:string)=>{
    url=options.finalUrl?.(requested)??requested; index=0;readProof=undefined;
    return {tabId:tabId??'research-tab',evicted:[],nav:{requestedUrl:requested,outcome:{kind:'ok',finalUrl:url}}};
  });
  const browser={open,withPage:vi.fn(async (_id:string,_signal:unknown,work:(p:XQueuedPage)=>Promise<unknown>)=>work(page))} as unknown as XResearchBrowser;
  const context:XResearchContext={browser,threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map()};
  return {context,open,act,collect,page,navigate:(next=url)=>{url=next;revision++;sequence+=2;},currentUrl:()=>url};
}

/** Offline BrowserService boundary: the production port owns provenance and bindings. */
export async function stagedFixture(options: { semanticLabels?: boolean; scrollError?: Error; article?: 'ok'|'reject'|'nav-failed'|'auth'|'wrong-author'|'title-only'; virtualize?: boolean; abortAfterAction?: AbortController; noEffect?: boolean; resetOnReturn?: boolean; staleInitial?: number; staleReturn?: number; staleArticle?: number; returnDifferentUrl?: boolean; abortOnReturnCollect?: AbortController; returnWait?: boolean; waitResult?: boolean; discussion?: 'ready'|'never'|'auth'|'missing'|'route'|'cancel'|'stale'|'late'; discussionAbort?: AbortController } = {}) {
  const { createXResearchBrowser } = await import('../main/x/xResearchBrowser');
  const { KydogError } = await import('../shared/errors');
  const parentUrl='https://x.com/alice/status/123', articleUrl='https://x.com/bob/status/456';
  const author=(name:string)=>`<div data-testid="User-Name"><a href="/${name}">@${name}</a></div>`;
  const entry=`<div role="link" tabindex="0">${author('bob')}<div data-testid="article-cover-image">Article preview</div></div>`;
  const bodyButton='<button role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button>';
  const replyButton='<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>';
  let discussionReady=!options.discussion;
  let expanded=false, replies=false, url=parentUrl, generation=1, current:any;
  const parent=()=>readHtml(post('123','alice',expanded?'expanded body':'preview').replace('</article>',(expanded?'':bodyButton)+(options.article?entry:'')+'</article>')+(discussionReady?post('789','carol','first reply')+(replies?post('790','dave','second reply'):replyButton):'')+(options.semanticLabels?`<div role="status">${expanded?'terminal End of conversation':'initial 回复'}</div>`:''));
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
  let network:import('../main/browser/networkResponses').BrowserNetworkLease|undefined;
  let accepts:((r:import('../main/browser/networkResponses').BrowserNetworkRequest)=>boolean)|undefined;
  const networkEvents:import('../main/browser/networkResponses').BrowserNetworkEvent[]=[];
  let pageNumber=0,lastCollected=-1;
  const emitRead=()=>{
    if(!accepts||url!==parentUrl||lastCollected===collections)return;
    lastCollected=collections;
    const input=pageNumber===0?null:'derived-'+(pageNumber-1),output='derived-'+pageNumber;
    const variables={focalTweetId:'123',rankingMode:'Relevance',...(input?{cursor:input}:{})};
    const request={id:'derived-'+pageNumber,requestId:'derived-'+pageNumber,sessionId:null,isMainFrame:true,redirectIndex:0,frameId:'frame',loaderId:String(generation),navigationId:String(generation),location:facts(),method:'GET',url:'https://x.com/i/api/graphql/derived/TweetDetail?variables='+encodeURIComponent(JSON.stringify(variables))};
    if(!accepts(request))return;
    const wire=derivedReadWire(current.window.document,'123',output);
    networkEvents.push({kind:'response',request,status:200,retryAfterMs:null,body:JSON.stringify(wire),bytes:Buffer.byteLength(JSON.stringify(wire)),sha256:'a'.repeat(64)});pageNumber++;
  };
  const service={researchTabStatus:()=>'available',
    enqueue:async(_id:string,work:()=>Promise<unknown>)=>work(), withAgentDriving:async(_id:string,_thread:string,work:()=>Promise<unknown>)=>work(),
    onTabDestroyed:()=>()=>{},onTabUnavailable:()=>()=>{},locationFacts:facts,prepareForDomRead:async()=>{},
    evalInPage:async(_id:string,code:string)=>{
      if(code.startsWith('/* kydog-x-root-release */')) return current.window.eval(code);
      collections++;
      if(options.discussion && expanded && url===parentUrl && ++discussionCollections>1) {
        if(options.discussion==='ready' || options.discussion==='late'){discussionReady=true;render(parent());}
        if(options.discussion==='missing') render(readHtml(post('999','eve','replacement')));
        if(options.discussion==='route'){url='https://x.com/alice/status/123/history';current.reconfigure({url});}
        if(options.discussion==='cancel') options.discussionAbort!.abort();
      }
      if(options.discussion==='auth' && discussionCollections===1) setTimeout(()=>{url='https://x.com/i/jf/onboarding/web';generation++;render('<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input name="password" type="password"></div>');},0);
      emitRead();
      const raw=current.window.eval(code);
      if(options.discussion==='stale' && discussionCollections>1) generation++;
      if(options.discussion==='late' && discussionCollections>1) await new Promise(resolve=>setTimeout(resolve,8001));
      const phase=url===articleUrl?'article':opens.length>1?'returned':'initial';
      if(stale[phase]>0){stale[phase]--;generation++;if(phase==='returned'&&options.returnDifferentUrl){url='https://x.com/mallory/status/999';current.reconfigure({url});}if(phase==='returned') options.abortOnReturnCollect?.abort();}
      return raw;
    },waitFor:async()=>{waits++;if(options.returnWait && opens.length>1) render(parent());return options.waitResult??true;},
    open:async(args:any)=>{opens.push(args.url);url=args.url;generation++;if(options.resetOnReturn && opens.length>1) expanded=false;render(options.returnWait && opens.length>1?readHtml(''):parent());
      accepts=args.network?.accepts;pageNumber=0;lastCollected=-1;networkEvents.length=0;
      network=accepts?{id:'derived',tabId:'research-tab',drain:async()=>networkEvents.splice(0),take:async()=>{const event=networkEvents.shift();if(!event)throw Error('timeout');return event;},close:async()=>{networkEvents.length=0;}}:undefined;
      emitRead();return {tabId:'research-tab',evicted:[],nav:nav(url),networkLease:network};},
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

/** Structural derivation for native orchestration doubles; never captured wire evidence. */
export function derivedReadWire(document:Document,postId:string,cursor:string):unknown {
 const entries=[...document.querySelectorAll('[aria-label="Timeline: Conversation"] article[data-testid="tweet"]')].filter(el=>!el.parentElement?.closest('article[data-testid="tweet"]')).flatMap(el=>{
  const own=(q:string)=>[...el.querySelectorAll(q)].filter(n=>n.closest('article[data-testid="tweet"],[role="link"][tabindex="0"]')===el);
  const href=own('a[href] time')[0]?.parentElement?.getAttribute('href');const m=/^\/(\w+)\/status\/(\d+)/.exec(href??'');if(!m)return [];
  const text=own('[data-testid="tweetText"]').map(n=>n.textContent??'').join('\n');
  return [{content:{entryType:'TimelineTimelineItem',itemContent:{itemType:'TimelineTweet',tweet_results:{result:{__typename:'Tweet',rest_id:m[2],core:{user_results:{result:{__typename:'User',core:{screen_name:m[1],name:m[1]}}}},legacy:{id_str:m[2],full_text:text,conversation_id_str:postId,...(m[2]!==postId?{in_reply_to_status_id_str:postId}:{})}}}}}}];
 });
 return {data:{threaded_conversation_with_injections_v2:{instructions:[{type:'TimelineAddEntries',entries:[...entries,{content:{entryType:'TimelineTimelineCursor',cursorType:'Bottom',value:cursor}}]}]}}};
}

/** A labeled response derivation for native adapter tests, with real lease binding. */
export function withDerivedReadNetwork(service:any,document:()=>Document,facts:()=>any):any {
 const open=service.open, evaluate=service.evalInPage;
 let accepts:((r:any)=>boolean)|undefined,pageNumber=0,postId='';
 const events:import('../main/browser/networkResponses').BrowserNetworkEvent[]=[];
 const emit=()=>{
  if(!accepts)return;
  const location=facts(),request={id:'derived-'+pageNumber,requestId:'derived-'+pageNumber,sessionId:null,isMainFrame:true,redirectIndex:0,frameId:'frame',loaderId:String(location.documentEpoch),navigationId:String(location.documentEpoch),location:{...location},method:'GET',url:'https://x.com/i/api/graphql/derived/TweetDetail?variables='+encodeURIComponent(JSON.stringify({focalTweetId:postId,rankingMode:'Relevance',...(pageNumber?{cursor:'derived-'+(pageNumber-1)}:{})}))};
  if(!accepts(request))return;
  const body=JSON.stringify(derivedReadWire(document(),postId,'derived-'+pageNumber++));
  events.push({kind:'response',request,status:200,retryAfterMs:null,body,bytes:Buffer.byteLength(body),sha256:'a'.repeat(64)});
 };
 service.open=async(args:any)=>{
  const result=await open(args);accepts=args.network?.accepts;postId=/\/status\/(\d+)/.exec(args.url)?.[1]??'';pageNumber=0;events.length=0;
  const source={id:'derived',tabId:result.tabId,drain:async()=>events.splice(0),take:async()=>{const event=events.shift();if(!event)throw Error('timeout');return event;},close:async()=>{accepts=undefined;events.length=0;}};
  emit();return {...result,...(accepts?{networkLease:source}:{})};
 };
 service.evalInPage=async(id:string,code:string)=>{const result=await evaluate(id,code);if(!code.startsWith('/* kydog-x-root-release */'))emit();return result;};
 return service;
}
