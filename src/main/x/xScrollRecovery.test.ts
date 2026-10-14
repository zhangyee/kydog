import {JSDOM} from 'jsdom';
import {expect,it,vi} from 'vitest';
import {post,readHtml,searchHtml,query} from '../../test-support/xResearchFixture';
import {KydogError} from '../../shared/errors';
import {BrowserScrollAcknowledgementError,type BrowserScrollReceipt} from '../browser/actions';
import type {BrowserDispatchOptions} from '../browser/browserService';
import {createXResearchBrowser} from './xResearchBrowser';
import {readX} from './xResearchRead';
import {serializeXResearchResult,xResearchToolResult} from './xResearchOutput';
import {XResearchEvidence} from './xResearchEvidence';
import {searchX,xSearchUrl} from './xResearchSearch';
import type {XReadRequest} from './xResearchTypes';

function stallFixture(search=false,initialReply=false) {
 const url=search?xSearchUrl(query):'https://x.com/alice/status/123';
 const dom=new JSDOM(search?searchHtml(post('401','first')):readHtml(post('123')+(initialReply?post('401','first'):'')),{url,runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 const abort=new AbortController(),events:string[]=[];
 const facts={currentUrl:url,documentEpoch:3,routeRevision:7,navigationSequence:9,navigationEvent:'did-navigate' as const,navigationType:'cross_document' as const,navigationUrl:url};
 let scrolls=0,clicks=0,collects=0,gone:((id:string)=>void)|undefined;
 const hooks:{collect?:()=>void|Promise<void>;write?:()=>void|Promise<void>;receipt?:(r:BrowserScrollReceipt)=>BrowserScrollReceipt;error?:()=>Error;written?:boolean}={};
 const container=()=>dom.window.document.querySelector(search?'[data-testid="primaryColumn"]':'[aria-label="Timeline: Conversation"]')!;
 const add=(id='402')=>container().insertAdjacentHTML('beforeend',post(id,'next','real source '+id));
 const service={researchTabStatus:()=>'available',enqueue:async(_id:string,work:()=>Promise<unknown>)=>{try{return await work();}finally{events.push('queue-release');}},withAgentDriving:async(_id:string,_thread:string,work:()=>Promise<unknown>)=>work(),onTabDestroyed:(cb:(id:string)=>void)=>{gone=cb;return()=>{};},onTabUnavailable:()=>()=>{},locationFacts:()=>facts,prepareForDomRead:async()=>{},
  open:async()=>({tabId:'tab',evicted:[],nav:{navigationId:'one',startedAt:0,deadlineAt:1,outcome:{kind:'ok',finalUrl:facts.currentUrl}}}),
  evalInPage:async(_id:string,code:string)=>{if(code.startsWith('/* kydog-x-root-release */')){events.push('source-release');return dom.window.eval(code);}collects++;events.push('collect');await hooks.collect?.();return dom.window.eval(code);},
  dispatchAndObserveNavigation:async(_id:string,action:{kind:string},snapshot:{generation:string},options?:BrowserDispatchOptions)=>{
   if(action.kind==='click'){clicks++;events.push('click');if(options?.collectedPermission?.purpose==='body_expand'){container().querySelector('a[href="/first/status/401"]')!.closest('article')!.remove();}else{expect(options?.collectedPermission?.purpose).toBe('replies_expand');add('777');}container().querySelector('button')!.remove();return{line:'clicked',navigation:null};}
   scrolls++;events.push('scroll');const ack=options!.scrollAcknowledgement!;
   if(hooks.written!==false)ack.onWritten();
   const receipt:BrowserScrollReceipt={generation:snapshot.generation,targetKind:'document',targetNodeId:7,targetContainsHit:true,conversationRelation:'unknown',rootRelation:'unknown',before:0,after:0,scrollHeight:600,clientHeight:600,written:true,eventObserved:false,frameObserved:false,state:'no_movement'};
   ack.onReceipt?.(hooks.receipt?hooks.receipt(receipt):receipt);
   await hooks.write?.();events.push('action-cleanup');
   throw hooks.error?.()??new BrowserScrollAcknowledgementError('scroll_no_movement','native no movement');
  },
 };
 const context={browser:createXResearchBrowser(service as never,'thread'),threadId:'thread',runId:'run',callId:'call',batchId:'batch',sources:new Map(),signal:abort.signal};
 const run=async(limits:Partial<XReadRequest>={})=>{
  const pending=search?searchX({search:{objective:'recover',queries:[query],maxPostsPerQuery:limits.maxRepliesPerPost??20,maxScrollsPerQuery:limits.maxScrollsPerPost??3}},context):readX({tabId:'tab',read:{objective:'recover',targets:[{url}],includeArticle:false,includeReplies:true,maxRepliesPerPost:20,maxScrollsPerPost:3,maxExpandActionsPerPost:2,...limits}},context);
  await vi.runAllTimersAsync();const result=await pending;serializeXResearchResult(result);return{result,row:result.operation==='read'?result.targets[0]:result.queries[0]};
 };
 return{dom,abort,events,facts,hooks,container,add,run,count:()=>({scrolls,clicks,collects}),destroy:()=>gone?.('tab'),close:()=>dom.window.close()};
}
it.each([false,true])('collects after settled authenticated stall and resumes on actual new identities (search=%s)',async(search)=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});const f=stallFixture(search);try{
  f.hooks.write=()=>{if(f.count().scrolls===1)f.add();};
  const {row}=await f.run();
  expect(f.events.slice(0,5)).toEqual(['collect','scroll','action-cleanup','collect','scroll']);
  expect(f.count().scrolls).toBe(2);
  expect('posts'in row?row.posts.map(p=>p.postId):row.replies.observations.map(p=>p.postId)).toContain('402');
  expect(row.diagnostics).toMatchObject({scrollRecovery:{totalRecoveries:2,omittedRecoveries:0,first:{outcome:'progress',newIdentityCount:1,collectCount:1},last:{outcome:'expired',newIdentityCount:0}}});
 }finally{f.close();vi.useRealTimers();}
});
it.each([false,true])('waits for delayed identity rather than old replies, text edits or fresh observation UUIDs (search=%s)',async(search)=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  const good=stallFixture(search,true);try{
   good.hooks.collect=()=>{if(good.count().collects===4)good.add();};
   const {row}=await good.run({maxScrollsPerPost:2});expect(good.count().scrolls).toBe(2);
   expect(row.diagnostics?.scrollRecovery?.first).toMatchObject({collectCount:3,newIdentityCount:1,outcome:'progress'});
   expect('posts'in row?row.posts.map(p=>p.postId):row.replies.observations.map(p=>p.postId)).toContain('402');
  }finally{good.close();}
  const old=stallFixture(search,true);try{
   old.hooks.collect=()=>{if(old.count().collects>1)old.container().querySelector('[data-testid="tweetText"]')!.textContent='body changes '+old.count().collects;};
   const {row}=await old.run();expect(old.count()).toMatchObject({scrolls:1,collects:81});
   expect(row.diagnostics?.scrollRecovery?.first).toMatchObject({collectCount:80,newIdentityCount:0,outcome:'expired'});
   expect(row).toMatchObject({status:'partial',stopReason:'action_failed',budgetUsage:{scrolls:1}});
   expect('barrier'in row&&'posts'in row?row.barrier?.reason:'reason'in row?row.reason:null).toBe('scroll_no_movement');
  }finally{old.close();}
 }finally{vi.useRealTimers();}
});
it.each([false,true])('exact identity sets permit same-size A→B replacement once, not A/B reappearance (search=%s)',async(search)=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});const f=stallFixture(search,true);try{
  f.hooks.collect=()=>{
   if(f.count().collects===1)return;
   for(const article of f.container().querySelectorAll('article'))if(search||!article.querySelector('a[href="/alice/status/123"]'))article.remove();
   const id=f.count().collects===2?'402':f.count().collects%2===0?'402':'401';
   f.container().insertAdjacentHTML('beforeend',post(id,id==='401'?'first':'next','changed '+f.count().collects));
  };
  const {row}=await f.run();expect(f.count().scrolls).toBe(2);
  expect(row.diagnostics?.scrollRecovery).toMatchObject({totalRecoveries:2,first:{newIdentityCount:1,outcome:'progress'},last:{newIdentityCount:0,outcome:'expired'}});
  expect('posts'in row?row.posts.map(p=>p.postId):row.replies.observations.map(p=>p.postId)).toEqual(['401','402']);
 }finally{f.close();vi.useRealTimers();}
});
it.each([false,true])('repeated actual progress stays finite and counts every written scroll at the explicit cap (search=%s)',async(search)=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  for(const cap of [1,3,5]){
   const f=stallFixture(search);try{
    f.hooks.write=()=>f.add(String(500+f.count().scrolls));
    const {row}=await f.run({maxScrollsPerPost:cap});expect(f.count().scrolls).toBe(cap);
    expect(row).toMatchObject({budgetUsage:{scrolls:cap},stopReason:'budget_reached'});
    expect(row.diagnostics?.scrollRecovery).toMatchObject({totalRecoveries:cap,omittedRecoveries:Math.max(0,cap-2),last:{actionIndex:cap,outcome:'progress'}});
    expect('posts'in row?row.posts.map(p=>p.postId):row.replies.observations.map(p=>p.postId)).toContain(String(500+cap));
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
it('a current source reply control gets fresh private permission after the last allowed scroll, subject to its independent cap',async()=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  for(const cap of [1,0]){
   const f=stallFixture();try{
    f.hooks.collect=()=>{if(f.count().collects===3)f.container().insertAdjacentHTML('beforeend','<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>');};
    const {row}=await f.run({maxScrollsPerPost:1,maxExpandActionsPerPost:cap});expect(f.count().clicks).toBe(cap);expect(f.count().scrolls).toBe(1);
    expect(row).toMatchObject({budgetUsage:{scrolls:1,expandActions:cap},stopReason:'budget_reached'});
    if('replies'in row){expect(row.replies.observations.map(p=>p.postId)).toEqual(cap?['777']:[]);if(cap)expect(row.diagnostics?.replyExpansions?.first?.admission.state).toBe('consumed');}
    expect(row.diagnostics?.scrollRecovery?.first).toMatchObject({collectCount:2,newIdentityCount:0,outcome:'progress'});
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
it.each([false,true])('requires the actual error and local complete receipt, never a reason string or old/malformed facts (search=%s)',async(search)=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  const good=stallFixture(search);try{good.hooks.write=()=>good.add();await good.run({maxScrollsPerPost:1});expect(good.count().collects).toBe(2);}finally{good.close();}
  for(const mode of ['ack_timeout','fake','unwritten','missing','old_generation','written_false','event','frame','moved','pending','malformed','old_receipt'] as const){
   const f=stallFixture(search);try{
    f.hooks.write=()=>f.add();
    if(mode==='ack_timeout')f.hooks.error=()=>new BrowserScrollAcknowledgementError('scroll_ack_timeout','scroll_no_movement');
    if(mode==='fake')f.hooks.error=()=>Object.assign(new KydogError('browser.wait_timeout','scroll_no_movement'),{reason:'scroll_no_movement'});
    if(mode==='unwritten')f.hooks.written=false;
    f.hooks.receipt=r=>mode==='missing'?undefined as never:mode==='old_generation'?{...r,generation:'old'}:mode==='written_false'?{...r,written:false}:mode==='event'?{...r,eventObserved:true}:mode==='frame'?{...r,frameObserved:true}:mode==='moved'?{...r,after:1}:mode==='pending'?{...r,state:'pending'}:mode==='malformed'?{...r,before:NaN,after:NaN}:mode==='old_receipt'&&f.count().scrolls===2?undefined as never:r;
    if(mode==='old_receipt')f.hooks.write=()=>{if(f.count().scrolls===1)f.add();};
    const {row}=await f.run();expect(f.count().collects,mode).toBe(mode==='old_receipt'?2:1);expect(f.count().scrolls).toBe(mode==='old_receipt'?2:1);
    expect(row.diagnostics?.scrollRecovery?.totalRecoveries??0).toBe(mode==='old_receipt'?1:0);
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
it.each([false,true])('source invalidation, parser failure and cancellation cannot borrow old input authority (search=%s)',async(search)=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  const good=stallFixture(search);try{good.hooks.write=()=>good.add();await good.run({maxScrollsPerPost:1});expect(good.count().collects).toBe(2);}finally{good.close();}
  for(const mode of ['epoch','revision','sequence','generation','root','route','product','auth','parser','cancel_cleanup','cancel_wait','cancel_collect','destroy'] as const){
   if(!search&&mode==='product')continue;
   const f=stallFixture(search);try{
    f.hooks.write=async()=>{
     if(mode==='cancel_cleanup'){f.abort.abort();await new Promise(resolve=>setTimeout(resolve,20));}
     else if(mode==='cancel_wait')setTimeout(()=>f.abort.abort(),150);
     else if(mode==='destroy')f.destroy();
     else if(mode==='auth'){f.facts.currentUrl='https://x.com/i/jf/onboarding/web';f.facts.routeRevision++;f.dom.reconfigure({url:f.facts.currentUrl});f.dom.window.document.body.innerHTML='<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input name="password" type="password"></div>';}
    };
    f.hooks.collect=async()=>{
     if(f.count().collects!==2)return;
     if(mode==='epoch')f.facts.documentEpoch++;
     if(mode==='revision')f.facts.routeRevision++;
     if(mode==='sequence')f.facts.navigationSequence++;
     if(mode==='generation')f.dom.window.eval('delete window.__kydogWorld');
     if(mode==='root'){if(search)f.container().remove();else f.container().querySelector('article')!.remove();}
     if(mode==='route'){f.facts.currentUrl=search?'https://x.com/search?q=other&f=live':'https://x.com/alice/status/123/history';f.dom.reconfigure({url:f.facts.currentUrl});}
     if(mode==='product')f.container().querySelector('[role="tab"]')!.textContent='Top';
     if(mode==='parser')throw new KydogError('x.invalid_page','invalid fixed extractor result');
     if(mode==='cancel_collect'){f.abort.abort();await new Promise(resolve=>setTimeout(resolve,20));f.events.push('collect-settled');}
     if(!['root','auth','cancel_wait'].includes(mode))f.add();
    };
    const {row}=await f.run();
    expect(f.count().scrolls,mode).toBe(1);
    if(mode.startsWith('cancel'))expect(row.status,mode).toBe('cancelled');
    if(mode==='auth')expect(row.status).toBe('auth_required');
    if(mode==='cancel_cleanup')expect(f.events.indexOf('action-cleanup')).toBeLessThan(f.events.indexOf('queue-release'));
    if(mode==='cancel_collect')expect(f.events.indexOf('collect-settled')).toBeLessThan(f.events.indexOf('queue-release'));
    if(mode==='epoch'||mode==='revision'||mode==='sequence'||mode==='route')expect(row.collectionTransitions).toEqual([]);
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
it.each([false,true])('late valid observation is retained after the deadline but cannot grant another input (search=%s)',async(search)=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  for(const delay of [0,8001]){
   const f=stallFixture(search);try{
    f.hooks.collect=async()=>{if(f.count().collects===2){await new Promise(resolve=>setTimeout(resolve,delay));f.add();f.events.push('collect-settled');}};
    const {row}=await f.run({maxScrollsPerPost:2});expect(f.count().scrolls).toBe(delay?1:2);
    expect('posts'in row?row.posts.map(p=>p.postId):row.replies.observations.map(p=>p.postId)).toContain('402');
    expect(row.diagnostics?.scrollRecovery?.first).toMatchObject({newIdentityCount:1,outcome:delay?'expired':'progress'});
    expect(f.events.indexOf('collect-settled')).toBeLessThan(f.events.indexOf('queue-release'));
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
it.each([false,true])('counts every observed new identity even beyond the retained cap and stops further input (search=%s)',async(search)=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});const f=stallFixture(search);try{
  f.hooks.write=()=>{for(let i=0;i<25;i++)f.add(String(600+i));};
  const {row}=await f.run({maxRepliesPerPost:2,maxScrollsPerPost:4});
  expect(row.diagnostics?.scrollRecovery?.first).toMatchObject({collectCount:1,newIdentityCount:25,outcome:'progress'});
  expect('posts'in row?row.posts.length:row.replies.observations.length).toBe(2);
  expect(f.count().scrolls).toBe(1);expect(row.stopReason).toBe('budget_reached');
 }finally{f.close();vi.useRealTimers();}
});
it('recovery cannot convert semantic inventory, body end prose or an invalid root owner into a source control',async()=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  for(const mode of ['control','inventory','body','owner'] as const){
   const f=stallFixture();try{
    f.hooks.write=()=>{
     if(mode==='control')f.container().insertAdjacentHTML('beforeend','<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>');
     if(mode==='inventory')f.container().insertAdjacentHTML('beforeend','<div role="status">Show replies — No more replies</div>');
     if(mode==='body')f.container().querySelector('[data-testid="tweetText"]')!.textContent='No more replies';
     if(mode==='owner'){for(const a of f.container().querySelectorAll('[data-testid="User-Name"] a'))a.setAttribute('href','/mallory');f.add();}
    };
    const {row}=await f.run({maxScrollsPerPost:1,maxExpandActionsPerPost:1});
    expect(f.count().clicks).toBe(mode==='control'?1:0);
    if('replies'in row){expect(row.replies.scope.completeness).toBe('unknown');expect(row.diagnostics?.terminalFrame?.sourceEndDetector).toBe('not_implemented');}
    if(mode==='owner')expect(row.stopReason).toBe('identity_unproven');
    else expect(row.diagnostics?.scrollRecovery?.first?.outcome).toBe(mode==='control'?'progress':'expired');
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
it('reappearing reply already saved before body expansion is not new row progress',async()=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  for(const fresh of [true,false]){
   const f=stallFixture(false,true);try{
    f.container().querySelector('article')!.insertAdjacentHTML('beforeend','<button role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button>');
    f.hooks.write=()=>f.container().insertAdjacentHTML('beforeend',post(fresh?'402':'401',fresh?'next':'first','source identity'));
    const {row}=await f.run();
    expect(row).toMatchObject({budgetUsage:{scrolls:fresh?2:1,expandActions:1}});
    if('replies'in row)expect(row.replies.observations.map(p=>p.postId)).toEqual(fresh?['401','402']:['401']);
    expect(row.diagnostics?.scrollRecovery?.first).toMatchObject({newIdentityCount:fresh?1:0,outcome:fresh?'progress':'expired'});
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
it('a reappearing previously used physical control cannot repeatedly reactivate a stalled page, while a new control can',async()=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  for(const fresh of [true,false]){
   const f=stallFixture();try{
    const html='<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>';
    f.container().insertAdjacentHTML('beforeend',html);const old=f.container().querySelector('button')!;
    f.hooks.write=()=>{if(fresh)f.container().insertAdjacentHTML('beforeend',html);else f.container().querySelector('[data-testid="cellInnerDiv"]')!.append(old);};
    const {row}=await f.run({maxScrollsPerPost:1,maxExpandActionsPerPost:2});
    expect(f.count().clicks).toBe(fresh?2:1);
    expect(row.diagnostics?.scrollRecovery?.first?.outcome).toBe(fresh?'progress':'expired');
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
it.each([false,true])('monotonic deadline wins when collection crosses it before timers run, across caps and identity changes (search=%s)',async(search)=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});const baseNow=performance.now.bind(performance);let offset=0;
 const clock=vi.spyOn(performance,'now').mockImplementation(()=>baseNow()+offset);
 try{
  for(const cap of [2,1])for(const fresh of [true,false])for(const elapsed of [7999,8000,8050]){
   offset=0;const f=stallFixture(search,true);try{
    f.hooks.collect=()=>{if(f.count().collects===2){offset=elapsed;if(fresh)f.add();else f.container().querySelector('[data-testid="tweetText"]')!.textContent='same identity, changed body';}};
    const {row}=await f.run({maxScrollsPerPost:cap});
    const inTime=elapsed<8000;
    expect(f.count().scrolls,JSON.stringify({cap,fresh,elapsed})).toBe(inTime&&fresh?cap:1);
    expect(row.diagnostics?.scrollRecovery?.first).toMatchObject({outcome:inTime&&fresh?'progress':'expired',newIdentityCount:fresh?1:0});
    // At 7999ms, the old identity can schedule one pause but no later source read.
    expect(row.diagnostics?.scrollRecovery?.first?.collectCount).toBe(1);
    expect('posts'in row?row.posts.map(p=>p.postId):row.replies.observations.map(p=>p.postId)).toEqual(fresh?['401','402']:['401']);
   }finally{f.close();}
  }
 }finally{clock.mockRestore();vi.useRealTimers();}
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

const recoveryOwnUrl='https://x.com/next/status/402';
const recoveryCover='<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/writer">@writer</a></div><div data-testid="article-cover-image">Article</div></div>';
function replaceRootWithIndependentPosts(f:ReturnType<typeof stallFixture>,cover=true) {
 // Four raw containers, but only two nonempty independently named bodies.
 const withCover=(id:string,text:string)=>post(id,'next',text).replace('</article>',(cover?recoveryCover:'')+'</article>');
 f.container().innerHTML=withCover('402','Independent body after root loss')+post('403','other','Second independent body')
  +withCover('404','')+post('405','wrong','Rejected author').replace('/wrong/status/405','/different/status/405');
}
it('retains independently decoded recovery bodies and own Article gaps before root rejection, including late collections',async()=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  for(const delay of [0,8001]){
   const ledger=new XResearchEvidence('/tmp',()=> 'run'),report='/tmp/x-research-recovery-2026-10-15.md';
   for(const cover of [false,true]){
    const f=stallFixture(false,true);try{
     f.hooks.collect=async()=>{if(f.count().collects===2){await new Promise(resolve=>setTimeout(resolve,delay));replaceRootWithIndependentPosts(f,cover);}};
     const {result,row}=await f.run();if(!('replies'in row))throw new Error('expected read');
     expect(f.count()).toEqual({collects:2,scrolls:1,clicks:0});
     expect(row).toMatchObject({status:'partial',reason:'post_identity_unproven',stopReason:'identity_unproven',
      root:{postId:'123',sourceUrl:'https://x.com/alice/status/123',text:'original'},
      replies:{observations:[{postId:'401',text:'original'}],scope:{completeness:'unknown'}},
      budgetUsage:{scrolls:1,expandActions:0,distinctEntries:4}});
     expect(row.unscopedPosts?.observations.map(p=>({postId:p.postId,text:p.text,containerKind:p.containerKind,relationToTarget:p.relationToTarget,observedContainer:p.observedContainer}))).toEqual([
      {postId:'402',text:'Independent body after root loss',containerKind:'unscoped_post',relationToTarget:'unproven',observedContainer:'post'},
      {postId:'403',text:'Second independent body',containerKind:'unscoped_post',relationToTarget:'unproven',observedContainer:'post'},
     ]);
     expect(row.unscopedPosts?.inventory).toEqual({scope:'collection',observed:2,retained:2,omitted:0,sourceInventoryTruncated:false,excludedNestedQuotes:0});
     if(cover)expect(row.unscopedPosts?.previewGaps).toEqual([{sourceUrl:recoveryOwnUrl,unresolved:1},{sourceUrl:'https://x.com/next/status/404',unresolved:1}]);
     expect(row.unscopedPosts?.observations[0].articlePreviewInventory).toEqual({scope:'collection',observed:0,retained:0,omitted:0,unresolved:cover?1:0});
     expect(row.diagnostics).toMatchObject({initialFrame:{rootIdentityProven:true,replyCount:1},firstAdmittedFrame:{rootIdentityProven:true},
      terminalFrame:{rootIdentityProven:false,inventory:{returned:4},sourceEndDetector:'not_implemented',sourceRootState:{root:{connection:'detached'}}},
      scrollRecovery:{totalRecoveries:1,first:{collectCount:1,newIdentityCount:0,outcome:'identity_unproven'}}});
     expect(row.unscopedPosts?.collection).toEqual({snapshotId:row.diagnostics!.terminalFrame!.snapshotId,document:row.diagnostics!.terminalFrame!.document,location:row.diagnostics!.terminalFrame!.location});
     const payload=xResearchToolResult(serializeXResearchResult(result));
     expect(payload.details).toMatchObject({targets:[{unscopedPosts:{observations:[{postId:'402',relationToTarget:'unproven'},{postId:'403',relationToTarget:'unproven'}]}}]});
     expect(JSON.parse(payload.content[0].text)).toMatchObject({targets:[{unscopedPosts:{observations:[{postId:'402',sourceUrl:recoveryOwnUrl,text:'Independent body after root loss',relationToTarget:'unproven',observedContainer:'post',articlePreviewInventory:{unresolved:cover?1:0}},{postId:'403',relationToTarget:'unproven'}]}}]});
     ledger.restore([{type:'message',message:{role:'toolResult',toolName:'x_research',toolCallId:'call',...payload,isError:false,timestamp:1}}]);
     const citation=`Observed evidence [source](${recoveryOwnUrl})`;
     if(cover)expect(()=>ledger.guard(report,citation)).toThrow(/inventory is unknown/);
     else expect(ledger.guard(report,citation)).toEqual({createOnly:true});
     expect(ledger.guard(report,'Observed evidence [source](https://x.com/other/status/403)')).toEqual({createOnly:true});
    }finally{f.close();}
   }
  }
 }finally{vi.useRealTimers();}
});
it('recovery retention still requires requested replies and safe non-Article, non-auth, same-location source frames',async()=>{
 vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','performance']});try{
  for(const mode of ['admitted','disabled','article','auth','epoch','revision','sequence','generation','route','cancel'] as const){
   const f=stallFixture(false,true);try{
    f.hooks.collect=()=>{if(f.count().collects===2){
     replaceRootWithIndependentPosts(f);
     if(mode==='article')f.container().insertAdjacentHTML('beforeend','<article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">@alice</a></div><article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">Article</div><div data-testid="twitterArticleRichTextView"><div data-testid="longformRichTextComponent" contenteditable="false"><div data-block="true">Article body</div></div></div></article></article>');
     if(mode==='auth'){f.facts.currentUrl='https://x.com/i/jf/onboarding/web';f.facts.routeRevision++;f.dom.reconfigure({url:f.facts.currentUrl});f.dom.window.document.body.insertAdjacentHTML('beforeend','<div role="dialog"><input name="username_or_email" type="text" autocomplete="username webauthn"><input name="password" type="password"></div>');}
     if(mode==='epoch')f.facts.documentEpoch++;
     if(mode==='revision')f.facts.routeRevision++;
     if(mode==='sequence')f.facts.navigationSequence++;
     if(mode==='generation')f.dom.window.eval('delete window.__kydogWorld');
     if(mode==='route'){f.facts.currentUrl='https://x.com/alice/status/123/history';f.dom.reconfigure({url:f.facts.currentUrl});}
     if(mode==='cancel')f.abort.abort();
    }};
    const {row}=await f.run({includeReplies:mode!=='disabled'});if(!('replies'in row))throw new Error('expected read');
    if(mode==='admitted')expect(row.unscopedPosts?.observations.map(p=>p.postId)).toEqual(['402','403']);
    else expect(row.unscopedPosts,mode).toBeUndefined();
    expect(f.count()).toEqual({collects:mode==='disabled'?1:2,scrolls:mode==='disabled'?0:1,clicks:0});
    expect(row.root).toMatchObject({postId:'123',text:'original'});
    expect(row.replies.observations.map(p=>p.postId)).toEqual(mode==='disabled'?[]:['401']);
    expect(row.replies.scope.completeness).toBe('unknown');
    if(mode==='auth')expect(row.status).toBe('auth_required');
    if(mode==='cancel')expect(row.status).toBe('cancelled');
   }finally{f.close();}
  }
 }finally{vi.useRealTimers();}
});
