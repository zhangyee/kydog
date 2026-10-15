import { admitXSourceRoot, xSourceRootReleaseExpression } from './xPageSource';
import { logger } from '../log';
import { JSDOM } from 'jsdom';
import { measuredPointerExpression, pointerGuardExpression } from '../browser/measuredPointerSource';
import { describe, expect, it, vi } from 'vitest';
import { BrowserScrollAcknowledgementError } from '../browser/actions';
import { KydogError } from '../../shared/errors';
import type { BrowserService, BrowserLocationFacts } from '../browser/browserService';
import type { AxSnapshot } from '../browser/snapshot';
import { createXResearchBrowser } from './xResearchBrowser';

function fixture() {
  let tail = Promise.resolve();
  let queues = 0, injections = 0;
  const facts: BrowserLocationFacts = { currentUrl: 'https://x.com/a/status/123', documentEpoch: 1, routeRevision: 0, navigationEvent: 'did-navigate', navigationSequence: 1, navigationType: 'cross_document', navigationUrl: 'https://x.com/a/status/123' };
  const snapshot = { snapshotId: 'snap', generation: 'doc', url: facts.currentUrl, nodes: [] } as unknown as AxSnapshot;
  const gone = new Set<(id: string) => void>();
  const unavailable = new Set<(id: string) => void>();
  const enqueue = <T>(_id: string, work: () => Promise<T>) => { queues++; const next = tail.then(work, work); tail = next.then(() => {}, () => {}); return next; };
  const browser = {researchTabStatus:()=>'available',
    enqueue,
    open: (args: { url: string; tabId?: string }) => enqueue(args.tabId ?? 'tab', async () => ({ tabId: 'tab', nav: { navigationId: 'nav', outcome: { kind: 'ok', finalUrl: args.url, httpStatusCode: 200 } }, evicted: [] })),
    withAgentDriving: <T>(_id: string, _thread: string, work: () => Promise<T>) => work(),
    locationFacts: () => ({ ...facts }),
    snapshot: async () => { injections++; return snapshot; },
    dispatchAndObserveNavigation: async () => { injections++; return { line: 'acted', navigation: null }; },
    waitFor: async () => { injections++; return true; },
    onTabDestroyed: (fn: (id: string) => void) => { gone.add(fn); return () => gone.delete(fn); },
    onTabUnavailable: (fn: (id: string) => void) => { unavailable.add(fn); return () => unavailable.delete(fn); },
  } as unknown as BrowserService;
  return { browser, facts, snapshot, enqueue, gone, unavailable, count: () => ({ queues, injections }) };
}

describe('X queued browser port', () => {
  it('oneQueuePerOperation: open, queued cancellation, action exception and next task', async () => {
    const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
    await port.open(f.facts.currentUrl, undefined);
    expect(f.count()).toEqual({ queues: 1, injections: 0 });
    await port.withPage('tab', undefined, async page => { const snap = await page.snapshot(); await page.act({ kind: 'click', index: 1, snapshotId: snap.snapshotId }, snap); await page.wait({ urlMatches: '/status/123' }, 100); });
    expect(f.count()).toEqual({ queues: 2, injections: 3 });
    let release!: () => void;
    const blocker = f.enqueue('tab', () => new Promise<void>(r => { release = r; }));
    await Promise.resolve();
    const abort = new AbortController();
    const pending = port.withPage('tab', abort.signal, async page => page.snapshot());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'browser.cancelled' });
    abort.abort(); release(); await blocker; await rejected;
    expect(f.count().injections).toBe(3);
    await expect(port.withPage('tab', undefined, async () => { throw new Error('action failed'); })).rejects.toThrow('action failed');
    await port.withPage('tab', undefined, async page => page.snapshot());
    expect(f.count()).toEqual({ queues: 6, injections: 4 });
  });
  it('a normalization remains visible but every route or document event invalidates the old binding', async () => {
    const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
    await port.withPage('tab', undefined, async page => {
      const snap = await page.snapshot();
      await page.act({ kind: 'click', selector: '#safe' }, snap);
      f.facts.currentUrl = 'https://x.com/i/web/status/123'; f.facts.routeRevision++;
      expect(page.location()).toMatchObject({ currentUrl: f.facts.currentUrl, documentEpoch: 1, routeRevision: 1 });
      await expect(page.act({ kind: 'click', selector: '#safe' }, snap)).rejects.toMatchObject({ code: 'browser.stale_snapshot' });
      const fresh = await page.snapshot();
      f.facts.documentEpoch++;
      await expect(page.act({ kind: 'click', selector: '#safe' }, fresh)).rejects.toMatchObject({ code: 'browser.stale_snapshot' });
    });
    expect(f.count().injections).toBe(3);
  });
  it('tab destruction and crash terminate an in-flight wait and remove only owned listeners', async () => {
    for (const event of ['gone', 'unavailable'] as const) {
      const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
      const external = () => {}; f[event].add(external);
      let start!: () => void; const started = new Promise<void>(r => { start = r; });
      const running = port.withPage('tab', undefined, async () => { start(); return new Promise(() => {}); });
      const rejected = expect(running).rejects.toMatchObject({ code: 'browser.not_dispatchable' });
      await started;
      expect(f[event].size).toBe(2);
      for (const notify of [...f[event]]) notify('tab');
      await rejected;
      expect([...f[event]]).toEqual([external]);
    }
  });
  it('collect rejects non-program requests before page evaluation', async () => {
    const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
    await port.withPage('tab', undefined, async page => {
      expect(Object.keys(page).sort()).toEqual(['act', 'collect', 'location', 'snapshot', 'wait']);
      await expect(page.collect({ stage: 'post', expectedUrl: f.facts.currentUrl, postId: '123' })).rejects.toThrow();
      await expect(page.collect('alert(1)' as never)).rejects.toMatchObject({ code: 'x.invalid_page' });
    });
  });
});


