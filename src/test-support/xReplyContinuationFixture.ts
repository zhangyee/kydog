import { JSDOM } from 'jsdom';
import { post, readHtml, withDerivedReadNetwork } from './xResearchFixture';
import { KydogError } from '../shared/errors';
import type { BrowserService } from '../main/browser/browserService';
import { measuredPointerExpression, pointerGuardExpression } from '../main/browser/measuredPointerSource';
import { createXResearchBrowser } from '../main/x/xResearchBrowser';
import { parseXResearchInput } from '../main/x/xResearchInput';
import { readX } from '../main/x/xResearchRead';

export const replyUrl='https://x.com/alice/status/123';
/** Only the native writer is doubled: source, original-reference guard and private port remain real. */
export function replyContinuationFixture(options:{body?:boolean;zero?:boolean}={}) {
  const abort=new AbortController();
  const body='<button role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button>';
  const dom=new JSDOM(readHtml(post().replace('</article>',(options.body?body:'')+'</article>')+'<div data-testid="cellInnerDiv"><button id="replies" role="button" type="button">Show replies</button></div>'),{url:replyUrl,runScripts:'outside-only'});
  const document=dom.window.document, root=document.querySelector('article')!, conversation=root.parentElement!, button=document.querySelector('#replies')!;
  Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
  Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  let hit:Element=button;Object.assign(document,{elementFromPoint:()=>hit});
  const facts={currentUrl:replyUrl,documentEpoch:1,routeRevision:0,navigationSequence:1,navigationEvent:'did-navigate' as const,navigationType:'cross_document' as const,navigationUrl:replyUrl};
  const records:{nodeId:number;generation:string;permission:string;purpose:string}[]=[], events:string[]=[];
  let writes=0,dispatches=0,collections=0;
  const hooks:{beforeDispatch?:()=>void;afterWrite?:()=>void;beforeCollect?:()=>void}={};
  const service:Partial<BrowserService>={researchTabStatus:()=>'available',enqueue:async(_id,work)=>work(),withAgentDriving:async(_id,_thread,work)=>work(),onTabDestroyed:()=>()=>{},onTabUnavailable:()=>()=>{},locationFacts:()=>({...facts}),prepareForDomRead:async()=>{},
    open:async()=>({tabId:'tab',evicted:[],nav:{navigationId:'nav',startedAt:0,deadlineAt:1,outcome:{kind:'ok',finalUrl:facts.currentUrl,httpStatusCode:200}}}),
    evalInPage:async(_id,code)=>{
      if(typeof code!=='string')throw Error('fixed source expected');
      if(!code.startsWith('/* kydog-x-root-release */')){collections++;events.push('collect');hooks.beforeCollect?.();}
      return dom.window.eval(code);
    },
    dispatchAndObserveNavigation:async(_id,action,snapshot,settings)=>{
      dispatches++;events.push('dispatch');hooks.beforeDispatch?.();
      const node=snapshot!.nodes.find(n=>'index' in action&&n.index===action.index)!;
      const permission=settings?.collectedPermission;
      if(!permission)throw Error('private permission missing');
      records.push({nodeId:node.nodeId,generation:snapshot!.generation,permission:permission.token,purpose:permission.purpose});
      hit=permission.purpose==='body_expand'?document.querySelector('[data-testid="tweet-text-show-more-link"]')!:button;
      const pointer={token:'native_'+dispatches,kind:'click' as const,expiresAt:Date.now()+3000};
      const measured=dom.window.eval(measuredPointerExpression({nodeId:node.nodeId,collectedPermission:permission},pointer,Date.now()+3000)) as {ok:boolean;pointerGuard?:{ok:boolean}};
      try {
        if(!measured.ok||!measured.pointerGuard?.ok||!(dom.window.eval(pointerGuardExpression('validate',pointer,Date.now()+3000)) as {ok:boolean}).ok)throw new KydogError('browser.target_unusable','original permission refused');
        writes++;events.push('write');
        if(permission.purpose==='body_expand')hit.remove();
        else if(!options.zero)conversation.insertAdjacentHTML('beforeend',post(String(700+writes),'reply'+writes,'Own reply '+writes));
        hooks.afterWrite?.();return {line:'clicked',navigation:null};
      } finally {dom.window.eval(pointerGuardExpression('dispose',pointer,Date.now()+3000));}
    },
  };
  const port=createXResearchBrowser(withDerivedReadNetwork(service,()=>document,()=>facts) as BrowserService,'thread');
  const request={stage:'post' as const,expectedUrl:replyUrl,postId:'123'};
  const context={browser:port,threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map(),signal:abort.signal};
  const run=async(limits:Record<string,unknown>={})=>{
    const input=parseXResearchInput({tabId:'tab',read:{objective:'same original button',targets:[{url:replyUrl}],includeArticle:false,includeReplies:true,maxRepliesPerPost:20,maxScrollsPerPost:0,maxExpandActionsPerPost:3,...limits}});
    if(!input.read)throw Error('read expected');return readX(input,context);
  };
  return {port,request,run,dom,document,root,conversation,button,abort,facts,hooks,records,events,count:()=>({writes,dispatches,collections}),close:()=>dom.window.close()};
}
