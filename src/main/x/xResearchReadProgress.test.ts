import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { post, readHtml, withDerivedReadNetwork } from '../../test-support/xResearchFixture';
import { KydogError } from '../../shared/errors';
import { BrowserScrollAcknowledgementError } from '../browser/actions';
import type { BrowserDispatchOptions } from '../browser/browserService';
import { createXResearchBrowser } from './xResearchBrowser';
import { parseXResearchInput } from './xResearchInput';
import { readX } from './xResearchRead';

const url='https://x.com/alice/status/123';
const reply=post('456','bob','Own reply after viewport progress');
const auth='<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input name="password" type="password"></div>';
type Mode='reply'|'empty'|'later'|'rootless'|'auth'|'route'|'route_other'|'no_movement'|'ack_timeout'|'unwritten'|'cancel_before'|'cancel_ack'|'cancel_wait';
/** Native service boundary double; parsing, source extraction, bindings and queue ownership stay real. */
async function runProgress(mode:Mode='reply',limits:Record<string,unknown>={},initial:'root'|'wrong'|'auth'|'ready'='root') {
  const abort=new AbortController(),events:string[]=[];
  let currentUrl=url,revision=0,writes=0,releases=0;
  const dom=new JSDOM(initial==='auth'?auth:readHtml(post('123',initial==='wrong'?'mallory':'alice')+(initial==='ready'?reply:'')),{url,runScripts:'outside-only'});
  Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
  Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  const addReply=()=>dom.window.document.querySelector('[aria-label="Timeline: Conversation"]')!.insertAdjacentHTML('beforeend',reply);
  const facts=()=>({currentUrl,documentEpoch:1,routeRevision:revision,navigationSequence:1,navigationEvent:'did-navigate' as const,navigationType:'cross_document' as const,navigationUrl:url});
  const service={researchTabStatus:()=>'available',enqueue:async(_id:string,work:()=>Promise<unknown>)=>work(),withAgentDriving:async(_id:string,_thread:string,work:()=>Promise<unknown>)=>work(),onTabDestroyed:()=>()=>{},onTabUnavailable:()=>()=>{},locationFacts:facts,prepareForDomRead:async()=>{},
    open:async()=>({tabId:'research-tab',evicted:[],nav:{navigationId:'1',startedAt:0,deadlineAt:1,outcome:{kind:'ok',finalUrl:currentUrl}}}),
    evalInPage:async(_id:string,code:string)=>{
      if(code.startsWith('/* kydog-x-root-release */')) {releases++;return dom.window.eval(code);}
      events.push('collect');const raw=dom.window.eval(code);
      if(mode==='cancel_before')abort.abort();
      return raw;
    },
    dispatchAndObserveNavigation:async(_id:string,action:{kind:string},snapshot:{generation:string},options?:BrowserDispatchOptions)=>{
      events.push(action.kind);
      if(mode==='unwritten')throw new KydogError('browser.stale_snapshot','source changed before write');
      const ack=options!.scrollAcknowledgement!;ack.onWritten();writes++;
      const failed=mode==='no_movement'||mode==='ack_timeout';
      ack.onReceipt?.({generation:snapshot.generation,targetKind:'document',targetNodeId:7,targetContainsHit:true,conversationRelation:'unknown',rootRelation:'unknown',before:0,after:failed?0:600,scrollHeight:2400,clientHeight:600,written:true,eventObserved:!failed,frameObserved:!failed,state:mode==='no_movement'?'no_movement':mode==='ack_timeout'?'expired':'frame_observed',invalidatedReason:null});
      if(failed)throw new BrowserScrollAcknowledgementError(mode==='no_movement'?'scroll_no_movement':'scroll_ack_timeout','native failure');
      if(mode==='reply'&&initial!=='ready'&&writes===1)addReply();
      if(mode==='later')setTimeout(addReply,250);
      if(mode==='rootless')dom.window.document.querySelector('article')!.outerHTML=reply;
      if(mode==='auth'){currentUrl='https://x.com/i/jf/onboarding/web';revision++;dom.reconfigure({url:currentUrl});dom.window.document.body.innerHTML=auth;}
      if(mode==='route'||mode==='route_other'){currentUrl=mode==='route'?'https://x.com/alice/status/123/history':'https://x.com/alice/status/123/photo/1';revision++;dom.reconfigure({url:currentUrl});dom.window.document.querySelector('[data-testid="tweetText"]')!.textContent='Changed route body';}
      if(mode==='cancel_ack'){abort.abort();await new Promise(resolve=>setTimeout(resolve,20));events.push('ack-cleanup');}
      if(mode==='cancel_wait')setTimeout(()=>abort.abort(),150);
      return {line:'executed',navigation:null};
    },
  };
  const input=parseXResearchInput({tabId:'research-tab',read:{objective:'source readiness',targets:[{url}],includeArticle:false,includeReplies:true,maxRepliesPerPost:4,maxScrollsPerPost:1,maxExpandActionsPerPost:0,...limits}});
  if(!input.read)throw new Error('read expected');
  const pending=readX(input,{browser:createXResearchBrowser(withDerivedReadNetwork(service,()=>dom.window.document,facts) as never,'thread'),threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map(),signal:abort.signal});
  await vi.runAllTimersAsync();
  return {row:(await pending).targets[0],events,writes,releases,rootReleased:dom.window.eval('window.__kydogXRootState === undefined')};
}