it.each(['cancel', 'destroy', 'crash'] as const)('queued %s rejects before the preceding queue task releases', async reason => {
  const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
  await port.withPage('tab', undefined, page => page.snapshot());
  expect(f.count().injections).toBe(1);
  let release!: () => void;
  const blocker = f.enqueue('tab', () => new Promise<void>(r => { release = r; }));
  await Promise.resolve();
  const abort = new AbortController();
  const pending = port.withPage('tab', abort.signal, page => page.snapshot());
  const rejected = expect(pending).rejects.toMatchObject({ code: reason === 'cancel' ? 'browser.cancelled' : 'browser.not_dispatchable' });
  if (reason === 'cancel') abort.abort();
  else for (const notify of [...f[reason === 'destroy' ? 'gone' : 'unavailable']]) notify('tab');
  // If lifetime wiring starts only after dequeue, this await deadlocks and REDs.
  await rejected;
  expect(f.count().injections).toBe(1);
  release(); await blocker;
  await f.enqueue('tab', async () => {});
  expect(f.count().injections).toBe(1);
});


it('caller cancellation is prompt but the queue lease covers deferred native release and cleanup', async () => {
  const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
  const order: string[] = [];
  await port.withPage('tab', undefined, async () => { order.push('control entered'); });
  expect(order).toEqual(['control entered']); order.length = 0;
  let pressed!: () => void, releasePress!: () => void, cleanupStarted!: () => void, releaseCleanup!: () => void;
  const started = new Promise<void>(r => { pressed = r; });
  const cleaned = new Promise<void>(r => { cleanupStarted = r; });
  f.browser.dispatchAndObserveNavigation = async () => {
    order.push('press in flight'); pressed();
    await new Promise<void>(r => { releasePress = r; });
    order.push('native release'); cleanupStarted();
    await new Promise<void>(r => { releaseCleanup = r; });
    order.push('cleanup settled');
    return { line: 'clicked', navigation: null };
  };
  const abort = new AbortController();
  const old = port.withPage('tab', abort.signal, async page => { const snap = await page.snapshot(); return page.act({ kind: 'click', selector: '#target' }, snap); });
  const rejected = expect(old).rejects.toMatchObject({ code: 'browser.cancelled' });
  await started; abort.abort(); await rejected; order.push('caller cancelled');
  const next = port.withPage('tab', undefined, async () => { order.push('next entered'); });
  // Drain runnable promise continuations, never advance a deadline or infer from elapsed time.
  for (let i = 0; i < 24; i++) await Promise.resolve();
  expect(order).toEqual(['press in flight', 'caller cancelled']);
  releasePress(); await cleaned;
  for (let i = 0; i < 24; i++) await Promise.resolve();
  expect(order).toEqual(['press in flight', 'caller cancelled', 'native release']);
  releaseCleanup(); await next;
  expect(order).toEqual(['press in flight', 'caller cancelled', 'native release', 'cleanup settled', 'next entered']);
});

it('keeps real open navigation results when the optional Article provenance can no longer read the tab', async () => {
  const f=fixture(),port=createXResearchBrowser(f.browser,'thread');
  expect((await port.open(f.facts.currentUrl,undefined)).nav.outcome.kind).toBe('ok');
  f.browser.locationFacts=()=>{throw new KydogError('browser.no_tab','closed');};
  for (const outcome of [{kind:'cancelled' as const},{kind:'ok' as const,finalUrl:f.facts.currentUrl,httpStatusCode:200}]) {
    const result={tabId:'tab',nav:{navigationId:'actual',outcome},evicted:[]};
    f.browser.open=async()=>result;
    await expect(port.open(f.facts.currentUrl,undefined)).resolves.toEqual(result);
  }
});

