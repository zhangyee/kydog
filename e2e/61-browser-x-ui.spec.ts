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
  directIdentity():Promise<{positive:DirectIdentityReceipt;negative:DirectIdentityReceipt}>;
  postFrameDiagnostic(mode:string):Promise<{positive:EligibilityCounters&{frames:number};after:EligibilityCounters&{frames:number};results:unknown[];receipts:unknown[];error:string|null;sameControl:boolean}>;
  pointerEligibility(mode:string):Promise<{positive:EligibilityCounters;beforeWriter:EligibilityCounters;after:EligibilityCounters;observations:string[];sameBinding:boolean;error:string|null}>;
  read(): Promise<State>;
  sourceContainers(): Promise<{ posts: import('../src/main/x/xResearchTypes').XTextObservation[]; entryParents: {author:string|undefined;parentText:string|undefined}[] }>;
  longBodyNoControl():Promise<{domBody:string;detailRoot:import('../src/main/x/xResearchTypes').XTextObservation|null;detailQuote:import('../src/main/x/xResearchTypes').XTextObservation|null;detailReply:import('../src/main/x/xResearchTypes').XTextObservation|null;detailControls:string[];searchPost:import('../src/main/x/xResearchTypes').XTextObservation|null;buttonControls:string[];buttonExpandActions:number;buttonRootText:string|undefined;result:Extract<import('../src/main/x/xResearchTypes').XResearchResult,{operation:'read'}>;activeTabId:string;userTabId:string}>;
  readStages(mode:string):Promise<{result:Extract<import('../src/main/x/xResearchTypes').XResearchResult,{operation:'read'}>;actions:string[];currentPosts:string[];rejectedNode:boolean;readinessFrames:string[];activeTabId:string;userTabId:string}>;
  collectedPermission(mode:string):Promise<{positive:{input:number;trusted:number};after:{input:number;trusted:number};error:string|null;sameNode:boolean;identity:boolean;activeTabId:string;userTabId:string}>;
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
    await build({ configFile: false, root: path.resolve(__dirname, '..'), logLevel: 'warn', build: {
      outDir: path.join(dir, 'bundle'), emptyOutDir: true, target: 'node22',
      lib: { entry: path.resolve(__dirname, 'fixtures/61-browser/xUiHarness.ts'), formats: ['cjs'], fileName: () => 'harness.cjs' },
      rollupOptions: { external: id => id === 'electron' || id.startsWith('node:') },
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
    if (dir && !failed) await fs.rm(dir, {recursive:true,force:true});
    else if (dir) console.info('[retained-native-failure-directory]',dir);
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

  test('same captured control retains pre-hit NONE/ancestor and AUTO/cover after the genuine native frame without input or replay', async () => {
    for (const mode of ['none', 'cover']) {
      const r = await control((h, value) => h.postFrameDiagnostic(value), mode);
      console.info('[post-frame-source-native]', JSON.stringify({ mode, ...r }));
      expect(r.positive, mode).toEqual({ input: 2, measures: 1, frames: 1, scrolls: 1, hits: 3, trusted: 1 });
      expect(r.results[0], mode).toMatchObject({ ok: true, postFramePointerEligibility: 'auto', postFrameHitConnected: true, postFrameHitContainsTarget: true });
      expect(r.receipts[0], mode).toMatchObject({ phase: 'post_frame', samplePhase: 'before_first_hit', relationPhase: 'first_hit', state: 'auto', outcome: 'validated' });
      expect(r.sameControl, mode).toBe(true);
      expect(r.error, mode).toBe('browser.click_intercepted');
      expect(r.after, mode).toEqual({ input: 0, measures: 1, frames: 1, scrolls: 1, hits: 3, trusted: 1 });
      expect(r.results, mode).toHaveLength(2);
      expect(r.results[1], mode).toMatchObject({ ok: false, reason: 'intercepted', postFramePointerEligibility: mode === 'none' ? 'none' : 'auto', postFrameHitConnected: true, postFrameHitContainsTarget: mode === 'none', pointerFailure: { targetContainsHit: false, hitSameAsCaptured: false } });
      expect(r.receipts, mode).toHaveLength(2);
      expect(r.receipts[1], mode).toMatchObject({ phase: 'post_frame', samplePhase: 'before_first_hit', relationPhase: 'first_hit', state: mode === 'none' ? 'none' : 'auto', hitConnected: true, hitContainsTarget: mode === 'none', outcome: 'refused' });
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
      expect(result.identity,mode).toBe(true);
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

  test('native detail retains a long rendered body without a control while other scopes stay bounded',async()=>{
    const r=await control(h=>h.longBodyNoControl());
    const root=r.result.targets[0].root!;
    expect(r.domBody.length).toBe(7009);
    expect(r.domBody.endsWith('Z')).toBe(true);
    expect(r.detailRoot).toMatchObject({postId:'321',sourceUrl:'https://x.com/longbody/status/321',author:{handle:'longbody'},text:r.domBody,truncation:{returned:7009,totalKnown:7009,truncated:false}});
    expect(root).toMatchObject({postId:'321',sourceUrl:'https://x.com/longbody/status/321',author:{handle:'longbody'},text:r.domBody,truncation:{returned:7009,totalKnown:7009,truncated:false},observationId:expect.any(String)});
    for(const [side,totalKnown] of [[r.detailQuote,5000],[r.detailReply,5000],[r.searchPost,7009]] as const) {
      expect(side?.text.length).toBe(4000);
      expect(side?.truncation).toEqual({returned:4000,totalKnown,truncated:true});
    }
    expect(r.buttonControls).toContain('body_expand');
    expect(r.buttonExpandActions).toBe(1);
    expect(r.buttonRootText).toBe('Native expanded body');
    expect(r.detailControls).not.toContain('body_expand');
    expect(root.text.endsWith('Z')).toBe(true);
    expect(r.result.targets[0].budgetUsage.expandActions).toBe(0);
    expect(r.activeTabId).toBe(r.userTabId);
  });

  test('native Article, fresh parent return and bounded replies retain independent source evidence',async()=>{
    const containers=await control(h=>h.sourceContainers());
    expect(containers.posts.slice(0,2).map(p=>p.text)).toEqual(['PLAIN_EXACT_CONTAINER','PREVIEW_EXACT_CONTAINER']);
    expect(containers.posts[1].articlePreviewInventory).toEqual({scope:'collection',observed:1,retained:0,omitted:1,unresolved:0});
    expect(containers.posts[0].articlePreviewInventory).toEqual({scope:'collection',observed:0,retained:0,omitted:0,unresolved:0});
    expect(containers.entryParents).toEqual([{author:'writer',parentText:'PREVIEW_EXACT_CONTAINER'}]);
    const actual=await control(h=>h.readStages('ok'));
    console.info('[native-read-stages]',JSON.stringify(actual));
    expect(actual.result.targets[0]).toMatchObject({root:{postId:'321',text:'Native expanded body'},article:{actionAttempted:true,navigationStarted:true,bodyObserved:true,body:{postId:'654',author:{handle:'writer'},sourceUrl:'https://x.com/writer/status/654',text:'Native paragraph rich\n\nNative heading'}},replies:{observations:[{postId:'801',directParent:null},{postId:'802',directParent:null}],scope:{completeness:'unknown',stopReason:'identity_unproven'}},budgetUsage:{expandActions:3,scrolls:0}});
    expect(actual.actions).toEqual(['body','article','replies']);
    expect(actual.currentPosts).toEqual(['/third/status/803']);
    expect(actual.activeTabId).toBe(actual.userTabId);
    const delayed=await control(h=>h.readStages('delayed'));
    expect(delayed.readinessFrames).toEqual(['return-empty','discussion-empty','discussion-ready']);
    expect(delayed.result.targets[0]).toMatchObject({root:{postId:'321',text:'Native expanded body'},article:{bodyObserved:true,body:{postId:'654'}},replies:{observations:[{postId:'801'},{postId:'802'}]},budgetUsage:{expandActions:3,scrolls:0}});
    expect(delayed.actions).toEqual(['body','article','replies']);
    expect(delayed.currentPosts).toEqual(['/third/status/803']);
    expect(delayed.activeTabId).toBe(delayed.userTabId);
    const scrolled=await control(h=>h.readStages('scroll'));
    console.info('[native-scroll-render]',JSON.stringify(scrolled));
    expect(scrolled.actions).toEqual(['scroll-event','scroll-frame']);
    expect(scrolled.result.targets[0]).toMatchObject({root:{postId:'321',text:'Native preview'},replies:{observations:[{postId:'801'},{postId:'804',text:'Reply rendered after actual scroll'}],scope:{completeness:'unknown'}},budgetUsage:{scrolls:1,expandActions:0}});
    expect(scrolled.currentPosts).toEqual(['/scroller/status/321','/fourth/status/804']);
    expect(scrolled.activeTabId).toBe(scrolled.userTabId);
    const blocked=await control(h=>h.readStages('blocked'));
    expect(blocked.rejectedNode).toBe(true);
    expect(blocked.result.targets[0]).toMatchObject({root:{text:'Native expanded body'},article:{actionAttempted:true,navigationStarted:false,bodyObserved:false,barrier:{status:'partial'}},budgetUsage:{expandActions:2}});
    expect(blocked.actions).toEqual(['body','replies']);
    expect(blocked.activeTabId).toBe(blocked.userTabId);
  });

  test('source same-document route invalidates the old action binding', async () => {
    const result = await control(h => h.bindings());
    expect(result.after.documentEpoch).toBe(result.before.documentEpoch);
    expect(result.after.routeRevision).toBe(result.before.routeRevision + 1);
    expect(result.error).toBe('browser.stale_snapshot');
  });
});
