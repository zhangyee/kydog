import { XNetworkSearchLease, retainXNetworkCleanupFailure } from './xNetworkLease';
import { isPointerPreflight, type PointerPreflightDiagnostic } from '../browser/pointerPreflightDiagnostic';
import { randomUUID } from 'node:crypto';
import {createSourceEvaluation,logSourceDiagnostic} from '../browser/sourceEvaluationDiagnostic';
import {logSourceCollectionFailure,sourceFailureReceipt,retainSourceFailureReceipt,type XSourceFailure} from './xSourceDiagnostics';
import { bindXSourceRoot, xSourceRootReleaseExpression, type XSourceRootEnvelope } from './xDomSource';
import { KydogError } from '../../shared/errors';
import type { NavigationObservation } from '../../shared/types';
import type { BrowserService, BrowserLocationFacts, EvictedTab } from '../browser/browserService';
import type { BrowserScrollReceipt, DispatchAction, WaitUntil } from '../browser/actions';
import type { AxSnapshot } from '../browser/snapshot';
import { decodeXPage, xPageExpression, type XPageNavigationProof } from './xDomSource';
import type { XPageRequest, XPageObservation } from './xObservation';
import type { XArticleEntry, XControlBinding, XReplyAdmission } from './xResearchTypes';

/** All values remain inside trusted main-process adapters. Redact at serialization. */
export interface XOpenResult { tabId: string; nav: NavigationObservation; evicted: EvictedTab[]; networkLeaseId?:string; networkCleanupFailure?:'network_cleanup_failed' }
export interface XActionResult { action: DispatchAction; line: string; navigation: NavigationObservation | null }
export interface XActionOptions { onPointerPreflight?:(receipt:Readonly<PointerPreflightDiagnostic>)=>void; onReplyAdmission?: (receipt:XReplyAdmission)=>void; scrollAcknowledgement?: { onWritten: () => void; onReceipt?: (receipt: BrowserScrollReceipt) => void;
  relationNodes?: {conversationNodeId:number|null;rootNodeId:number|null} } }
export interface XQueuedPage {
  snapshot(): Promise<AxSnapshot>;
  /** Fixed program-owned extractor with validated DOM observations. */
  collect(request: XPageRequest): Promise<XPageObservation>;
  act(action: DispatchAction, snapshot: AxSnapshot, options?: XActionOptions): Promise<XActionResult>;
  wait(until: WaitUntil, timeoutMs: number): Promise<boolean>;
  location(): BrowserLocationFacts;
}
export interface XResearchBrowser {
  tabStatus?(tabId: string): 'available' | 'foreign' | 'missing';
  open(url: string, tabId: string | undefined, signal?: AbortSignal, request?: XPageRequest): Promise<XOpenResult>;
  withPage<T>(tabId: string, signal: AbortSignal | undefined, work: (page: XQueuedPage) => Promise<T>): Promise<T>;
}