it('private collected permission reaches actual measure and survives caller edits, while selector rebinding is rejected',async()=>{
  const f=fixture();
  const dom=new JSDOM('<main><div data-testid="primaryColumn"><div aria-label="Timeline: Conversation"><article data-testid="tweet"><div data-testid="User-Name"><a href="/a">@a</a></div><a href="/a/status/123/history"><time>today</time></a><div data-testid="tweetText">body</div><button role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button></article></div></div></main>',{url:f.facts.currentUrl,runScripts:'outside-only'});
  const el=dom.window.document.querySelector('button')!;
  Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
  Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
  Object.assign(dom.window.document,{elementFromPoint:()=>el});el.scrollIntoView=()=>{};
  f.browser.prepareForDomRead=async()=>{};
  f.browser.evalInPage=async<T>(_id:string,code:string|((notAfter:number)=>string))=>dom.window.eval(typeof code==='string'?code:code(Date.now()+3000)) as T;
  let dispatched=0;
  f.browser.dispatchAndObserveNavigation=async(_id,action,snapshot,options)=>{
    expect(options?.collectedPointerEligibility).toBe(true);
    const node=snapshot!.nodes.find(n=>'index' in action && n.index===action.index)!;
    const pointer={token:'native',kind:'click' as const,expiresAt:Date.now()+3000};
    const m=dom.window.eval(measuredPointerExpression({nodeId:node.nodeId,collectedPermission:options?.collectedPermission},pointer,Date.now()+3000)) as {ok:boolean;pointerGuard:{ok:boolean}};
    if(!m.ok || !m.pointerGuard.ok || !(dom.window.eval(pointerGuardExpression('validate',pointer,Date.now()+3000)) as {ok:boolean}).ok) throw new KydogError('browser.target_unusable','changed');
    dispatched++;return {line:'clicked',navigation:null};
  };
  const port=createXResearchBrowser(f.browser,'thread');
  try {await port.withPage('tab',undefined,async page=>{
    const observed=await page.collect({stage:'post',expectedUrl:f.facts.currentUrl,postId:'123'});
    const b=observed.controls[0].binding, click={kind:'click' as const,index:b.index,snapshotId:b.snapshotId};
    observed.snapshot.nodes[0].collectedPermission!.token='caller changed';
    await page.act(click,observed.snapshot);expect(dispatched).toBe(1);
    await expect(page.act({kind:'click',selector:'button'},observed.snapshot)).rejects.toMatchObject({code:'browser.bad_action'});
    el.textContent='Reply';
    await expect(page.act(click,observed.snapshot)).rejects.toMatchObject({code:'browser.target_unusable'});
    expect(dispatched).toBe(1);
  });}finally{dom.window.close();}
});

it('opt-in scroll cancellation drains its actual receipt and disposal before returning',async()=>{
  const f=fixture(),port=createXResearchBrowser(f.browser,'thread');const order:string[]=[];
  await port.withPage('tab',undefined,async()=>{order.push('positive');});expect(order).toEqual(['positive']);order.length=0;
  let start!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{start=r;});
  f.browser.dispatchAndObserveNavigation=async(_tab,_action,_snapshot,options)=>{
    start();await new Promise<void>(r=>{release=r;});options?.scrollAcknowledgement?.onWritten();order.push('disposed');return {line:'scroll',navigation:null};
  };
  const abort=new AbortController();
  const work=port.withPage('tab',abort.signal,async page=>{const snap=await page.snapshot();await page.act({kind:'scroll',direction:'down'},snap,{scrollAcknowledgement:{onWritten:()=>order.push('written')}});});
  const done=work.catch(error=>{order.push('returned');expect(error).toMatchObject({code:'browser.cancelled'});});
  await started;abort.abort();for(let i=0;i<24;i++)await Promise.resolve();expect(order).toEqual([]);
  release();await done;expect(order).toEqual(['written','disposed','returned']);
});


it('preserves the typed scroll error object across the owned port without prose classification',async()=>{
  const f=fixture(),port=createXResearchBrowser(f.browser,'thread');let error:Error|undefined,writes=0;
  f.browser.dispatchAndObserveNavigation=async(_id,_action,_snapshot,options)=>{options?.scrollAcknowledgement?.onWritten();if(error)throw error;return {line:'scrolled',navigation:null};};
  const run=()=>port.withPage('tab',undefined,async page=>{const snap=await page.snapshot();return page.act({kind:'scroll',direction:'down'},snap,{scrollAcknowledgement:{onWritten:()=>writes++}});});
  expect(await run()).toMatchObject({line:'scrolled'});expect(writes).toBe(1);
  const causes=[new BrowserScrollAcknowledgementError('scroll_no_movement','scroll_ack_timeout'),new BrowserScrollAcknowledgementError('scroll_ack_timeout','scroll_no_movement'),new KydogError('browser.wait_timeout','scroll_no_movement scroll_ack_timeout')];
  for(const [index,cause] of causes.entries()){error=cause;await expect(run()).rejects.toBe(cause);expect(writes).toBe(index+2);}
});


