import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import type { DispatchAction } from '../src/main/browser/actions';

interface State { page: { clicks: number; keys: number; input: number; trustedClicks: number; trustedKeys: number; value: string }; native: number; inserts: number; activeTabId: string; targetTabId: string; userTabId: string; focused: boolean }
interface EligibilityCounters { input:number;measures:number;scrolls:number;hits:number;trusted:number }
type DirectIdentityReceipt={result:Extract<import('../src/main/x/xResearchTypes').XResearchResult,{operation:'read'}>;collections:number;receipts:{before:import('../src/main/browser/browserService').BrowserLocationFacts;after:import('../src/main/browser/browserService').BrowserLocationFacts;event:{url:string;isMainFrame:boolean};raw:{rawUrl:string;article:{ownIdentityLinks:{totalKnown:number;hrefs:string[]};author:{handle:string};blocks:string[]}}}[]};
interface Harness {
  replyContinuation():Promise<{result:Extract<import('../src/main/x/xResearchTypes').XResearchResult,{operation:'read'}>;input:number;collections:{nodeId:number;generation:string;hasSourcePermission:boolean}[];physical:{trusted:number;sameButton:boolean;sameRoot:boolean;sameConversation:boolean}}>;

  directIdentity():Promise<{positive:DirectIdentityReceipt;negative:DirectIdentityReceipt}>;
  postFrameDiagnostic(mode:string):Promise<{preflights:import('../src/main/browser/pointerPreflightDiagnostic').PointerPreflightDiagnostic[];observations:string[];positive:EligibilityCounters&{frames:number};after:EligibilityCounters&{frames:number};results:unknown[];receipts:{snapshotId:string;generation:string;nodeId:number}[];error:string|null;sameControl:boolean;diagnostic:import('../src/main/browser/pointerDiagnostic').PointerFailureDiagnostic|null}>;
  pointerEligibility(mode:string):Promise<{replayError:string|null;replayCounters:EligibilityCounters;positive:EligibilityCounters;beforeWriter:EligibilityCounters;after:EligibilityCounters;observations:string[];sameBinding:boolean;error:string|null}>;
  read(): Promise<State>;
  readStages(mode:string):Promise<{result:Extract<import('../src/main/x/xResearchTypes').XResearchResult,{operation:'read'}>;actions:string[];rejectedNode:boolean;sourceCleanup:{populated:boolean;cleared:boolean};sourceGeometry:{before:number;after:number;height:number}|null;sourceActions:string[];activeTabId:string;userTabId:string}>;
  collectedPermission(mode:string):Promise<{mutationApplied:boolean;positive:{input:number;trusted:number};after:{input:number;trusted:number};error:string|null;sameNode:boolean;nativeOwnerProven:boolean;activeTabId:string;userTabId:string}>;
  neverShown(): Promise<{ before: { bounds: unknown; visible: boolean; activeTabId: string; userTabId: string }; error: unknown; phases: string[]; page: State['page']; activeTabId: string; userTabId: string; visible: boolean }>;
  typingBoundary(mode: string): Promise<{ before: State; after: State; error: string | null; destination: { query: string; other: string; active: string } }>;
  visible(): Promise<void>;
  hidden(): Promise<void>;
  act(action: DispatchAction): Promise<unknown>;
  faults(mode: string): Promise<{ before: State; after: State; error: string | null; diagnostic: import('../src/main/browser/pointerDiagnostic').PointerFailureDiagnostic | null }>;
  bindings(): Promise<{ before: { documentEpoch: number; routeRevision: number }; after: { documentEpoch: number; routeRevision: number }; error: string | null }>;
  lease(): Promise<{ control: string[]; error: string | null; beforeRelease: string[]; beforeCleanup: string[]; sequence: string[]; before: State; after: State }>;
  stop(): void;
}

