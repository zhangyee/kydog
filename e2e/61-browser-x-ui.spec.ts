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
  readStages(mode:string):Promise<{result:Extract<import('../src/main/x/xResearchTypes').XResearchResult,{operation:'read'}>;actions:string[];currentPosts:string[];rejectedNode:boolean;readinessFrames:string[];sourceCleanup:{populated:boolean;cleared:boolean};sourceGeometry:{before:number;after:number;height:number}|null;sourceActions:string[];citationChecks:Record<string,string>;activeTabId:string;userTabId:string}>;
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
// The root-only progress case runs last: its two fresh research tabs can evict the
// original target under the real tab budget; earlier binding tests still need that target.
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

  test('real root removal preserves own current bodies and preview gaps while stopping target discussion',async()=>{
    const receipt=await control(h=>h.readStages('source-state'));
    console.info('[original-source-root-native]',JSON.stringify(receipt));
    const row=receipt.result.targets[0],first=row.diagnostics?.firstAdmittedFrame,terminal=row.diagnostics?.terminalFrame;
    expect(row.diagnostics?.initialFrame).toMatchObject({inventory:{returned:0},rootIdentityProven:false});
    expect(first).toMatchObject({rootIdentityProven:true,sourceRootState:{anchorSnapshotId:first?.snapshotId,availability:'captured',
      conversation:{candidates:'unique',sameObject:true,connected:true,sameDocument:true,containsRoot:true},
      root:{connection:'connected',sameDocument:true,topLevel:true,ownBoundary:true,inRoots:true,inRawPosts:true,shown:'pass'},
      identity:{members:'same',coordinates:'same',owned:true,rendered:'same'}}});
    expect(terminal).toMatchObject({rootIdentityProven:false,sourceRootState:{anchorSnapshotId:first?.snapshotId,availability:'captured',
      conversation:{candidates:'unique',sameObject:true,connected:true,sameDocument:true,containsRoot:false},
      root:{connection:'detached',sameDocument:true,topLevel:true,ownBoundary:true,inRoots:false,inRawPosts:false,shown:'dimensions'},
      identity:{members:'same',coordinates:'same',owned:true,rendered:'missing'}}});
    expect(terminal?.document).toEqual(first?.document);
    expect(row).toMatchObject({status:'partial',reason:'post_identity_unproven',stopReason:'identity_unproven',root:{text:'Native preview',postId:'321'},replies:{observations:[{postId:'801'}]},budgetUsage:{scrolls:1,expandActions:0}});
    expect(row.diagnostics?.scroll?.last).toMatchObject({state:'frame_observed',written:true,eventObserved:true,frameObserved:true});
    expect(receipt.sourceGeometry?.height).toBeGreaterThan(0);
    expect(receipt.sourceGeometry?.before).toBe(row.diagnostics?.scroll?.last?.after);
    expect(receipt.sourceGeometry?.after).toBe(receipt.sourceGeometry?.before);
    expect(receipt.actions).toEqual(['scroll-event','scroll-frame']);
    expect(receipt.sourceActions).toEqual(['dispatch:scroll','collection:rootless']);
    expect(row.unscopedPosts?.observations.map(p=>[p.postId,p.relationToTarget,p.observedContainer])).toEqual([['805','unproven','post'],['808','unproven','post'],['801','unproven','post']]);
    expect(row.unscopedPosts?.inventory).toEqual({scope:'collection',observed:3,retained:3,omitted:0,sourceInventoryTruncated:false,excludedNestedQuotes:1});
    expect(row.unscopedPosts?.previewGaps).toEqual([{sourceUrl:'https://x.com/preview/status/808',unresolved:1}]);
    expect(row.unscopedPosts?.collection.snapshotId).toBe(terminal?.snapshotId);
    expect(row.unscopedPosts?.observations.find(p=>p.postId==='801')?.observationId).not.toBe(row.replies.observations[0].observationId);
    expect(row.budgetUsage.distinctEntries).toBe(4);
    expect(receipt.citationChecks.root).toBe('allowed');expect(receipt.citationChecks.own).toBe('allowed');
    expect(receipt.citationChecks.preview).toContain('inventory is unknown');
    expect(receipt.citationChecks.quote).toContain('unobserved');expect(receipt.citationChecks.bad).toContain('unobserved');
    expect(receipt.readinessFrames).toEqual(['initial-empty']);
    expect(receipt.sourceCleanup).toEqual({populated:true,cleared:true});
    expect(receipt.activeTabId).toBe(receipt.userTabId);
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
    const positiveScroll=scrolled.result.targets[0].diagnostics?.scroll;
    expect(positiveScroll).toMatchObject({totalAttempts:1,omittedAttempts:0,first:{actionIndex:1,snapshotId:expect.any(String),targetKind:'document',targetNodeId:expect.any(Number),targetContainsHit:true,conversationRelation:'unknown',rootRelation:'unknown',written:true,eventObserved:true,frameObserved:true,state:'frame_observed'},last:{state:'frame_observed'}});
    expect(positiveScroll!.last).toEqual(positiveScroll!.first);
    expect(positiveScroll!.first!.generation).toBe(scrolled.result.targets[0].diagnostics?.initialFrame?.document.generation);
    expect(positiveScroll!.first!.location).toEqual(scrolled.result.targets[0].diagnostics?.initialFrame?.location);
    expect(positiveScroll!.first!.snapshotId).toBe(scrolled.result.targets[0].diagnostics?.initialFrame?.snapshotId);
    expect(scrolled.result.targets[0].diagnostics?.terminalFrame?.snapshotId).not.toBe(scrolled.result.targets[0].diagnostics?.initialFrame?.snapshotId);
    expect(scrolled.result.targets[0].diagnostics?.terminalFrame?.document).toEqual(scrolled.result.targets[0].diagnostics?.initialFrame?.document);
    expect(positiveScroll!.first!.after).toBeGreaterThan(positiveScroll!.first!.before);
    expect(positiveScroll!.first!.scrollHeight).toBeGreaterThan(positiveScroll!.first!.clientHeight);
    // The terminal frame contains one visible reply; the result retains both distinct observations.
    expect(scrolled.result.targets[0].diagnostics?.terminalFrame).toMatchObject({rootIdentityProven:true,replyCount:1,explicitEndObserved:false});
    expect(scrolled.currentPosts).toEqual(['/scroller/status/321','/fourth/status/804']);
    expect(scrolled.activeTabId).toBe(scrolled.userTabId);
    const stalled=await control(h=>h.readStages('stalled'));
    console.info('[native-scroll-no-movement]',JSON.stringify(stalled));
    const stopped=stalled.result.targets[0],negativeScroll=stopped.diagnostics?.scroll;
    expect(stopped).toMatchObject({status:'partial',reason:'scroll_no_movement',stopReason:'action_failed',root:{postId:'321',text:'Native preview'},replies:{observations:[{postId:'801',text:'First reply'}],scope:{completeness:'unknown',stopReason:'action_failed'}},budgetUsage:{scrolls:1,expandActions:0}});
    expect(negativeScroll).toMatchObject({totalAttempts:1,omittedAttempts:0,first:{actionIndex:1,snapshotId:expect.any(String),targetKind:'document',targetNodeId:expect.any(Number),targetContainsHit:true,conversationRelation:'unknown',rootRelation:'unknown',written:true,eventObserved:false,frameObserved:false,state:'no_movement'},last:{state:'no_movement'}});
    expect(negativeScroll!.last).toEqual(negativeScroll!.first);
    expect(negativeScroll!.first!.generation).toBe(stopped.diagnostics?.initialFrame?.document.generation);
    expect(negativeScroll!.first!.location).toEqual(stopped.diagnostics?.initialFrame?.location);
    expect(negativeScroll!.first!.snapshotId).toBe(stopped.diagnostics?.initialFrame?.snapshotId);
    expect(stopped.diagnostics?.terminalFrame?.snapshotId).toBe(stopped.diagnostics?.initialFrame?.snapshotId);
    expect(negativeScroll!.first!.after).toBe(negativeScroll!.first!.before);
    expect(negativeScroll!.first!.scrollHeight).toBeLessThanOrEqual(negativeScroll!.first!.clientHeight);
    expect(stopped.diagnostics?.terminalFrame).toMatchObject({rootIdentityProven:true,replyCount:1,explicitEndObserved:false});
    expect(stalled.actions).toEqual([]);
    expect(stalled.activeTabId).toBe(stalled.userTabId);
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

  test('root-only discussion advances once before readiness using a trusted native scroll frame',async()=>{
    const progress=await control(h=>h.readStages('progress'));
    console.info('[native-readiness-progress]',JSON.stringify(progress));
    const row=progress.result.targets[0],initial=row.diagnostics!.initialFrame!,terminal=row.diagnostics!.terminalFrame!,scroll=row.diagnostics!.scroll!;
    expect(initial).toMatchObject({rootIdentityProven:true,replyCount:0,repliesExpandControlCount:0,explicitEndObserved:false,sourceRootState:{root:{connection:'connected'},identity:{coordinates:'same'}}});
    const initialUi=initial.replyUiInventory?.capture,terminalUi=terminal.replyUiInventory?.capture;
    expect(initialUi).toMatchObject({state:'checked',candidateObserved:4,eligibleObserved:4,returned:4,omittedHidden:0,
      nodes:[{text:'Native heading'},{text:'Private sentinel'},{text:'状态信息'},{text:'End of conversation'}]});
    // Same actual source candidates become hidden / structurally unsafe in the
    // trusted native frame. The end-like label itself remains literal only.
    expect(terminalUi).toMatchObject({state:'checked',candidateObserved:4,eligibleObserved:3,returned:2,omittedHidden:1,
      omittedByPrivacy:3,omittedUnsafeSubtree:{excludedDescendant:1,subtreeNotFullyInspected:0,metadataLimit:0},
      nodes:[{text:'状态信息'},{text:'End of conversation'}]});
    expect(initial.sourceEndDetector).toBe('not_implemented');expect(terminal.sourceEndDetector).toBe('not_implemented');
    expect(row.replies.scope).toMatchObject({completeness:'unknown',endEvidence:null});
    if(initialUi?.state!=='checked'||terminalUi?.state!=='checked')throw new Error('source UI inventory missing');
    expect(initialUi.regionNodeId).toBe(initial.regionNodeId);expect(terminalUi.regionNodeId).toBe(terminal.regionNodeId);
    expect(terminal.document).toEqual(initial.document);
    expect(progress.sourceActions).toEqual(['dispatch:scroll']);
    expect(progress.actions).toEqual(['scroll-event','scroll-frame']);
    expect(row).toMatchObject({root:{postId:'321',text:'Native preview'},replies:{observations:[{postId:'809',author:{handle:'arrived'},sourceUrl:'https://x.com/arrived/status/809',text:'Own reply created by trusted scroll frame'}],scope:{completeness:'unknown'}},budgetUsage:{scrolls:1,expandActions:0},stopReason:'budget_reached'});
    expect(scroll).toMatchObject({totalAttempts:1,first:{snapshotId:initial.snapshotId,written:true,eventObserved:true,frameObserved:true,state:'frame_observed'}});
    expect(scroll.first!.after).toBeGreaterThan(scroll.first!.before);
    expect(progress.sourceGeometry!.height).toBeGreaterThan(0);
    expect(progress.sourceGeometry!.before).toBe(scroll.first!.after);
    expect(progress.sourceGeometry!.after).toBe(progress.sourceGeometry!.before);
    expect(scroll.last).toEqual(scroll.first);
    expect(terminal).toMatchObject({rootIdentityProven:true,rootNodeId:initial.rootNodeId,replyCount:1,explicitEndObserved:false});
    expect(terminal.snapshotId).not.toBe(initial.snapshotId);
    expect(row.diagnostics?.readiness).toMatchObject({collectCount:1,initial:{replyCount:1,expandControlCount:0,explicitEndObserved:false},timedOut:false});
    expect(progress.currentPosts).toEqual(['/progress/status/321','/arrived/status/809']);
    expect(progress.activeTabId).toBe(progress.userTabId);
    // The same independently named source only exists after a native event/frame;
    // zero budget supplies the counterfactual, with no collection-wrapper injection.
    const zero=await control(h=>h.readStages('progress-zero'));
    console.info('[native-readiness-zero]',JSON.stringify(zero));
    expect(zero.sourceActions).toEqual([]);expect(zero.actions).toEqual([]);
    expect(zero.currentPosts).toEqual(['/progress/status/321']);
    expect(zero.result.targets[0]).toMatchObject({root:{postId:'321'},reason:'reply_readiness_timeout',stopReason:'wait_timeout',replies:{observations:[],scope:{completeness:'unknown'}},budgetUsage:{scrolls:0,expandActions:0},diagnostics:{initialFrame:{rootIdentityProven:true,replyCount:0},terminalFrame:{rootIdentityProven:true,replyCount:0},readiness:{timedOut:true}}});
    expect(zero.activeTabId).toBe(zero.userTabId);
  });
});