it.each(['normal','cancel','gone','cancel_gone','evalthrow','release_throw','release_false','newlease'] as const)(
  'releases proven original source state within queue/driving after issued operations: %s',async mode=>{
    const f=fixture(), events:string[]=[];
    const dom=new JSDOM('<main><div data-testid="primaryColumn"><div aria-label="Timeline: Conversation"><article data-testid="tweet"><div data-testid="User-Name"><a href="/a">A</a></div><div data-testid="tweetText">Body</div><a href="/a/status/123"><time>today</time></a></article></div></div></main>',{url:f.facts.currentUrl,runScripts:'outside-only'});
    Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({left:0,top:0,width:100,height:30,right:100,bottom:30})});
    const evaluate=(code:string)=>dom.window.eval(code);
    const request={stage:'post' as const,postId:'123',expectedUrl:f.facts.currentUrl};
    let releasedOperation!:()=>void, started!:()=>void;
    const operationStarted=new Promise<void>(r=>{started=r;});
    const held=new Promise<void>(r=>{releasedOperation=r;});
    const abort=new AbortController();
    const errorLog=vi.spyOn(logger,'error').mockImplementation(()=>{});
    f.browser.prepareForDomRead=async()=>{};
    f.browser.withAgentDriving=async(_id,_thread,work)=>{events.push('driving');try{return await work();}finally{events.push('driving_end');}};
    let reads=0, cleanupOracle=false;
    f.browser.evalInPage=async(_id,code)=>{
      if(typeof code!=='string') throw Error('fixture only accepts fixed expressions');
      if(code.startsWith('/* kydog-x-root-release */')){
        events.push('release');
        if(cleanupOracle) throw Error('active realm release failure');
        if(mode==='cancel_gone') throw new KydogError('browser.no_tab','gone');
        if(mode==='release_throw') throw Error('private-token-must-not-be-logged');
        if(mode==='release_false') return {released:false};
        return evaluate(code);
      }
      reads++;const raw=evaluate(code);
      if(!cleanupOracle && reads===2 && ['cancel','gone','cancel_gone','evalthrow'].includes(mode)){
        started();await held;events.push('issued_settled');if(mode==='evalthrow') throw Error('collect failed');
      }
      return raw;
    };
    const port=createXResearchBrowser(f.browser,'thread');
    try {
      if(mode==='cancel_gone') {
        cleanupOracle=true;
        await expect(port.withPage('tab',undefined,async page=>{
          const first=await page.collect(request);admitXSourceRoot(first);
          expect(first.diagnosticFrame?.sourceRootState?.root.connection).toBe('connected');
          await page.collect(request);expect(evaluate('!!window.__kydogXRootState.anchor')).toBe(true);
        })).rejects.toMatchObject({code:'x.invalid_page',message:'Source root diagnostic cleanup failed'});
        expect(errorLog).toHaveBeenCalledWith('x_research','source_root_cleanup_failed',expect.objectContaining({phase:'release',failureCategory:'evaluation_rejected',purpose:'x_source_release',workFailed:false,sourceUsed:true}));
        expect(evaluate('!!window.__kydogXRootState.anchor')).toBe(true);
        evaluate(xSourceRootReleaseExpression(String(evaluate('window.__kydogXRootState.lease'))));
        errorLog.mockClear();events.length=0;reads=0;cleanupOracle=false;
      }
      const running=port.withPage('tab',abort.signal,async page=>{
        const first=await page.collect(request);admitXSourceRoot(first);
        expect(first.diagnosticFrame?.sourceRootState?.root.connection).toBe('connected');
        expect(evaluate('!!window.__kydogXRootState.pending')).toBe(true);
        if(mode==='newlease'){
          const lease=evaluate('window.__kydogXRootState.lease');
          expect(evaluate(xSourceRootReleaseExpression('unrelated'))).toEqual({released:true});
          expect(evaluate('window.__kydogXRootState.lease')).toBe(lease);
        }
        await page.collect(request);
        expect(evaluate('!!window.__kydogXRootState.anchor')).toBe(true);
      });
      if(['cancel','gone','cancel_gone','evalthrow'].includes(mode)){
        const rejected=expect(running).rejects.toMatchObject(mode==='evalthrow'?{message:'collect failed'}:{code:mode==='cancel'||mode==='cancel_gone'?'browser.cancelled':'browser.not_dispatchable'});
        await operationStarted;
        expect(evaluate('!!window.__kydogXRootState.anchor')).toBe(true);
        if(mode==='cancel'||mode==='cancel_gone') abort.abort();
        if(mode==='cancel_gone') {await Promise.resolve();dom.window.close();}
        if(mode==='gone'){for(const notify of f.gone) notify('tab');dom.window.close();}
        expect(events).toEqual(['driving']);releasedOperation();await rejected;
        await f.enqueue('tab',async()=>{events.push('next_queue');});
        expect(events).toEqual(mode==='gone'?['driving','issued_settled','driving_end','next_queue']:['driving','issued_settled','release','driving_end','next_queue']);
      }else if(mode.startsWith('release_')){
        await expect(running).rejects.toMatchObject({code:'x.invalid_page',message:'Source root diagnostic cleanup failed'});
        expect(errorLog).toHaveBeenCalledWith('x_research','source_root_cleanup_failed',expect.objectContaining({phase:'release',failureCategory:mode==='release_false'?'invalid_release_receipt':'evaluation_rejected',purpose:'x_source_release',workFailed:false,sourceUsed:true}));
        expect(evaluate('!!window.__kydogXRootState.anchor')).toBe(true);
        evaluate(xSourceRootReleaseExpression(String(evaluate('window.__kydogXRootState.lease'))));
      }else await running;
      if(mode!=='gone'&&mode!=='cancel_gone') expect(evaluate('window.__kydogXRootState')).toBeUndefined();
      if(mode==='cancel_gone') expect(errorLog).toHaveBeenCalledWith('x_research','source_root_cleanup_failed',expect.objectContaining({cause:'observed_realm_unavailable',phase:'release',workFailed:true}));
      if(mode==='newlease') await port.withPage('tab',undefined,async page=>{
        const fresh=await page.collect(request);expect(fresh.diagnosticFrame?.sourceRootState).toBeUndefined();admitXSourceRoot(fresh);
        expect(fresh.diagnosticFrame?.sourceRootState?.anchorSnapshotId).toBe(fresh.snapshot.snapshotId);
      });
    }finally{releasedOperation();errorLog.mockRestore();dom.window.close();}
  });

