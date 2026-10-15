import {JSDOM} from 'jsdom';
import {expect,it,vi} from 'vitest';
import {post,readHtml,withDerivedReadNetwork} from '../../test-support/xResearchFixture';
import {KydogError} from '../../shared/errors';
import {BrowserScrollAcknowledgementError,type BrowserScrollReceipt} from '../browser/actions';
import type {BrowserDispatchOptions} from '../browser/browserService';
import {createXResearchBrowser} from './xResearchBrowser';
import {readX} from './xResearchRead';
import {serializeXResearchResult} from './xResearchOutput';
import type {XReadRequest} from './xResearchTypes';

function stallFixture(initialReply=false) {
 const url='https://x.com/alice/status/123';
 const dom=new JSDOM(readHtml(post('123')+(initialReply?post('401','first'):'')),{url,runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 const abort=new AbortController(),events:string[]=[];
 const facts={currentUrl:url,documentEpoch:3,routeRevision:7,navigationSequence:9,navigationEvent:'did-navigate' as const,navigationType:'cross_document' as const,navigationUrl:url};
 let scrolls=0,clicks=0,collects=0,gone:((id:string)=>void)|undefined;
 const hooks:{collect?:()=>void|Promise<void>;write?:()=>void|Promise<void>;receipt?:(r:BrowserScrollReceipt)=>BrowserScrollReceipt;error?:()=>Error;written?:boolean;omitReceipt?:boolean}={};
 const container=()=>dom.window.document.querySelector('[aria-label="Timeline: Conversation"]')!;
 const add=(id='402')=>container().insertAdjacentHTML('beforeend',post(id,'next','real source '+id));
 const service={researchTabStatus:()=>'available',enqueue:async(_id:string,work:()=>Promise<unknown>)=>{try{return await work();}finally{events.push('queue-release');}},withAgentDriving:async(_id:string,_thread:string,work:()=>Promise<unknown>)=>work(),onTabDestroyed:(cb:(id:string)=>void)=>{gone=cb;return()=>{};},onTabUnavailable:()=>()=>{},locationFacts:()=>facts,prepareForDomRead:async()=>{},
  open:async()=>({tabId:'tab',evicted:[],nav:{navigationId:'one',startedAt:0,deadlineAt:1,outcome:{kind:'ok',finalUrl:facts.currentUrl}}}),
  evalInPage:async(_id:string,code:string)=>{if(code.startsWith('/* kydog-x-root-release */')){events.push('source-release');return dom.window.eval(code);}collects++;events.push('collect');await hooks.collect?.();return dom.window.eval(code);},
  dispatchAndObserveNavigation:async(_id:string,action:{kind:string},snapshot:{generation:string},options?:BrowserDispatchOptions)=>{
   if(action.kind==='click'){clicks++;events.push('click');if(options?.collectedPermission?.purpose==='body_expand'){container().querySelector('a[href="/first/status/401"]')!.closest('article')!.remove();}else{expect(options?.collectedPermission?.purpose).toBe('replies_expand');add('777');}container().querySelector('button')!.remove();return{line:'clicked',navigation:null};}
   scrolls++;events.push('scroll');const ack=options!.scrollAcknowledgement!;
   if(hooks.written!==false)ack.onWritten();
   const receipt:BrowserScrollReceipt={generation:snapshot.generation,targetKind:'document',targetNodeId:7,targetContainsHit:true,conversationRelation:'unknown',rootRelation:'unknown',before:0,after:0,scrollHeight:600,clientHeight:600,written:true,eventObserved:false,frameObserved:false,state:'no_movement'};
   if(!hooks.omitReceipt)ack.onReceipt?.(hooks.receipt?hooks.receipt(receipt):receipt);
   await hooks.write?.();events.push('action-cleanup');
   throw hooks.error?.()??new BrowserScrollAcknowledgementError('scroll_no_movement','native no movement');
  },
 };
 const context={browser:createXResearchBrowser(withDerivedReadNetwork(service,()=>dom.window.document,()=>facts) as never,'thread'),threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map(),signal:abort.signal};
 const run=async(limits:Partial<XReadRequest>={})=>{
  const pending=readX({tabId:'tab',read:{objective:'recover',targets:[{url}],includeArticle:false,includeReplies:true,maxRepliesPerPost:20,maxScrollsPerPost:3,maxExpandActionsPerPost:2,...limits}},context);
  await vi.runAllTimersAsync();const result=await pending;serializeXResearchResult(result);return{result,row:result.targets[0]};
 };
 return{dom,abort,events,facts,hooks,container,add,run,count:()=>({scrolls,clicks,collects}),destroy:()=>gone?.('tab'),close:()=>dom.window.close()};
}
// The DOM recovery loop is no longer a read producer. These live checks keep
// native receipt/ownership safety while proving that DOM changes cannot revive it.
it('a settled native stall retains accepted network data and does not poll DOM identities for permission',async()=>{
 vi.useFakeTimers();const f=stallFixture(true);try{
  f.hooks.write=()=>f.add('402');const {row}=await f.run();
  expect(row.root?.postId).toBe('123');expect(row.replies.observations.map(p=>p.postId)).toEqual(['401']);expect(f.count()).toEqual({collects:1,scrolls:1,clicks:0});
  expect(row).toMatchObject({reason:'scroll_no_movement',stopReason:'action_failed',budgetUsage:{scrolls:1},replies:{scope:{extent:'unknown'}}});expect(row.diagnostics?.scroll?.first).toMatchObject({written:true,state:'no_movement'});expect(row.diagnostics?.scrollRecovery).toBeUndefined();
 }finally{f.close();vi.useRealTimers();}
});
it('authentic native no-movement and timeout retain receipt identity while lookalike prose grants no recovery',async()=>{
 vi.useFakeTimers();try{
  for(const kind of ['real','timeout','prose','unwritten'] as const){const f=stallFixture(true);try{
   if(kind==='timeout')f.hooks.error=()=>new BrowserScrollAcknowledgementError('scroll_ack_timeout','scroll_no_movement');
   if(kind==='prose')f.hooks.error=()=>new KydogError('browser.wait_timeout','scroll_no_movement');
   if(kind==='unwritten')f.hooks.written=false;
   const {result,row}=await f.run();expect(row.root?.text).toBe('original');expect(row.replies.observations[0].postId).toBe('401');expect(f.count()).toEqual({collects:1,scrolls:1,clicks:0});expect(row.budgetUsage.scrolls).toBe(kind==='unwritten'?0:1);
   expect(row.reason).toBe(kind==='timeout'?'scroll_ack_timeout':kind==='prose'?'action_failed:browser.wait_timeout':'scroll_no_movement');expect(serializeXResearchResult(result).result.targets[0].diagnostics?.scroll).toEqual(row.diagnostics?.scroll);
  }finally{f.close();}}
 }finally{vi.useRealTimers();}
});
it('new DOM text, semantic end prose and newly visible reply controls cannot authorize another native action after stall',async()=>{
 vi.useFakeTimers();try{
  const positive=stallFixture(true);try{const {row}=await positive.run();expect(row.replies.observations[0].postId).toBe('401');}finally{positive.close();}
  for(const html of [post('402','next','End of conversation'),'<div role="status">End of conversation</div>','<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>']){
   const f=stallFixture(true);try{f.hooks.write=()=>f.container().insertAdjacentHTML('beforeend',html);const {row}=await f.run();expect(f.count().clicks).toBe(0);expect(f.count().scrolls).toBe(1);expect(row.replies.scope.extent).toBe('unknown');expect(row.replies.observations.map(p=>p.postId)).toEqual(['401']);}finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
it('native cancellation settles issued work and releases source ownership without losing accepted root',async()=>{
 vi.useFakeTimers();const f=stallFixture(true);try{f.hooks.write=async()=>{f.abort.abort();await new Promise(resolve=>setTimeout(resolve,20));};const {row}=await f.run();expect(row).toMatchObject({status:'cancelled',root:{postId:'123'}});expect(f.events).toEqual(['collect','scroll','action-cleanup','source-release','queue-release']);expect(f.dom.window.eval('window.__kydogXRootState')).toBeUndefined();}finally{f.close();vi.useRealTimers();}
});

it('rechecks the monotonic deadline after acceptance while preserving cancellation, barrier and identity priorities',async()=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});let now=100;const clock=vi.spyOn(performance,'now').mockImplementation(()=>now);
 try{
  const {recoverXScroll}=await import('./xScrollRecovery');
  const location={current:{origin:'https://x.com',path:'/alice/status/123',q:null,f:null,fragment:null,redacted:false},documentEpoch:3,routeRevision:7,navigationSequence:9};
  const initial={snapshot:{snapshotId:'before',generation:'same',url:'https://x.com/alice/status/123'},location} as import('./xPageSource').XPageObservation;
  const frame={...initial,snapshot:{...initial.snapshot,snapshotId:'after'}};
  for(const elapsed of [7999,8000])for(const decision of ['progress','continue','barrier','identity_unproven','cancelled','generation'] as const){
   now=100;const abort=new AbortController();let saved=false;
   const accepted=()=>{saved=true;now+=elapsed;if(decision==='cancelled')abort.abort();return{outcome:decision==='barrier'||decision==='identity_unproven'||decision==='continue'?decision:'progress' as const,newIdentityCount:decision==='continue'?0:1};};
   const page={location:()=>({currentUrl:initial.snapshot.url,...location}),collect:vi.fn(async()=>{if(decision==='generation')now+=elapsed;return decision==='generation'?{...frame,snapshot:{...frame.snapshot,generation:'changed'}}:frame;})} as unknown as import('./xResearchBrowser').XQueuedPage;
   // The continue case needs a monotonic advance when its first scheduling pause wakes.
   if(decision==='continue')setTimeout(()=>{now=8200;},50);
   const pending=recoverXScroll(page,{stage:'post',expectedUrl:initial.snapshot.url,postId:'123'},initial,1,{},accepted,abort.signal);
   if(decision==='cancelled'){
    await expect(pending).rejects.toMatchObject({code:'browser.cancelled'});expect(saved).toBe(true);
   }else{
    await vi.runAllTimersAsync();const result=await pending;
    const expected=decision==='generation'?'identity_unproven':decision==='barrier'||decision==='identity_unproven'?decision:elapsed>=8000||decision==='continue'?'expired':'progress';
    expect(result.outcome,JSON.stringify({elapsed,decision})).toBe(expected);
    if(expected==='progress')expect(result.frame).toBe(frame);else expect(result.frame).toBeNull();
    expect(saved).toBe(decision!=='generation');
   }
   expect(page.collect).toHaveBeenCalledTimes(1);
  }
  // Main-thread starvation can also happen before the initial read is issued.
  clock.mockReturnValueOnce(100).mockReturnValue(8100);
  const collect=vi.fn(async()=>frame);
  const stopped=await recoverXScroll({collect} as unknown as import('./xResearchBrowser').XQueuedPage,
   {stage:'post',expectedUrl:initial.snapshot.url,postId:'123'},initial,1,{},()=>({outcome:'progress',newIdentityCount:1}));
  expect(stopped).toEqual({frame:null,outcome:'expired'});expect(collect).toHaveBeenCalledTimes(0);
 }finally{clock.mockRestore();vi.useRealTimers();}
});

it('counts missing scroll receipts and keeps scroll ordinals independent of preceding reply clicks',async()=>{
 vi.useFakeTimers();try{
  for(const omitReceipt of [false,true]){
   const f=stallFixture(true);try{
    f.container().insertAdjacentHTML('beforeend','<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>');
    f.hooks.omitReceipt=omitReceipt;
    const {row}=await f.run();
    expect(f.count().clicks).toBe(1);expect(f.count().scrolls).toBe(1);
    expect(row.replies.observations.map(p=>p.postId)).toEqual(['401','777']);
    expect(row.diagnostics?.scroll).toMatchObject({totalAttempts:1,omittedAttempts:omitReceipt?1:0});
    if(omitReceipt)expect(row.diagnostics?.scroll?.first).toBeUndefined();
    else expect(row.diagnostics?.scroll?.first).toMatchObject({actionIndex:1,state:'no_movement'});
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