// One isolated process for the feature area. Each repeat receives a fresh profile.
// Temporary research tabs close after their receipts are collected, preserving
// the original target used by later typing, lease, and stale-binding checks.
// Production BrowserService and XQueuedPage are imported into the fixture bundle;
// only the fixture has a global controller, never the shipped application.
test.describe('X browser port native safety (offline)', () => {
  test.describe.configure({ mode: 'serial' });
  let app: ElectronApplication, dir: string, failed = false;
  const control = <T>(fn: (h: Harness, value: string) => Promise<T>, value = '') => app.evaluate((_electron, source) => {
    const run = new Function('h', 'value', `return (${source.fn})(h, value)`);
    return run((globalThis as unknown as { __xUiHarness: Harness }).__xUiHarness, source.value);
  }, { fn: fn.toString(), value }) as Promise<T>;
  test.beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-x-ui-native-'));
    await build({ configFile: false, resolve:{conditions:['node']}, root: path.resolve(__dirname, '..'), logLevel: 'warn', build: {
      outDir: path.join(dir, 'bundle'), emptyOutDir: true, target: 'node22',
      lib: { entry: path.resolve(__dirname, 'fixtures/61-browser/xUiHarness.ts'), formats: ['cjs'], fileName: () => 'harness.cjs' },
      rollupOptions: { external: id => id === 'electron' || id==='jsdom' || id.startsWith('node:'), output:{paths:{jsdom:require.resolve('jsdom')}} },
    } });
    app = await _electron.launch({ args: [path.join(dir, 'bundle/harness.cjs'), '--force-device-scale-factor=1',
      ...(process.platform === 'darwin' ? ['-AppleShowScrollBars', 'Always'] : []), `--user-data-dir=${path.join(dir, 'profile')}`],
      env: { ...process.env, KYDOG_LOG: 'warn', PI_OFFLINE: '1', HOME: dir, USERPROFILE: dir }, timeout: 20_000 });
    await app.firstWindow();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __xUiReady: boolean }).__xUiReady), { timeout: 30_000 }).toBe(true);
  });
  test.afterEach(() => { if (test.info().status !== 'passed') failed = true; });
  test.afterAll(async () => {
    try { if (app) await control(async h => { h.stop(); }); }
    finally { if (app) await app.close(); }
    if (dir && !failed && app) await fs.rm(dir, {recursive:true,force:true});
    else if (dir) console.info('[retained-native-failure-directory]',dir);
  });

  test('same physical reply button continues under fresh source permissions through native input',async()=>{
    const receipt=await control(h=>h.replyContinuation());
    console.info('[reply-continuation-native]',JSON.stringify(receipt));
    expect(receipt.physical).toEqual({trusted:3,sameButton:true,sameRoot:true,sameConversation:true});
    expect(receipt.input).toBe(6);
    expect(receipt.collections).toHaveLength(4);
    const first=receipt.collections[0];
    expect(first.hasSourcePermission).toBe(true);
    expect(receipt.collections).toEqual(Array(4).fill(first));
    const row=receipt.result.targets[0];
    expect(row).toMatchObject({root:{postId:'321',text:'NETWORK_ROOT_094a'},budgetUsage:{expandActions:3,scrolls:0},stopReason:'budget_reached',replies:{scope:{kind:'network',extent:'unknown'}}});
    expect(row.replies.observations.map(p=>[p.postId,p.sourceUrl,p.text])).toEqual([['801','https://x.com/reply801/status/801','NETWORK_REPLY_801'],['802','https://x.com/reply802/status/802','NETWORK_REPLY_802'],['803','https://x.com/reply803/status/803','NETWORK_REPLY_803'],['804','https://x.com/reply804/status/804','NETWORK_REPLY_804']]);
    const d=row.diagnostics!.replyExpansions!;
    expect(d).toMatchObject({totalAttempts:3,omittedAttempts:1,first:{actionIndex:1,outcome:'succeeded',admission:{state:'consumed'},before:{inventory:{total:1}},after:{inventory:{state:'unavailable'}}},last:{actionIndex:3,outcome:'succeeded',usageAfter:{expansions:3},after:{inventory:{state:'unavailable'}}}});
    expect(d.first!.binding.nodeId).toBe(first.nodeId);expect(d.last!.binding.nodeId).toBe(first.nodeId);
    expect(d.first!.admission).toMatchObject({binding:d.first!.binding});expect(d.last!.admission).toMatchObject({binding:d.last!.binding});
  });

  test('real root removal retains network root and accepts same-chain replies',async()=>{
    const receipt=await control(h=>h.readStages('source-state'));
    console.info('[original-source-root-native]',JSON.stringify(receipt));
    const row=receipt.result.targets[0];
    expect(row.root).toMatchObject({postId:'321',text:'NETWORK_ROOT_094a',sourceKind:'page_graphql'});
    expect(row.replies.observations.map(p=>p.postId)).toEqual(['801','802']);
    expect(row.replies.scope).toMatchObject({kind:'network',extent:'unknown',context:{accountContextId:null}});
    expect(row.diagnostics?.scroll?.last).toMatchObject({written:true,eventObserved:true,frameObserved:true});
    expect(receipt.sourceActions).toContain('collection:rootless');
    expect(receipt.sourceGeometry?.height).toBeGreaterThan(0);
    expect(receipt.sourceGeometry?.after).toBe(receipt.sourceGeometry?.before);
    expect(receipt.sourceCleanup).toEqual({populated:true,cleared:true});
    expect(receipt.activeTabId).toBe(receipt.userTabId);
    const changed=await control(h=>h.readStages('source-invalidated'));
    const rejected=changed.result.targets[0];
    expect(rejected.root).toMatchObject({postId:'321',text:'NETWORK_ROOT_094a'});
    expect(rejected.stopReason).toBe('source_unavailable');
    expect(rejected.replies.observations.map(p=>p.postId)).not.toContain('802');
  });

  test('native same-URL collection transition requires matching current owned Article identity',async()=>{
    const r=await control(h=>h.directIdentity());
    console.info('[native-direct-article-identity]',JSON.stringify(r));
    for(const [name,value] of Object.entries(r)) {
      expect(value.receipts,name).toHaveLength(1);
      const receipt=value.receipts[0],transition=value.result.targets[0].collectionTransitions;
      expect(receipt.event,name).toEqual({url:'https://x.com/writer/status/654',isMainFrame:true});
      expect(receipt.after.currentUrl,name).toBe(receipt.before.currentUrl);
      expect(receipt.after.documentEpoch,name).toBe(receipt.before.documentEpoch);
      expect(receipt.after.routeRevision,name).toBeGreaterThan(receipt.before.routeRevision);
      expect(receipt.after.navigationSequence,name).toBeGreaterThan(receipt.before.navigationSequence);
      expect(receipt.after.navigationEvent,name).toBe('did-navigate-in-page');
      expect(receipt.raw,name).toMatchObject({rawUrl:receipt.after.currentUrl,article:{author:{handle:'writer'},blocks:['ARTICLE_BODY_DOM_a751','https://example.org/observed-external'],ownIdentityLinks:{totalKnown:1,hrefs:[name==='positive'?'/writer/status/654/analytics':'/writer/status/655/analytics']}}});
      expect(transition,name).toHaveLength(1);
      expect(transition![0],name).toMatchObject({outcome:'same_url_generation_changed',rereadRequested:true,navigationPhase:'initial_post',before:{documentEpoch:receipt.before.documentEpoch,routeRevision:receipt.before.routeRevision,navigationSequence:receipt.before.navigationSequence},after:{documentEpoch:receipt.after.documentEpoch,routeRevision:receipt.after.routeRevision,navigationSequence:receipt.after.navigationSequence}});
    }
    const positive=r.positive.result.targets[0],negative=r.negative.result.targets[0];
    expect(r.positive.collections).toBe(2);
    expect(positive).toMatchObject({status:'observed',root:null,article:{entryObserved:false,actionAttempted:false,navigationStarted:false,bodyObserved:true,body:{text:'ARTICLE_BODY_DOM_a751\n\nhttps://example.org/observed-external',postId:'654',author:{handle:'writer'},sourceUrl:'https://x.com/writer/status/654'},provenance:{kind:'direct_open',navigationId:positive.collectionTransitions![0].navigationId,bodyObservationId:positive.article.body?.observationId,nativeIdentity:{kind:'owned_analytics',href:'/writer/status/654/analytics',documentGeneration:positive.location?.documentGeneration}}},budgetUsage:{scrolls:0,expandActions:0,distinctEntries:1}});
    expect(r.negative.collections).toBe(3);
    expect(negative).toMatchObject({status:'failed',reason:'post_wait_timeout',article:{bodyObserved:false,body:null,entryObserved:false,actionAttempted:false,navigationStarted:false}});
  });

  test('original native CSS eligibility precedes sole measure, and cancellation, permission change and post-gate race still refuse',async()=>{
    for(const mode of ['enable','cancel','changed','race']){
      const r=await control((h,value)=>h.pointerEligibility(value),mode);
      console.info('[original-pointer-eligibility-native]',JSON.stringify({mode,...r}));
      expect(r.positive,mode).toEqual({input:2,measures:1,scrolls:1,hits:3,trusted:1});
      expect(r.replayError).toBe('browser.bad_action');expect(r.replayCounters).toEqual(r.positive);
      expect(r.beforeWriter,mode).toEqual({input:0,measures:0,scrolls:0,hits:0,trusted:1});
      expect(r.sameBinding,mode).toBe(true);
      if(mode==='enable'){
        expect(r.error).toBe(null);expect(r.observations).toEqual(['none','auto']);
        expect(r.after).toEqual({input:2,measures:1,scrolls:1,hits:3,trusted:2});
      }else{
        expect(r.error,mode).toBe(mode==='cancel'?'browser.cancelled':mode==='changed'?'browser.target_unusable':'browser.click_intercepted');
        expect(r.after.input,mode).toBe(0);expect(r.after.trusted,mode).toBe(1);
        expect(r.after.measures,mode).toBe(mode==='race'?1:0);expect(r.after.scrolls,mode).toBe(mode==='race'?1:0);expect(r.after.hits,mode).toBe(mode==='race'?1:0);
        expect(r.observations,mode).toEqual(mode==='cancel'?['none']:mode==='changed'?['none','invalid']:['none','auto']);
      }
    }
  });

  test('same original click recovers recurring post-frame NONE before its first final hit through native frames',async()=>{
    const r=await control((h)=>h.postFrameDiagnostic('recover'),undefined);
    console.info('[preflight-recovery-native]',JSON.stringify(r));
    expect(r.positive).toEqual({input:2,measures:1,frames:1,scrolls:1,hits:3,trusted:1});
    expect(r.sameControl).toBe(true);expect(r.error).toBeNull();expect(r.observations).toEqual(['none','auto']);
    expect(r.after).toEqual({input:2,measures:1,frames:3,scrolls:1,hits:3,trusted:2});
    expect(r.results).toHaveLength(4);
    expect(r.results[1]).toEqual({ok:true,phase:'pending',pointerEligibility:'none',hitPerformed:false});
    expect(r.results[2]).toEqual({ok:true,phase:'pending',pointerEligibility:'none',hitPerformed:false});
    expect(r.results[3]).toMatchObject({ok:true,phase:'validated',pointerEligibility:'auto',hitPerformed:true});
    expect(r.preflights).toHaveLength(2);
    expect(r.preflights[1]).toMatchObject({initialState:'none',finalState:'auto',noneObserved:true,eligibilityReadsIssued:2,probeReadsIssued:2,finalizationsIssued:3,framesObserved:3,finalHitPerformed:true,outcome:'final_hit_validated',unavailableFields:[]});
    expect(r.preflights[1].snapshotId).toBe(r.receipts[1].snapshotId);
    expect(r.preflights[1].snapshotId).not.toBe(r.preflights[0].snapshotId);
    for(const key of ['tabId','generation','nodeId'] as const)expect(r.preflights[1][key]).toBe(r.preflights[0][key]);
  });

  test('same captured control keeps pre-hit NONE pending and refuses AUTO cover after the genuine native frame', async () => {
    for (const mode of ['cover', 'none']) {
      const r = await control((h, value) => h.postFrameDiagnostic(value), mode);
      console.info('[post-frame-source-native]', JSON.stringify({ mode, ...r }));
      expect(r.positive, mode).toEqual({ input: 2, measures: 1, frames: 1, scrolls: 1, hits: 3, trusted: 1 });
      expect(r.results[0], mode).toMatchObject({ ok: true, postFramePointerEligibility: 'auto', postFrameHitConnected: true, postFrameHitContainsTarget: true });
      expect(r.receipts[0], mode).toMatchObject({ phase: 'post_frame', samplePhase: 'before_first_hit', relationPhase: 'first_hit', state: 'auto', outcome: 'validated' });
      expect(r.sameControl, mode).toBe(true);
      if(mode==='none') {
        expect(r.error).toBe('browser.cancelled');expect(r.after).toEqual({input:0,measures:1,frames:1,scrolls:1,hits:2,trusted:1});
        expect(r.results).toHaveLength(2);expect(r.results[1]).toEqual({ok:true,phase:'pending',pointerEligibility:'none',hitPerformed:false});
        expect(r.preflights[1]).toMatchObject({finalState:'none',finalHitPerformed:false,outcome:'cancelled',framesObserved:1,finalizationsIssued:1});
        expect(r.diagnostic).toBeNull();expect(r.receipts).toHaveLength(1);continue;
      }
      expect(r.error, mode).toBe('browser.click_intercepted');
      expect(r.after, mode).toEqual({ input: 0, measures: 1, frames: 1, scrolls: 1, hits: 3, trusted: 1 });
      expect(r.results, mode).toHaveLength(2);
      expect(r.results[1], mode).toMatchObject({ ok: false, reason: 'intercepted', postFramePointerEligibility: 'auto', postFrameHitConnected: true, postFrameHitContainsTarget: false, pointerFailure: { targetContainsHit: false, hitSameAsCaptured: false } });
      expect(r.receipts, mode).toHaveLength(2);
      expect(r.receipts[1], mode).toMatchObject({ phase: 'post_frame', samplePhase: 'before_first_hit', relationPhase: 'first_hit', state: 'auto', hitConnected: true, hitContainsTarget: false, outcome: 'refused' });
      expect(r.diagnostic, mode).toMatchObject({stage:'pointer_validate',nativeFrameObserved:true,
        eligibility:{phase:'collected_eligibility',firstState:'auto',noneObserved:false,finalState:'auto',outcome:'eligible'},
        postFrame:{phase:'post_frame',samplePhase:'before_first_hit',relationPhase:'first_hit',state:'auto',hitConnected:true,hitContainsTarget:false},
        rejection:{refusalContext:{phase:'pointer_validate',relation:{hitConnected:true,hitContainsTarget:false},targetStyle:{pointerEvents:'auto'}}}});
      expect(r.diagnostic?.snapshotId).toBe(r.receipts[1].snapshotId);
      expect(r.diagnostic?.generation).toBe(r.receipts[1].generation);
      expect(r.diagnostic?.nodeId).toBe(r.receipts[1].nodeId);
      const rect=r.diagnostic?.rejection?.refusalContext?.hitRect;
      expect(rect, mode).toBeTruthy();
      if(!rect)throw Error('refusal geometry unavailable');
      expect(rect.width, mode).toBeGreaterThan(0);expect(rect.height, mode).toBeGreaterThan(0);
    }
  });

  test('a fresh never-shown tab delivers native click/type/key with no stage and the user tab active', async () => {
    const result = await control(h => h.neverShown());
    console.info('[never-shown-native-facts]', JSON.stringify(result));
    expect(result.error, JSON.stringify(result)).toBe(null);
    expect(result.phases).toEqual(['click', 'type', 'key']);
    expect(result.page).toMatchObject({ trustedClicks: 1, trustedKeys: 1, value: 'never shown query' });
    expect(result.before.activeTabId).toBe(result.before.userTabId);
    expect(result.activeTabId).toBe(result.userTabId);
    expect(result.before.visible).toBe(false);
    expect(result.visible).toBe(false);
  });

  test('visible then hidden native click/type/Enter affect the exact page without switching the user tab', async () => {
    await control(async h => { await h.visible(); });
    await control(async h => { await h.act({ kind: 'click', selector: '#open' }); await h.act({ kind: 'type', selector: '#query', text: 'visible query' }); await h.act({ kind: 'key', key: 'Enter' }); });
    const visible = await control(h => h.read());
    expect(visible.page).toMatchObject({ clicks: 1, trustedClicks: 1, keys: 1, trustedKeys: 1, value: 'visible query' });
    expect(visible.native).toBeGreaterThan(0);
    expect(visible.activeTabId).toBe(visible.targetTabId);
    await control(async h => { await h.hidden(); });
    await control(async h => { await h.act({ kind: 'click', selector: '#open' }); await h.act({ kind: 'type', selector: '#query', text: 'hidden query' }); await h.act({ kind: 'key', key: 'Enter' }); });
    const hidden = await control(h => h.read());
    expect(hidden.page).toMatchObject({ clicks: 2, trustedClicks: 2, keys: 2, trustedKeys: 2, value: 'hidden query' });
    expect(hidden.activeTabId).toBe(hidden.userTabId);
    expect(hidden.focused).toBe(true);
  });
  test('each successful native control precedes blocked cover/replacement/cancel/password/semantic/form-owner input', async () => {
    for (const mode of ['cover', 'cover-before', 'replace', 'cancel', 'password', 'semantic', 'form-owner']) {
      const prior = await control(h => h.read());
      await control(async (h, value) => {
        await h.act(value === 'password' ? { kind: 'type', selector: '#query', text: 'safe control' } : { kind: 'click', selector: '#open' });
      }, mode);
      const positive = await control(h => h.read());
      if (mode === 'password') {
        expect(positive.page.input, mode).toBe(prior.page.input + 1);
        expect(positive.page.value, mode).toBe('safe control');
      } else expect(positive.page.trustedClicks, mode).toBe(prior.page.trustedClicks + 1);
      const result = await control((h, value) => h.faults(value), mode);
      expect(result.error, mode).toBe(mode === 'cancel' ? 'browser.cancelled' : mode === 'password' ? 'browser.password_field' : mode.startsWith('cover') ? 'browser.click_intercepted' : mode === 'replace' ? 'browser.stale_index' : 'browser.target_unusable');
      if (mode.startsWith('cover')) {
        expect(result.diagnostic, mode).toMatchObject({ stage: mode === 'cover' ? 'pointer_validate' : 'measure',
          reason: 'intercepted', tabId: result.after.targetTabId, snapshotId: expect.any(String), generation: expect.any(String), nodeId: null,
          nativeFrameObserved: mode === 'cover', point: { x: expect.any(Number), y: expect.any(Number) },
        });
        if (mode === 'cover') {
          expect(result.diagnostic!.rejection).toMatchObject({ point: result.diagnostic!.point,
            targetTag: 'BUTTON', hitTag: 'DIV', targetContainsHit: false, hitSameAsCaptured: false, targetConnected: true,
            rejectGeometry: { targetRect: { width: expect.any(Number), height: expect.any(Number) },
              viewport: { width: 1280, height: expect.any(Number) } },
          });
        } else {
          expect(result.diagnostic!.rejection).toMatchObject({ point: result.diagnostic!.point,
            targetTag: 'BUTTON', hitTag: 'DIV', targetContainsHit: false, hitSameAsCaptured: null, targetConnected: true,
            rejectGeometry: { targetRect: { x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) },
              hitRect: { x: 0, y: 0, width: 1280, height: expect.any(Number) },
              scroll: { x: 0, y: 0 }, viewport: { width: 1280, height: expect.any(Number) } },
          });
        }
      }
      expect(result.after.native, mode).toBe(result.before.native);
      expect(result.after.page, mode).toEqual(result.before.page);
      expect(result.after.activeTabId, mode).toBe(result.after.userTabId);
    }
  });
  test('collected X permission reaches native dispatch unchanged and rejects same-node repurposing before input', async () => {
    for(const mode of ['submit','text','name','form-owner','post-owner','post-identity','at-measure','after-frame']) {
      const result=await control((h,value)=>h.collectedPermission(value),mode);
      console.info('[collected-native-permission]',mode,JSON.stringify(result));
      expect(result.nativeOwnerProven,mode).toBe(true);expect(result.mutationApplied,mode).toBe(true);
      expect(result.positive.input,mode).toBeGreaterThan(0);
      expect(result.positive.trusted,mode).toBe(1);
      expect(result.sameNode,mode).toBe(true);
      expect(result.error,mode).toBe('browser.target_unusable');
      expect(result.after,mode).toEqual(result.positive);
      expect(result.activeTabId,mode).toBe(result.userTabId);
    }
  });

  test('actual focus and selection transfers at the last typing round trip reject before native insertText', async () => {
    for (const mode of ['focus', 'selection']) {
      const prior = await control(h => h.read());
      await control(async h => { await h.act({ kind: 'type', selector: '#query', text: 'selected success' }); });
      const positive = await control(h => h.read());
      expect(positive.inserts).toBe(prior.inserts + 1);
      expect(positive.page.value).toBe('selected success');
      const result = await control((h, value) => h.typingBoundary(value), mode);
      expect(result.error, mode).toBe('browser.target_unusable');
      expect(result.after.inserts, mode).toBe(result.before.inserts);
      expect(result.destination.query, mode).toBe('selected success');
      expect(result.destination.other, mode).toBe('other-original');
      expect(result.destination.active, mode).toBe(mode === 'focus' ? 'other' : 'query');
    }
  });

  test('prompt cancellation keeps the native queue/driving lease through actual release and owned cleanup ACK', async () => {
    const result = await control(h => h.lease());
    expect(result.control).toEqual(['control entered']);
    expect(result.error).toBe('browser.cancelled');
    expect(result.beforeRelease).toEqual(['native press ACK', 'caller cancelled']);
    expect(result.beforeCleanup).toEqual(['native press ACK', 'caller cancelled', 'native release ACK', 'owned cleanup in flight']);
    expect(result.sequence).toEqual(['native press ACK', 'caller cancelled', 'native release ACK', 'owned cleanup in flight', 'owned cleanup ACK', 'next entered']);
    expect(result.after.page.trustedClicks).toBe(result.before.page.trustedClicks + 1);
  });

  test('native Article return and reply controls retain network source evidence and rejection receipts',async()=>{
    const actual=await control(h=>h.readStages('ok'));
    console.info('[native-read-stages]',JSON.stringify(actual));
    expect(actual.result.targets[0]).toMatchObject({root:{postId:'321',sourceKind:'page_graphql',text:'NETWORK_ROOT_094a'},article:{actionAttempted:true,navigationStarted:true,bodyObserved:true,body:{postId:'654',sourceKind:'rendered_ui',text:'Native paragraph rich\n\nNative heading'}}});
    expect(actual.actions).toContain('article');expect(actual.actions).toContain('replies');
    expect(actual.activeTabId).toBe(actual.userTabId);
    const blocked=await control(h=>h.readStages('blocked'));
    expect(blocked.rejectedNode).toBe(true);
    expect(blocked.result.targets[0].article).toMatchObject({actionAttempted:true,navigationStarted:false,bodyObserved:false,barrier:{status:'partial'}});
    expect(blocked.actions).not.toContain('article');
    expect(blocked.activeTabId).toBe(blocked.userTabId);
    const scrolled=await control(h=>h.readStages('scroll'));
    expect(scrolled.actions).toEqual(['scroll-event','scroll-frame']);
    expect(scrolled.result.targets[0].diagnostics?.scroll?.last).toMatchObject({written:true,eventObserved:true,frameObserved:true,state:'frame_observed'});
    expect(scrolled.result.targets[0].replies.observations.map(p=>p.text)).toContain('NETWORK_REPLY_802');
    const stalled=await control(h=>h.readStages('stalled'));
    expect(stalled.result.targets[0].diagnostics?.scroll?.last).toMatchObject({written:true,eventObserved:false,frameObserved:false,state:'no_movement'});
    expect(stalled.result.targets[0].replies.scope).toMatchObject({kind:'network',extent:'unknown'});
  });

  test('source same-document route invalidates the old action binding', async () => {
    const result = await control(h => h.bindings());
    expect(result.after.documentEpoch).toBe(result.before.documentEpoch);
    expect(result.after.routeRevision).toBe(result.before.routeRevision + 1);
    expect(result.error).toBe('browser.stale_snapshot');
  });

  test('native scroll updates the source privacy inventory without reading ordinary DOM text',async()=>{
    const progress=await control(h=>h.readStages('progress'));
    const row=progress.result.targets[0], initial=row.diagnostics!.initialFrame!,terminal=row.diagnostics!.terminalFrame!;
    expect(progress.actions).toEqual(['scroll-event','scroll-frame']);
    expect(initial.replyUiInventory?.capture).toMatchObject({state:'checked',candidateObserved:4,eligibleObserved:4,returned:4,omittedHidden:0,nodes:[{text:'Native heading'},{text:'Private sentinel'},{text:'状态信息'},{text:'End of conversation'}]});
    expect(terminal.replyUiInventory?.capture).toMatchObject({state:'checked',candidateObserved:4,eligibleObserved:3,returned:2,omittedHidden:1,omittedByPrivacy:3,nodes:[{text:'状态信息'},{text:'End of conversation'}]});
    expect(row.replies.observations.map(p=>p.text)).toEqual(['NETWORK_REPLY_802']);
    expect(row.diagnostics?.scroll?.last).toMatchObject({written:true,eventObserved:true,frameObserved:true});
    expect(row.replies.scope).toMatchObject({kind:'network',extent:'unknown'});
    const zero=await control(h=>h.readStages('progress-zero'));
    expect(zero.actions).toEqual([]);expect(zero.result.targets[0].replies.observations).toEqual([]);
    expect(zero.activeTabId).toBe(zero.userTabId);
  });
});