it.each(['prepare','evaluate','decode'] as const)('retains authenticated collection phase %s and preserves error/privacy',async phase=>{
 const {getSourceFailure}=await import('./xSourceDiagnostics');
 const f=fixture(),port=createXResearchBrowser(f.browser,'thread');
 const error=new KydogError('browser.page_no_result','SECRET_ERROR');
 f.browser.prepareForDomRead=async()=>{if(phase==='prepare')throw error;};
 f.browser.evalInPage=async(_id,code)=>{
  if(String(code).startsWith('/* kydog-x-root-release */'))return {released:true};
  if(phase==='evaluate')throw error;
  return {secret:'SECRET_VALUE'};
 };
 const caught=await port.withPage('tab',undefined,page=>page.collect({stage:'post',postId:'123',expectedUrl:f.facts.currentUrl})).catch(e=>e);
 if(phase!=='decode')expect(caught).toBe(error);
 expect(getSourceFailure(caught)).toMatchObject({purpose:'x_collect',tabId:'tab',phase,cause:'wrapper_failure',nativeSettlement:'not_observed',nativeSettlementObserved:false});
 const receipt=getSourceFailure(caught)!;
 expect(receipt.ownerId).not.toBe(receipt.operationId);
 expect(getSourceFailure(Object.assign(new Error('spoof'),{sourceFailure:receipt}))).toBeUndefined();
 expect(JSON.stringify(receipt)).not.toMatch(/SECRET_|https/);
});

it.each(['false','malformed','rejection','unavailable'] as const)('cleanup %s preserves cause and safe logger failures never replace work outcomes',async mode=>{
 const {getSourceFailure}=await import('./xSourceDiagnostics');
 const f=fixture(),port=createXResearchBrowser(f.browser,'thread');
 const original=Error('SECRET_ORIGINAL');
 f.browser.prepareForDomRead=async()=>{};
 f.browser.evalInPage=async(_id,code)=>{
  if(String(code).startsWith('/* kydog-x-root-release */')){
   if(mode==='rejection')throw Error('SECRET_RELEASE');
   if(mode==='unavailable')throw new KydogError('browser.no_tab','SECRET_REALM');
   return mode==='false'?{released:false}:{other:true};
  }
  throw original;
 };
 const spy=vi.spyOn(logger,'error').mockImplementation(()=>{});
 try{
  const run=(workFailed:boolean)=>port.withPage('tab',undefined,async page=>{try{await page.collect({stage:'post',postId:'123',expectedUrl:f.facts.currentUrl});}catch(error){if(workFailed)throw error;}return 42;});
  await expect(run(true)).rejects.toBe(original);
  const collection=getSourceFailure(original)!;
  expect(spy).toHaveBeenLastCalledWith('x_research','source_root_cleanup_failed',expect.objectContaining({ownerId:collection.ownerId,purpose:'x_source_release',workFailed:true,sourceUsed:true,cause:mode==='false'||mode==='malformed'?'invalid_release_receipt':mode==='unavailable'?'observed_realm_unavailable':'wrapper_failure'}));
  expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET');
  spy.mockImplementation(()=>{throw Error('LOGGER');});
  await expect(run(true)).rejects.toBe(original);
  if(mode==='unavailable')await expect(run(false)).resolves.toBe(42);
  else{
   const failure=await run(false).catch(e=>e);
   expect(failure).toMatchObject({code:'x.invalid_page'});
   expect(getSourceFailure(failure)).toMatchObject({purpose:'x_source_release',phase:'release',cause:mode==='rejection'?'wrapper_failure':'invalid_release_receipt'});
  }
 }finally{spy.mockRestore();}
});