describe('network read progress with native scroll receipts',()=>{
 const timers=()=>vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});
 it('normalizes budgets, collects after each native write and stops before zero or disabled domains',async()=>{
  timers();try{
   const good=await runProgress();expect(good.events).toEqual(['collect','scroll','collect']);expect(good.writes).toBe(1);
   expect(good.row).toMatchObject({root:{postId:'123'},replies:{observations:[{postId:'456'}],scope:{kind:'network',extent:'unknown'}},budgetUsage:{scrolls:1},stopReason:'budget_reached'});
   for(const limits of [{maxScrollsPerPost:0},{includeReplies:false},{maxRepliesPerPost:0}]){
    const stopped=await runProgress('reply',limits);expect(stopped.writes).toBe(0);expect(stopped.row.root?.postId).toBe('123');expect(stopped.row.replies.observations).toEqual([]);
   }
  }finally{vi.useRealTimers();}
 });
 it('empty source pages stay unknown and consume only the authorized scroll budget',async()=>{
  timers();try{
   const positive=await runProgress();expect(positive.row.replies.observations[0].postId).toBe('456');
   for(const budget of [1,3]){const empty=await runProgress('empty',{maxScrollsPerPost:budget});expect(empty.writes).toBe(budget);expect(empty.row.replies.observations).toEqual([]);expect(empty.row).toMatchObject({stopReason:'budget_reached',replies:{scope:{extent:'unknown'}}});}
  }finally{vi.useRealTimers();}
 });
 it('rootless continuation retains proven history while route changes reject new data',async()=>{
  timers();try{
   const rootless=await runProgress('rootless',{maxScrollsPerPost:2});expect(rootless.writes).toBe(2);expect(rootless.row).toMatchObject({root:{postId:'123',text:'original'},identity:{state:'proven'},replies:{observations:[{postId:'456'}]},stopReason:'budget_reached'});
   for(const mode of ['auth','route','route_other'] as const){const stopped=await runProgress(mode,{maxScrollsPerPost:3});expect(stopped.writes).toBe(1);expect(stopped.row.root?.text).toBe('original');expect(stopped.row.replies.observations).toEqual([]);expect(stopped.row.stopReason).toBe(mode==='auth'?'access_barrier':'source_unavailable');}
  }finally{vi.useRealTimers();}
 });
 it('treats an executed no-movement as geometry and keeps failing closed on unwritten or unacknowledged scrolls',async()=>{
  timers();try{
   const good=await runProgress();expect(good.row.diagnostics?.scroll?.first?.state).toBe('frame_observed');
   // An executed no-op is a geometry fact, not an action failure: the target keeps
   // going and consumes its scroll budget instead of ending as action_failed.
   const unmoved=await runProgress('no_movement',{maxScrollsPerPost:3});
   expect(unmoved.writes).toBe(3);
   expect(unmoved.row).toMatchObject({status:'partial',stopReason:'budget_reached',reason:'reply_budget_reached',replies:{scope:{extent:'unknown'}}});
   for(const mode of ['ack_timeout','unwritten'] as const){const stopped=await runProgress(mode,{maxScrollsPerPost:3});expect(stopped.events).toEqual(['collect','scroll']);expect(stopped.writes).toBe(mode==='unwritten'?0:1);expect(stopped.row.reason).toBe(mode==='ack_timeout'?'scroll_ack_timeout':'action_failed:browser.stale_snapshot');expect(stopped.row.replies.scope.extent).toBe('unknown');}
  }finally{vi.useRealTimers();}
 });
 it('cancellation before input and during native ACK retains accepted network root and releases ownership',async()=>{
  timers();try{
   const good=await runProgress();expect(good.row.replies.observations[0].postId).toBe('456');
   for(const mode of ['cancel_before','cancel_ack'] as const){const stopped=await runProgress(mode,{maxScrollsPerPost:3});expect(stopped.row).toMatchObject({status:'cancelled',stopReason:'cancelled',...(mode==='cancel_ack'?{root:{postId:'123'}}:{root:null})});expect(stopped.writes).toBe(mode==='cancel_before'?0:1);expect(stopped.row.replies.observations).toEqual([]);if(mode==='cancel_ack')expect(stopped.events).toEqual(['collect','scroll','ack-cleanup']);expect(stopped.releases).toBe(1);expect(stopped.rootReleased).toBe(true);}
  }finally{vi.useRealTimers();}
 });
});