export function createXResearchBrowser(browser: BrowserService, threadId: string): XResearchBrowser {
  const networkLeases=new Map<string,XNetworkSearchLease>();
  const sameLocation = (a: BrowserLocationFacts, b: BrowserLocationFacts) => a.documentEpoch===b.documentEpoch && a.routeRevision===b.routeRevision && a.navigationSequence===b.navigationSequence && a.currentUrl===b.currentUrl;
  const entries = new WeakMap<XArticleEntry, {tabId:string; snapshot:AxSnapshot}>();
  const actions = new WeakMap<XActionResult, {tabId:string; entry:XArticleEntry; location:BrowserLocationFacts; finalUrl:string|null}>();
  const opens = new WeakMap<XOpenResult, {tabId:string; requestedUrl:string; location:BrowserLocationFacts; finalUrl:string|null}>();
  const finalUrl = (nav: NavigationObservation|null) => nav && (nav.outcome.kind==='ok' || nav.outcome.kind==='ok_same_document') ? nav.outcome.finalUrl : null;
  return {
    tabStatus: tabId => browser.researchTabStatus(tabId, threadId),
    // BrowserService.open owns its one queue entry. Never enqueue around it.
    open: async (url, tabId, signal, request) => {
      if(tabId && browser.researchTabStatus(tabId, threadId)==='foreign')
        throw new KydogError('browser.bad_action','X research tab belongs to another thread');
      if(tabId){const previous=networkLeases.get(tabId);networkLeases.delete(tabId);if(await previous?.close()){const error=new KydogError('x.invalid_page','source_unavailable:network_cleanup_failed');retainXNetworkCleanupFailure(error);throw error;}}
      if(request)xPageExpression(request);
      const network=request?.stage==='search'?new XNetworkSearchLease({id:randomUUID(),purpose:'collection',query:request.query,product:request.product},url):undefined;
      const opened = await browser.open({ url, tabId, ownerThreadId: threadId, activate: false, signal,...(network?{network:{ownerId:network.id,accepts:network.accepts}}:{}) });
      const result:XOpenResult={tabId:opened.tabId,nav:opened.nav,evicted:opened.evicted};
      if(network&&opened.networkLease){network.bind(opened.networkLease);networkLeases.set(result.tabId,network);result.networkLeaseId=network.id;}
      if(network&&(!finalUrl(result.nav)||!opened.networkLease)){if(await network.close())result.networkCleanupFailure='network_cleanup_failed';networkLeases.delete(result.tabId);}

      const destination = finalUrl(result.nav);
      if (destination) {
        try {
          opens.set(result,{tabId:result.tabId,requestedUrl:url,location:browser.locationFacts(result.tabId),finalUrl:destination});
        } catch (error) {
          // Losing an optional Article proof must not erase a real navigation outcome.
          if (!(error instanceof KydogError) || error.code!=='browser.no_tab') throw error;
        }
      }
      return result;
    },
    withPage: async <T>(tabId:string, signal:AbortSignal|undefined, work:(page:XQueuedPage)=>Promise<T>) => {
      const network=networkLeases.get(tabId);networkLeases.delete(tabId);
      const lifetime = new AbortController();
      let failure: KydogError | undefined;
      let realmGone=false;
      let rejectStopped!: (error: KydogError) => void;
      const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
      const stop = (error: KydogError) => {
        if (failure) return;
        failure = error; lifetime.abort(); rejectStopped(error);
      };
      const abort = () => stop(new KydogError('browser.cancelled', '浏览器操作已取消'));
      const gone = (id: string) => { if (id === tabId) { realmGone=true;stop(new KydogError('browser.not_dispatchable', '目标标签已销毁或渲染进程已退出')); } };
      const offGone = browser.onTabDestroyed(gone), offUnavailable = browser.onTabUnavailable(gone);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const check = () => { if (failure) throw failure; if (lifetime.signal.aborted) throw new KydogError('browser.cancelled', '这次浏览器操作已结束'); };
      const issued = new Set<Promise<unknown>>();
      const pendingScrolls = new Set<Promise<unknown>>();
      const run = async <T>(fn: () => Promise<T>, drainScroll = false): Promise<T> => {
        check();
        const operation = fn(); issued.add(operation);
        if (drainScroll) { pendingScrolls.add(operation); void operation.then(()=>pendingScrolls.delete(operation),()=>pendingScrolls.delete(operation)); }
        void operation.then(() => issued.delete(operation), () => issued.delete(operation));
        const value = await Promise.race([operation, stopped]); check(); return value;
      };
      const sourceLease=randomUUID();
      const ownerId=randomUUID();
      let sourceUsed=false;
      let sourceBinding:string|null=null, sourceCollection:string|null=null, sourceReset=true;
      let sourceCommit:XSourceRootEnvelope['commit'];
      const invalidateSource=()=>{sourceBinding=null;sourceCollection=null;sourceCommit=undefined;sourceReset=true;};
      const releaseSource=async(workFailed:boolean)=>{
        if(!sourceUsed)return;
        const operation=createSourceEvaluation(ownerId,tabId,'x_source_release');
        const report=(error:unknown,cause:XSourceFailure['cause'])=>{
          try{const receipt=sourceFailureReceipt(error,operation,'release',cause);
            logSourceDiagnostic('source_root_cleanup_failed',{...receipt,workFailed,sourceUsed,failureCategory:cause==='wrapper_failure'?'evaluation_rejected':cause},'error');
          }catch{/* Preserve work and cleanup outcomes even if diagnostics fail. */}
        };
        if(realmGone){report(undefined,'observed_realm_unavailable');return;}
        let cause:XSourceFailure['cause']='wrapper_failure';
        try {
          const released=await browser.evalInPage(tabId,xSourceRootReleaseExpression(sourceLease),operation);
          if(!released || typeof released!=='object' || (released as {released?:unknown}).released!==true){cause='invalid_release_receipt';throw new Error('release');}
        } catch(error) {
          if(error instanceof KydogError && (error.code==='browser.no_tab' || error.code==='browser.not_dispatchable')) realmGone=true;
          report(error,realmGone?'observed_realm_unavailable':cause);
          if(!realmGone&&!workFailed){
            const failure=new KydogError('x.invalid_page','Source root diagnostic cleanup failed');
            // Keep the actual release failure receipt on the existing outward error route.
            try{const receipt=sourceFailureReceipt(error,operation,'release',cause);retainSourceFailureReceipt(failure,receipt);}catch{/* Optional telemetry. */}
            throw failure;
          }
        }
      };
      const bindings = new Map<AxSnapshot, BrowserLocationFacts>();
      const permissions = new Map<AxSnapshot, Map<number, {permission:{owner:string;token:string;purpose:string};binding:XControlBinding}>>();
      const currentEntries = new Map<AxSnapshot, XArticleEntry[]>();
      const page: XQueuedPage = {
        snapshot: () => run(async () => {
          const before = browser.locationFacts(tabId);
          const snapshot = await browser.snapshot(tabId, lifetime.signal);
          check();
          const after = browser.locationFacts(tabId);
          if (before.documentEpoch !== after.documentEpoch || before.routeRevision !== after.routeRevision || before.navigationSequence !== after.navigationSequence || before.currentUrl !== after.currentUrl)
            throw new KydogError('browser.stale_snapshot', '采集期间页面已导航；需要新快照');
          bindings.set(snapshot, after); return snapshot;
        }),
        collect: request => run(async () => {
          // Validate public request before constructing the private fixed envelope.
          xPageExpression(request);
          const before = browser.locationFacts(tabId);
          const binding=request.stage==='post'?JSON.stringify([request.expectedUrl,request.postId,before.currentUrl,before.documentEpoch,before.routeRevision,before.navigationSequence]):'';
          if(binding!==sourceBinding) invalidateSource();
          sourceBinding=binding;sourceCollection=randomUUID();
          const envelope:XSourceRootEnvelope={lease:sourceLease,collectionKey:sourceCollection,binding,reset:sourceReset,...(sourceCommit?{commit:sourceCommit}:{})};
          const expression=xPageExpression(request,envelope);
          sourceReset=false;
          const operation=createSourceEvaluation(ownerId,tabId,'x_collect');
          let phase:XSourceFailure['phase']='prepare';
          try {
          await browser.prepareForDomRead(tabId,lifetime.signal); check();
          if(request.stage==='post') sourceUsed=true;
          phase='evaluate';
          const raw = await browser.evalInPage(tabId,expression,operation); check();
          phase='decode';
          const after = browser.locationFacts(tabId);
          if (!sameLocation(before,after)) throw new KydogError('browser.stale_snapshot','采集期间页面已导航；需要新观察');
          const navigationProof: XPageNavigationProof = {parentArticle:false};
          if (request.stage==='article') {
            const issuedEntry=entries.get(request.entry);
            const proof=request.via.kind==='action' ? actions.get(request.via.result) : opens.get(request.via.result);
            navigationProof.parentArticle=!!issuedEntry && issuedEntry.tabId===tabId && !!proof && proof.tabId===tabId
              && sameLocation(proof.location,after) && proof.finalUrl===request.expectedUrl
              && ('entry' in proof ? proof.entry===request.entry : request.entry.targetUrl!==null && proof.requestedUrl===request.entry.targetUrl);
          }
          if (request.stage==='post' && request.directOpen) {
            const proof=opens.get(request.directOpen);
            if (proof && proof.tabId===tabId && proof.requestedUrl===request.expectedUrl && proof.finalUrl===request.expectedUrl
              && after.currentUrl===request.expectedUrl)
              navigationProof.directOpen={openedLocation:proof.location,sameGeneration:sameLocation(proof.location,after)};
          }
          const observation=decodeXPage(raw,request,after,navigationProof);
          if(request.stage==='search'&&observation.state?.kind!=='auth_required'){
            if(!network||network.expectedUrl!==request.expectedUrl||network.query.query!==request.query||network.query.product!==request.product)throw new KydogError('x.invalid_page','source_unavailable:lease_missing');
            const captured=await network.collect(after,lifetime.signal,()=>{check();return browser.locationFacts(tabId);});check();
            const invalidated=!sameLocation(after,browser.locationFacts(tabId));
            if(invalidated){captured.failure='generation_changed';captured.pending=false;}
            if(captured.failure){
              if(captured.proof)observation.network={...captured,proof:captured.proof};
              observation.identityProven=false;invalidateSource();bindings.clear();permissions.clear();currentEntries.clear();
              return observation;
            }
            if(captured.proof)observation.network={pages:captured.pages,proof:captured.proof,facts:captured.facts,pending:captured.pending,...(captured.failure?{failure:captured.failure}:{})};
            observation.identityProven=!!captured.proof;
          }
          if(sourceCommit && sourceCommit.generation!==observation.snapshot.generation) sourceCommit=undefined;
          if(observation.diagnosticFrame?.rawUrlMatchesPort===false) invalidateSource();
          else bindXSourceRoot(observation,raw,envelope,commit=>{
            if(failure || lifetime.signal.aborted || sourceBinding!==binding || sourceCollection!==envelope.collectionKey || sourceCommit
              || !sameLocation(after,browser.locationFacts(tabId))) return false;
            sourceCommit=commit;return true;
          });
          bindings.set(observation.snapshot,after);
          permissions.set(observation.snapshot,new Map(observation.snapshot.nodes.flatMap(n=>n.collectedPermission?[[n.index,{permission:{...n.collectedPermission},binding:{index:n.index,nodeId:n.nodeId,snapshotId:observation.snapshot.snapshotId,generation:observation.snapshot.generation}}]]:[])));
          currentEntries.set(observation.snapshot,[...observation.entries]);
          for (const entry of observation.entries) {
            Object.freeze(entry.binding); Object.freeze(entry);
            entries.set(entry,{tabId,snapshot:observation.snapshot});
          }
          return observation;
          } catch(error) { logSourceCollectionFailure(error,operation,phase);invalidateSource();throw error; }
        }),
        act: (action, snapshot, options) => run(async () => {
          if (options?.scrollAcknowledgement && action.kind!=='scroll') throw new KydogError('browser.bad_action','滚动确认只适用于滚动动作');
          const expected = bindings.get(snapshot), current = browser.locationFacts(tabId);
          if (!expected || expected.documentEpoch !== current.documentEpoch || expected.routeRevision !== current.routeRevision || expected.navigationSequence !== current.navigationSequence || expected.currentUrl !== current.currentUrl)
            throw new KydogError('browser.stale_snapshot', '动作必须绑定本次操作内的当前快照');
          let collectedPermission;
          let originalBinding:XControlBinding|undefined;
          if (permissions.has(snapshot) && action.kind==='click') {
            const owned='index' in action ? permissions.get(snapshot)?.get(action.index) : undefined;
            originalBinding=owned?.binding;
            collectedPermission=owned && 'index' in action && action.snapshotId===owned.binding.snapshotId ? owned.permission : undefined;
            if (!collectedPermission) throw new KydogError('browser.bad_action','X 控件必须使用原采集节点和许可');
            // Reserve exactly one native pipeline attempt. Keep the empty map so
            // a replay cannot fall through to generic click dispatch.
            if (collectedPermission.purpose==='replies_expand' && 'index' in action) {
              permissions.get(snapshot)!.delete(action.index);
              try { options?.onReplyAdmission?.({state:'consumed',purpose:'replies_expand',binding:{...owned!.binding}}); }
              catch { /* Optional observers cannot restore permission or replace the action. */ }
            }
          }
          const result = await browser.dispatchAndObserveNavigation(tabId, action, snapshot, { signal: lifetime.signal, location: expected, strictSnapshot: true, ...(collectedPermission?{collectedPermission,collectedPointerEligibility:true,onPointerPreflight:(receipt:Readonly<PointerPreflightDiagnostic>)=>{
            try {
              if(isPointerPreflight(receipt)&&receipt.tabId===tabId&&receipt.snapshotId===originalBinding?.snapshotId&&receipt.generation===originalBinding.generation&&receipt.nodeId===originalBinding.nodeId)
                options?.onPointerPreflight?.(receipt);
            }catch{/* Optional observation cannot affect action. */}
          }}:{}), ...(options?.scrollAcknowledgement?{scrollAcknowledgement:options.scrollAcknowledgement}:{}) });
          const output = { action: { ...action }, ...result };
          const entry = action.kind==='click' && 'index' in action && action.snapshotId===snapshot.snapshotId
            ? currentEntries.get(snapshot)?.find(e=>e.binding.index===action.index) : undefined;
          if (entry) actions.set(output,{tabId,entry,location:browser.locationFacts(tabId),finalUrl:finalUrl(result.navigation)});
          return output;
        }, !!options?.scrollAcknowledgement),
        wait: (until, timeoutMs) => run(() => network?network.wait(lifetime.signal,timeoutMs):browser.waitFor(tabId, until, timeoutMs, lifetime.signal)),
        location: () => { check(); return browser.locationFacts(tabId); },
      };
      let outwardError:unknown;
      try {
        const queued = browser.enqueue(tabId, async () => {
          check(); browser.locationFacts(tabId);
          return browser.withAgentDriving(tabId, threadId, async () => {
            let workFailed=false,workError:unknown,value:T|undefined;
            try { value=await Promise.race([Promise.resolve().then(() => work(page)), stopped]); }
            catch(error) { workFailed=true;workError=error; }
            // Cancellation can win outwardly; queue ownership still lasts until
            // issued native work and both source lifecycles settle.
            while (issued.size) await Promise.allSettled([...issued]);
            const networkFailure=await network?.close();
            if(networkFailure&&workFailed)retainXNetworkCleanupFailure(workError);
            await releaseSource(workFailed);invalidateSource();
            if(workFailed)throw workError;
            if(networkFailure){const error=new KydogError('x.invalid_page','source_unavailable:'+networkFailure);retainXNetworkCleanupFailure(error);throw error;}
            return value as T;
          }, 'X 研究');
        });
        return await Promise.race([queued, stopped]);
      }
      catch(error){outwardError=error;throw error;}
      finally {
        lifetime.abort();
        while (pendingScrolls.size) await Promise.allSettled([...pendingScrolls]);
        if(await network?.close())retainXNetworkCleanupFailure(outwardError);
        signal?.removeEventListener('abort', abort); offGone(); offUnavailable();
        lifetime.abort(); bindings.clear(); currentEntries.clear(); permissions.clear();
      }
    },
  };
}