it('cleanup reusing the primary error object cannot overwrite its collection receipt',async()=>{
 const {getSourceFailure}=await import('./xSourceDiagnostics');
 const f=fixture(),port=createXResearchBrowser(f.browser,'thread'),error=Error('same native error');
 f.browser.prepareForDomRead=async()=>{};f.browser.evalInPage=async()=>{throw error;};
 const log=vi.spyOn(logger,'error').mockImplementation(()=>{});
 try{
  await expect(port.withPage('tab',undefined,page=>page.collect({stage:'post',postId:'123',expectedUrl:f.facts.currentUrl}))).rejects.toBe(error);
  expect(getSourceFailure(error)).toMatchObject({purpose:'x_collect',phase:'evaluate'});
  expect(log).toHaveBeenCalledWith('x_research','source_root_cleanup_failed',expect.objectContaining({purpose:'x_source_release',phase:'release',workFailed:true}));
 }finally{log.mockRestore();}
});

it('captures first response before open returns, supplies an exclusive network body and releases its own lease',async()=>{
 const capture=(await import('../../test-support/fixtures/x-network/search-top-initial.json')).default;
 const {createHash}=await import('node:crypto');const f=fixture();
 const request={stage:'search' as const,expectedUrl:'https://x.com/search?q=from%3ACaptureAuthor&f=top',query:'from:CaptureAuthor',product:'Top' as const};
 f.facts.currentUrl=request.expectedUrl;const dom=new JSDOM('<main><div data-testid="primaryColumn"><article data-testid="tweet"><div data-testid="tweetText">DOM MUST NOT SUPPLY BODY</div></article></div></main>',{url:request.expectedUrl,runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({width:100,height:30,left:0,top:0,right:100,bottom:30})});
 const close=vi.fn(async()=>{});let drained=false,changeGeneration=false;
 Object.assign(f.browser,{prepareForDomRead:async()=>{},evalInPage:async(_id:string,code:string)=>dom.window.eval(code),open:async(args:any)=>{
  const raw={id:'source',requestId:'r',redirectIndex:0,sessionId:null,isMainFrame:true,frameId:'frame',loaderId:'loader',navigationId:'[null,"frame","loader"]',location:{...f.facts},method:'GET',url:'https://x.com/i/api/graphql/variable-id/SearchTimeline?variables='+encodeURIComponent(JSON.stringify(capture.request))};
  expect(args.network.accepts(raw)).toBe(true);const body=JSON.stringify(capture.body);
  return{tabId:'tab',evicted:[],nav:{navigationId:'navigation-receipt-is-different',outcome:{kind:'ok',finalUrl:request.expectedUrl,httpStatusCode:200}},networkLease:{id:'native',tabId:'tab',close,drain:async()=>{if(drained)return[];drained=true;if(changeGeneration)f.facts.routeRevision++;return[{kind:'request',request:raw},{kind:'response',request:raw,status:200,body,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}];}}};
 }});
 const port=createXResearchBrowser(f.browser,'thread');const opened=await port.open(request.expectedUrl,undefined,undefined,request);expect(opened.networkLeaseId).toEqual(expect.any(String));
 await port.withPage('tab',undefined,async page=>{const o=await page.collect(request);expect(o.network?.pages[0].posts).toHaveLength(20);expect(o.network?.proof.navigationId).toBe('[null,"frame","loader"]');expect(o.posts).toEqual([]);expect(o.snapshot.generation).toBeTruthy();await page.act({kind:'scroll',direction:'down'},o.snapshot);});
 expect(close).toHaveBeenCalledOnce();await expect(port.withPage('tab',undefined,p=>p.collect(request))).rejects.toThrow('lease_missing');
 drained=false;changeGeneration=true;await port.open(request.expectedUrl,'tab',undefined,request);
 await expect(port.withPage('tab',undefined,p=>p.collect(request))).rejects.toThrow('generation_changed');
 drained=false;changeGeneration=false;await port.open(request.expectedUrl,'tab',undefined,request);
 const {XNetworkSearchLease}=await import('./xNetworkLease');const collect=XNetworkSearchLease.prototype.collect;
 const spy=vi.spyOn(XNetworkSearchLease.prototype,'collect').mockImplementation(async function(this:import('./xNetworkLease').XNetworkSearchLease,...args){const accepted=await collect.apply(this,args);f.facts.routeRevision++;return accepted;});
 try{await port.withPage('tab',undefined,async page=>{const o=await page.collect(request);expect(o.network?.pages[0].posts).toHaveLength(20);expect(o.network).toMatchObject({failure:'generation_changed',pending:false});expect(o.identityProven).toBe(false);await expect(page.act({kind:'scroll',direction:'down'},o.snapshot)).rejects.toMatchObject({code:'browser.stale_snapshot'});});}finally{spy.mockRestore();}
});

