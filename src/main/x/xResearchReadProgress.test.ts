import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { post, readHtml } from '../../test-support/xResearchFixture';
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
      ack.onReceipt?.({generation:snapshot.generation,targetKind:'document',targetNodeId:7,targetContainsHit:true,conversationRelation:'unknown',rootRelation:'unknown',before:0,after:failed?0:600,scrollHeight:2400,clientHeight:600,written:true,eventObserved:!failed,frameObserved:!failed,state:mode==='no_movement'?'no_movement':mode==='ack_timeout'?'expired':'frame_observed'});
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
  const pending=readX(input,{browser:createXResearchBrowser(service as never,'thread'),threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map(),signal:abort.signal});
  await vi.runAllTimersAsync();
  return {row:(await pending).targets[0],events,writes,releases,rootReleased:dom.window.eval('window.__kydogXRootState === undefined')};
}

describe('one source-bound viewport advance before readiness',()=>{
  it('uses normalized positive budgets before waiting and zero, disabled, capped or unproved inputs never gain an early write',async()=>{
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try {
      for(const [budget,writes] of [[1,1],[undefined,500]]) {
        const good=await runProgress('reply',{maxScrollsPerPost:budget});
        expect(good.row).toMatchObject({root:{postId:'123'},replies:{observations:[{postId:'456',text:'Own reply after viewport progress'}],scope:{completeness:'unknown'}},budgetUsage:{scrolls:writes},stopReason:'budget_reached'});
        expect(good.events.slice(0,3)).toEqual(['collect','scroll','collect']);
        expect(good.events.filter(e=>e==='scroll')).toHaveLength(writes!);expect(good.writes).toBe(writes);
      }
      const good=await runProgress();
      expect(good.row.diagnostics).toMatchObject({initialFrame:{rootIdentityProven:true,replyCount:0,repliesExpandControlCount:0,explicitEndObserved:false},terminalFrame:{rootIdentityProven:true,replyCount:1},readiness:{collectCount:1,initial:{replyCount:1},timedOut:false}});
      expect(good.events).toEqual(['collect','scroll','collect']);expect(good.writes).toBe(1);
      for(const [limits,initial] of [[{maxScrollsPerPost:0},'root'],[{includeReplies:false},'root'],[{maxRepliesPerPost:0},'root'],[{},'wrong'],[{},'auth']] as const) {
        const stopped=await runProgress('reply',limits,initial);
        expect(stopped.writes).toBe(0);expect(stopped.events.filter(e=>e==='scroll')).toEqual([]);expect(stopped.row.replies.observations).toEqual([]);
        if('maxScrollsPerPost' in limits)expect(stopped.row).toMatchObject({reason:'reply_readiness_timeout',stopReason:'wait_timeout'});
      }
    }finally{vi.useRealTimers();}
  },30000);
  it('collects and saves after progress, then waits once even with exhausted scroll budget; remaining budget never repeats an empty advance',async()=>{
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try {
      const later=await runProgress('later');expect(later.row.replies.observations.map(p=>p.postId)).toEqual(['456']);
      expect(later.row.diagnostics?.readiness).toMatchObject({initial:{replyCount:0},terminal:{replyCount:1},timedOut:false});
      for(const budget of [1,3]) {
        const empty=await runProgress('empty',{maxScrollsPerPost:budget});
        expect(empty.events.slice(0,3)).toEqual(['collect','scroll','collect']);expect(empty.writes).toBe(1);expect(empty.row.replies.observations).toEqual([]);
        expect(empty.row).toMatchObject({reason:'reply_readiness_timeout',stopReason:'wait_timeout',budgetUsage:{scrolls:1},replies:{scope:{completeness:'unknown'}}});
        expect(empty.row.diagnostics?.readiness).toMatchObject({collectCount:80,initial:{replyCount:0},terminal:{replyCount:0},timedOut:true});
      }
    }finally{vi.useRealTimers();}
  });
  it('stops on fresh identity or barrier loss and retains independent rootless bodies without historical input authority',async()=>{
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try {
      const good=await runProgress();expect(good.row.replies.observations[0].postId).toBe('456');expect(good.row.diagnostics?.readiness?.initial.replyCount).toBe(1);
      for(const mode of ['rootless','auth','route','route_other'] as const) {
        const stopped=await runProgress(mode,{maxScrollsPerPost:3});
        expect(stopped.events,mode).toEqual(['collect','scroll','collect']);expect(stopped.writes).toBe(1);
        expect(stopped.row).toMatchObject({root:{postId:'123',text:'original'},stopReason:mode==='auth'?'access_barrier':'identity_unproven',replies:{observations:[],scope:{completeness:'unknown'}}});
        expect(stopped.row.diagnostics?.readiness).toBeUndefined();
        expect(stopped.row.diagnostics?.firstAdmittedFrame?.snapshotId).toBe(stopped.row.diagnostics?.initialFrame?.snapshotId);
        expect(stopped.row.sourceUrl).toBe(url);
        if(mode==='rootless')expect(stopped.row.unscopedPosts?.observations).toMatchObject([{postId:'456',text:'Own reply after viewport progress',relationToTarget:'unproven'}]);
      }
    }finally{vi.useRealTimers();}
  });
  it('preserves written receipts, observes an authenticated stall and never recovers timeout or unwritten input',async()=>{
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try {
      const good=await runProgress();expect(good.events).toEqual(['collect','scroll','collect']);expect(good.row.diagnostics?.readiness).toBeDefined();
      for(const mode of ['no_movement','ack_timeout','unwritten'] as const) {
        const stopped=await runProgress(mode,{maxScrollsPerPost:3});
        expect(stopped.events).toEqual(mode==='no_movement'?['collect','scroll',...Array(80).fill('collect')]:['collect','scroll']);expect(stopped.writes).toBe(mode==='unwritten'?0:1);expect(stopped.row.diagnostics?.readiness).toBeUndefined();
        expect(stopped.row.reason).toBe(mode==='no_movement'?'scroll_no_movement':mode==='ack_timeout'?'scroll_ack_timeout':'action_failed:browser.stale_snapshot');
        expect(stopped.row.budgetUsage.scrolls).toBe(mode==='unwritten'?0:1);expect(stopped.row.replies.scope.completeness).toBe('unknown');
      }
    }finally{vi.useRealTimers();}
  });
  it('cancellation before input, during ACK and during wait preserves issued-operation cleanup and releases the source root',async()=>{
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try {
      const good=await runProgress();expect(good.events).toEqual(['collect','scroll','collect']);expect(good.row.replies.observations[0].postId).toBe('456');
      for(const mode of ['cancel_before','cancel_ack','cancel_wait'] as const) {
        const stopped=await runProgress(mode,{maxScrollsPerPost:3});expect(stopped.row).toMatchObject({status:'cancelled',stopReason:'cancelled'});
        expect(stopped.writes).toBe(mode==='cancel_before'?0:1);expect(stopped.row.replies.observations).toEqual([]);
        if(mode==='cancel_ack')expect(stopped.events).toEqual(['collect','scroll','ack-cleanup']);
        expect(stopped.releases).toBe(1);expect(stopped.rootReleased).toBe(true);
      }
    }finally{vi.useRealTimers();}
  });
  it('already-ready source uses the same one normal action and original readiness frame',async()=>{
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try {
      const ready=await runProgress('empty',{},'ready');expect(ready.events).toEqual(['collect','scroll','collect']);
      expect(ready.row).toMatchObject({replies:{observations:[{postId:'456'}]},budgetUsage:{scrolls:1}});
      expect(ready.row.diagnostics?.readiness).toMatchObject({collectCount:1,initial:{replyCount:1},terminal:{replyCount:1},timedOut:false});
    }finally{vi.useRealTimers();}
  });
});