it('reports cleanup failure on failed navigation and actual cancellation before the caller settles',async()=>{
 const {getXNetworkCleanupFailure}=await import('./xNetworkLease');
 const f=fixture(),port=createXResearchBrowser(f.browser,'thread');
 const request={stage:'search' as const,expectedUrl:'https://x.com/search?q=test&f=top',query:'test',product:'Top' as const};
 let failedNavigation=true,closeFails=false,releaseClose:()=>void=()=>{};
 const close=vi.fn(async()=>{if(closeFails){await new Promise<void>(resolve=>{releaseClose=resolve;});throw Error('PRIVATE native close');}});
 f.browser.open=async()=>({tabId:'tab',evicted:[],nav:{navigationId:'nav',outcome:failedNavigation?{kind:'timeout',abortObserved:false}:{kind:'ok',finalUrl:request.expectedUrl,httpStatusCode:200}},networkLease:{id:'native',tabId:'tab',drain:async()=>[],take:async()=>{throw Error('unused');},close}});
 const normal=await port.open(request.expectedUrl,undefined,undefined,request);expect(normal.nav.outcome.kind).toBe('timeout');
 closeFails=true;const opening=port.open(request.expectedUrl,undefined,undefined,request);await vi.waitFor(()=>expect(close).toHaveBeenCalledTimes(2));releaseClose();
 const failed=await opening;expect(failed).toMatchObject({nav:{outcome:{kind:'timeout'}},networkCleanupFailure:'network_cleanup_failed'});expect(normal.networkCleanupFailure).toBeUndefined();
 failedNavigation=false;await port.open(request.expectedUrl,undefined,undefined,request);
 const controller=new AbortController();let entered=false,settled=false;
 const pending=port.withPage('tab',controller.signal,async()=>{entered=true;await new Promise(()=>{});}).catch(error=>{settled=true;return error;});
 await vi.waitFor(()=>expect(entered).toBe(true));controller.abort();
 await vi.waitFor(()=>expect(close).toHaveBeenCalledTimes(3));expect(settled).toBe(false);releaseClose();
 const error=await pending;expect(error).toMatchObject({code:'browser.cancelled'});expect(getXNetworkCleanupFailure(error)).toBe('network_cleanup_failed');
});

it('attaches cleanup failure when cancellation wins before queued work starts or the source dies',async()=>{
 const {getXNetworkCleanupFailure}=await import('./xNetworkLease');
 for(const mode of ['queued','source_death'] as const){
  const f=fixture(),port=createXResearchBrowser(f.browser,'thread');
  const request={stage:'search' as const,expectedUrl:'https://x.com/search?q=test&f=top',query:'test',product:'Top' as const};
  const close=vi.fn(async()=>{throw Error('PRIVATE close');});
  f.browser.open=async()=>({tabId:'tab',evicted:[],nav:{navigationId:'nav',outcome:{kind:'ok',finalUrl:request.expectedUrl,httpStatusCode:200}},networkLease:{id:'native',tabId:'tab',drain:async()=>[],take:async()=>{throw Error('unused');},close}});
  await port.open(request.expectedUrl,undefined,undefined,request);
  let release=()=>{};const blocker=mode==='queued'?f.enqueue('tab',()=>new Promise<void>(resolve=>{release=resolve;})):Promise.resolve();await Promise.resolve();
  let entered=false;const controller=new AbortController();
  const pending=port.withPage('tab',controller.signal,async()=>{entered=true;await new Promise(()=>{});}).catch(error=>error);
  if(mode==='queued')controller.abort();else{await vi.waitFor(()=>expect(entered).toBe(true));for(const notify of f.gone)notify('tab');}
  const error=await pending;expect(error).toMatchObject({code:mode==='queued'?'browser.cancelled':'browser.not_dispatchable'});expect(getXNetworkCleanupFailure(error)).toBe('network_cleanup_failed');expect(close).toHaveBeenCalledOnce();
  release();await blocker;
 }
});

it('preserves source-valid accepted pages through real adapter cancellation into search canonical output',async()=>{
 const {searchX}=await import('./xResearchSearch');const {canonicalizeXResearchResult}=await import('./xResearchCanonical');const {serializeXResearchResult}=await import('./xResearchOutput');
 const {XNetworkSearchLease}=await import('./xNetworkLease');const {createHash}=await import('node:crypto');
 const capture=(await import('../../test-support/fixtures/x-network/search-top-initial.json')).default;
 const query={id:'q',query:capture.request.rawQuery,purpose:'test',product:'Top' as const};
 const url='https://x.com/search?q=from%3ACaptureAuthor&f=top';
 const original=XNetworkSearchLease.prototype.collect;
 for(const timing of ['normal','after_accept','before_accept'] as const){
  const f=fixture(),controller=new AbortController();f.facts.currentUrl=url;
  const dom=new JSDOM('<main><div data-testid="primaryColumn"></div></main>',{url,runScripts:'outside-only'});
  let accepted=0;
  Object.assign(f.browser,{prepareForDomRead:async()=>{},evalInPage:async(_id:string,code:string)=>dom.window.eval(code),open:async(args:any)=>{
   const raw={id:'source',requestId:'r',redirectIndex:0,sessionId:null,isMainFrame:true,frameId:'f',loaderId:'l',navigationId:'[null,"f","l"]',location:{...f.facts},method:'GET',url:'https://x.com/i/api/graphql/recorded/SearchTimeline?variables='+encodeURIComponent(JSON.stringify(capture.request))};
   expect(args.network.accepts(raw)).toBe(true);const body=JSON.stringify(capture.body);let drained=false;
   return{tabId:'tab',evicted:[],nav:{navigationId:'nav',outcome:{kind:'ok',finalUrl:url,httpStatusCode:200}},networkLease:{id:'native',tabId:'tab',close:async()=>{if(timing==='after_accept')throw Error('private cleanup');},take:async()=>{throw Error('unused');},drain:async()=>{if(drained)return[];drained=true;if(timing==='before_accept')controller.abort();return[{kind:'response',request:raw,status:200,body,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}];}}};
  }});
  const spy=vi.spyOn(XNetworkSearchLease.prototype,'collect').mockImplementation(async function(this:import('./xNetworkLease').XNetworkSearchLease,...args){const batch=await original.apply(this,args);accepted=batch.pages.reduce((n,p)=>n+p.posts.length,0);if(timing==='after_accept')controller.abort();return batch;});
  try{
   const result=canonicalizeXResearchResult(await searchX({search:{objective:'cancel evidence',queries:[query],maxPostsPerQuery:5,maxScrollsPerQuery:0}},{browser:createXResearchBrowser(f.browser,'thread'),threadId:'thread',runId:'run',callId:'call',batchId:'batch',signal:controller.signal,sources:new Map()}));
   if(result.operation!=='search')throw Error('search');const row=result.queries[0];
   expect(row.posts).toHaveLength(timing==='before_accept'?0:5);
   if(timing==='before_accept'){expect(row.stopReason).toBe('cancelled');expect(row.sampleTruncation).toEqual({observed:0,sampled:0,omitted:0});}
   else{
    expect(accepted).toBe(20);expect(row.networkPages).toHaveLength(1);expect(row.networkPages![0]).toMatchObject({observed:20,sampled:5,omitted:15,bytes:Buffer.byteLength(JSON.stringify(capture.body)),sha256:createHash('sha256').update(JSON.stringify(capture.body)).digest('hex')});expect(row.sampleTruncation).toEqual({observed:20,sampled:5,omitted:15});
    expect(row.posts[0].networkProvenance?.requestRef).toBe(row.networkPages![0].provenance.requestRef);
    const delivered=serializeXResearchResult(result).result;expect(delivered.queries[0].posts).toHaveLength(5);
    const {XResearchEvidence}=await import('./xResearchEvidence');const evidence=new XResearchEvidence('/tmp',()=>result.runId);evidence.observe(result);expect(evidence.observations).toHaveLength(5);expect(evidence.observations[0].networkProvenance).toEqual(row.posts[0].networkProvenance);
    evidence.restore([{type:'message',id:'history-entry',message:{role:'toolResult',toolName:'x_research',toolCallId:'call',details:result,content:[],isError:false}}]);expect(evidence.observations).toHaveLength(5);expect(evidence.observations[0]).toMatchObject({origin:'history',networkProvenance:row.posts[0].networkProvenance});
    if(timing==='after_accept')expect(row).toMatchObject({status:'cancelled',stopReason:'cancelled',diagnostics:{networkCleanupFailure:'network_cleanup_failed'}});
    else expect(row.stopReason).toBe('budget_reached');
   }
  }finally{spy.mockRestore();dom.window.close();}
 }
});
