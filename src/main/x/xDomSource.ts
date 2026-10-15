import { randomUUID } from 'node:crypto';
import { replyUiInventorySchema, replyUiInventoryMatchesRegion, type XReplyUiInventory } from './xReplyUiInventory';
import { z } from 'zod';
import ROOT_SOURCE from './injected/xSourceRoot.js?raw';
import SOURCE from './injected/xPage.js?raw';
import POINTER_GUARD from '../browser/injected/pointerGuard.js?raw';
import WALKER from '../browser/injected/walker.js?raw';
import { KydogError } from '../../shared/errors';
import type { BrowserLocationFacts } from '../browser/browserService';
import type { AxSnapshot } from '../browser/snapshot';
import type { XPageRequest, XPageControl, XPageObservation } from './xObservation';
import { compareXLocation, toSafeXLocation, parseXSourcePost, parseXPostCoordinates, isXPostId, isXHandle, parseXArticleAnalyticsHref, X_MAX_RAW_URL_UNITS } from './xResearchIdentity';
import type { XArticleNativeIdentity, XArticleEntry, XAuthorIdentity, XControlBinding, XTextObservation, XTruncation, XReadFrameDiagnostic, XSourceRootState } from './xResearchTypes';

export const X_DOM_MAX_STRING_UNITS = X_MAX_RAW_URL_UNITS;
export const X_DOM_MAX_QUERY_UNITS = 4096;
interface RawPost {containerKey:number;articleEntryCount:number;scope:'post'|'quote';postId:string|null;permalink:string|null;candidatePostId:string|null;identityIssue:'unnamed'|'author_mismatch'|null;author:XAuthorIdentity|null;text:string;truncation:XTruncation}
interface RawControl {kind:XPageControl['kind'];postId:string|null;nodeId:number;index:number;sourceRelation:XPageControl['sourceRelation']}
interface RawEntry {parentContainerKey:number;author:XAuthorIdentity|null;parentPostId:string;parentUrl:string;targetUrl:string|null;label:string;nodeId:number;index:number}
interface RawPage {
  replyUiInventory?: XReplyUiInventory;
  rawUrl:string;region:boolean;
  diagnosticNodes:{regionNodeId:number|null;rootNodeId:number|null};
  state:{kind:'auth_required'|'explicit_empty';text:string}|null;
  posts:RawPost[];controls:RawControl[];entries:RawEntry[];truncation:XTruncation;controlTruncation:XTruncation;
  article:{ownIdentityLinks?:{totalKnown:number;hrefs:(string|null)[]};author:XAuthorIdentity|null;title:string;blocks:string[];links:{url:string;text:string}[];truncated:boolean}|null;
  snapshot:Omit<AxSnapshot,'snapshotId'>;
}
function invalid(): never { throw new KydogError('x.invalid_page', 'Invalid X page observation'); }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = X_DOM_MAX_STRING_UNITS): v is string => typeof v === 'string' && v.length <= max;
const nullable = (v: unknown): v is string | null => v === null || str(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
const author = (v: unknown): boolean => v === null || (obj(v) && nullable(v.handle) && nullable(v.displayName) && nullable(v.profileUrl));
const truncation = (v: unknown): boolean => obj(v) && integer(v.returned) && (v.totalKnown === null || integer(v.totalKnown)) && typeof v.truncated === 'boolean';
/** Validate the entire fixed DOM boundary before consuming any page-supplied field. */
function validateRaw(v: unknown, request: XPageRequest, current: BrowserLocationFacts): asserts v is RawPage {
  if (!obj(v) || !str(v.rawUrl) || typeof v.region !== 'boolean' || !truncation(v.truncation)
    || !truncation(v.controlTruncation) || !list(v.posts,100) || !list(v.controls,100) || !list(v.entries,100)
    || !obj(v.diagnosticNodes) || !(v.diagnosticNodes.regionNodeId===null || integer(v.diagnosticNodes.regionNodeId))
    || !(v.diagnosticNodes.rootNodeId===null || integer(v.diagnosticNodes.rootNodeId))) invalid();
  if(v.replyUiInventory!==undefined){
    const inventory=replyUiInventorySchema.safeParse(v.replyUiInventory);
    if(!inventory.success || !replyUiInventoryMatchesRegion(inventory.data,v.diagnosticNodes.regionNodeId as number|null)) invalid();
  }
  if (v.state !== null && (!obj(v.state) || !['auth_required','explicit_empty'].includes(String(v.state.kind)) || !str(v.state.text,4000))) invalid();
  for (const p of v.posts) if (!obj(p) || !integer(p.containerKey) || !integer(p.articleEntryCount) || !['post','quote'].includes(String(p.scope)) || !nullable(p.postId) || !nullable(p.permalink) || !nullable(p.candidatePostId) || (p.identityIssue!==null && !['unnamed','author_mismatch'].includes(String(p.identityIssue))) || !author(p.author) || !str(p.text,64000) || !truncation(p.truncation)) invalid();
  const rawPosts=v.posts as RawPost[];
  if(request.stage==='post' && request.collectReplies===false && (rawPosts.some(p=>p.scope==='post' && p.candidatePostId!==request.postId)
    || v.controls.some(c=>obj(c) && c.kind==='replies_expand'))) invalid();
  for (const p of rawPosts) if (p.identityIssue===null ? p.postId===null || p.postId!==p.candidatePostId : p.postId!==null) invalid();
  const rawTruncation=v.truncation as XTruncation;
  const currentPost=publicPost(current.currentUrl,true);
  const candidatePosts=request.stage==='post' ? rawPosts.filter(p=>p.postId===request.postId) : [];
  const candidate=candidatePosts.length===1 ? candidatePosts[0] : null;
  const own=candidate && publicPost(candidate.permalink);
  const focal=!!candidate && candidate.scope==='post' && request.stage==='post' && v.rawUrl===current.currentUrl && v.region
    && rawTruncation.returned===rawPosts.length && rawTruncation.totalKnown===rawPosts.length && !rawTruncation.truncated
    && currentPost?.id===request.postId && !!currentPost.handle && own?.id===candidate.postId
    && own.origin===currentPost.origin && own.handle===currentPost.handle && candidate.author?.handle===own.handle;
  for (const p of rawPosts) if (!str(p.text,p===candidate && focal?64000:4000)
    || p.truncation.returned!==p.text.length || p.truncation.totalKnown===null
    || p.truncation.totalKnown<p.truncation.returned || p.truncation.truncated!==(p.truncation.totalKnown>p.truncation.returned)) invalid();
  for (const c of v.controls) if (!obj(c) || !['body_expand','replies_expand','article_entry'].includes(String(c.kind)) || !nullable(c.postId) || !integer(c.nodeId) || !integer(c.index)
    || !['same_cell','focal_contains_control','control_contains_focal','different_cell','unknown'].includes(String(c.sourceRelation))) invalid();
  for (const e of v.entries) if (!obj(e) || !integer(e.parentContainerKey) || !author(e.author) || !str(e.parentPostId) || !str(e.parentUrl) || !nullable(e.targetUrl) || !str(e.label,512) || !integer(e.nodeId) || !integer(e.index)) invalid();
  const a = v.article;
  if (a !== null) {
    if (!obj(a) || !author(a.author) || !str(a.title,1000) || !list(a.blocks,256) || !a.blocks.every(b=>str(b,64000)) || a.blocks.join('').length>64000 || !list(a.links,100) || typeof a.truncated !== 'boolean') invalid();
    if (a.ownIdentityLinks!==undefined) {
      const own=a.ownIdentityLinks;
      if (!obj(own) || !integer(own.totalKnown) || !list(own.hrefs,2) || !own.hrefs.every(nullable)) invalid();
    }
    for (const link of a.links) if (!obj(link) || !str(link.url) || !str(link.text,512)) invalid();
  }
  const s = v.snapshot;
  if (!obj(s) || !str(s.generation) || !str(s.url) || !str(s.title,100000) || !integer(s.iframes) || !list(s.nodes,300) || !obj(s.collection) || !truncation({...s.collection,totalKnown:null}) || s.collection.scope !== 'filtered' || s.collection.totalKnown !== undefined) invalid();
  const ids = new Set<number>(), indexes = new Set<number>();
  for (const n of s.nodes) {
    if (!obj(n) || !integer(n.index) || !integer(n.nodeId) || !str(n.role) || !str(n.name) || !['x','y','w','h'].every(k=>typeof n[k]==='number' && Number.isFinite(n[k])) || ids.has(n.nodeId) || indexes.has(n.index)) invalid();
    if (n.collectedPermission!==undefined && (!obj(n.collectedPermission) || n.collectedPermission.owner!=='x' || !str(n.collectedPermission.token) || !str(n.collectedPermission.purpose))) invalid();
    ids.add(n.nodeId); indexes.add(n.index);
  }
  for (const c of [...v.controls,...v.entries]) if (!obj(c) || !(s.nodes as Record<string,unknown>[]).some(n=>n.nodeId===c.nodeId && n.index===c.index)) invalid();
  if (s.url !== v.rawUrl) invalid();
}
const publicPost = parseXSourcePost;
/** Public media coordinates may name a request, never prove a document or body identity. */
function requestedPostId(raw: string): string | null {
  return parseXPostCoordinates(raw, { allowMedia: true })?.id ?? null;
}
function safeLink(raw: string): {url:string|null;redacted:boolean} {
  try {
    const u=new URL(raw);
    if (['http:','https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash) return {url:raw,redacted:false};
  } catch { /* An unknown destination remains an entry, never a fabricated URL. */ }
  return {url:null,redacted:true};
}
function validRequest(request: XPageRequest): void {
  if (!obj(request) || !str(request.expectedUrl)) invalid();
  if (request.stage==='search') {
    if (!str(request.query,X_DOM_MAX_QUERY_UNITS) || !['Top','Latest'].includes(request.product)) invalid();
    const expected=toSafeXLocation(request.expectedUrl);
    if (!expected.origin || expected.path!=='/search' || expected.q!==request.query || expected.f!==(request.product==='Latest'?'live':'top')) invalid();
  }
  else if (request.stage==='post') { if (!isXPostId(request.postId) || requestedPostId(request.expectedUrl)!==request.postId || (request.collectReplies!==undefined && typeof request.collectReplies!=='boolean')) invalid(); }
  else if (request.stage==='article') { if (!publicPost(request.expectedUrl) || !obj(request.entry) || !obj(request.via) || !['action','open'].includes(request.via.kind) || !obj(request.via.result)) invalid(); }
  else invalid();
}
/** Serializes only fixed data fields; provenance objects never enter the page. */
export function xPageExpression(request: XPageRequest, sourceRoot?: XSourceRootEnvelope): string {
  validRequest(request);
  return SOURCE.replace('const rootDiagnostics = X_ROOT;', () => `const rootDiagnostics = (${ROOT_SOURCE});`).replace('const request = X_REQUEST;', () => `const request = ${JSON.stringify({stage:request.stage,postId:request.stage==='post'?request.postId:null,...(request.stage==='post'?{collectReplies:request.collectReplies}:{}),sourceRoot,permissionNamespace:randomUUID()})};`).replace('const snapshot = X_WALKER;', () => `const snapshot = ${WALKER.trim().replace(/;$/, '')};`).replace('const permissionGuard = X_PERMISSION;', () => `const permissionGuard = (${POINTER_GUARD});`);
}
/** Supplied only by the port's object-identity provenance registries. */
export interface XPageNavigationProof {
  parentArticle: boolean;
  directOpen?: {openedLocation: BrowserLocationFacts; sameGeneration: boolean};
}
export function decodeXPage(raw: unknown, request: XPageRequest, current: BrowserLocationFacts, proof: XPageNavigationProof): XPageObservation {
  validRequest(request); validateRaw(raw,request,current);
  const snapshot: AxSnapshot = { ...raw.snapshot, snapshotId: `xsnap_${randomUUID()}` };
  const observedAt = new Date().toISOString();
  const relation = compareXLocation(request.expectedUrl,current.currentUrl);
  const location = {requested:toSafeXLocation(request.expectedUrl),current:toSafeXLocation(current.currentUrl),relation,documentEpoch:current.documentEpoch,routeRevision:current.routeRevision,navigationSequence:current.navigationSequence,navigationEvent:current.navigationEvent};
  const exact = raw.rawUrl===current.currentUrl;
  const currentPost = publicPost(current.currentUrl,true);
  let identityProven = false;
  if (exact && request.stage==='post') identityProven = !!currentPost && currentPost.id===request.postId && raw.region;
  else if (exact && request.stage==='article') identityProven = proof.parentArticle && current.currentUrl===request.expectedUrl && !!currentPost;
  const binding = (v: {nodeId:number;index:number}): XControlBinding => ({nodeId:v.nodeId,index:v.index,snapshotId:snapshot.snapshotId,generation:snapshot.generation});
  const named = (p: RawPost): boolean => { const id=publicPost(p.permalink);return !!id && id.id===p.postId && !!p.author?.handle && id.handle===p.author.handle; };
  const root: XTextObservation|null = null;
  let rootContainerKey:number|null=null;
  const parentObservations=new Map<number,{postId:string;sourceUrl:string;authorHandle:string}>();
  const posts:XTextObservation[]=[],quotedPosts:XTextObservation[]=[],replies:XTextObservation[]=[],fragments:XTextObservation[]=[];
  if(identityProven&&request.stage==='post')for(const p of raw.posts){
    if(p.scope!=='post'||!named(p)||p.postId!==request.postId)continue;
    const own=publicPost(p.permalink);
    if(own?.origin!==currentPost?.origin||(currentPost?.handle!==null&&own?.handle!==currentPost?.handle))continue;
    parentObservations.set(p.containerKey,{postId:p.postId!,sourceUrl:p.permalink!,authorHandle:p.author!.handle!});rootContainerKey=p.containerKey;
  }
  if(new Set(raw.posts.map(p=>p.containerKey)).size!==raw.posts.length) invalid();
  const entryParents=new WeakMap<XArticleEntry,{postId:string;sourceUrl:string;authorHandle:string}>();
  const controls=identityProven && (request.stage!=='post'||parentObservations.size===1)?raw.controls.map(c=>({kind:c.kind,postId:c.postId,binding:binding(c),sourceRelation:c.sourceRelation})):[];
  const postCandidates = request.stage === 'post' ? raw.posts.filter(p=>p.scope==='post' && p.candidatePostId===request.postId) : [];
  const rootRejections = {unnamed:0,authorMismatch:0,permalinkMismatch:0};
  if (request.stage==='post') rootRejections.unnamed=raw.posts.filter(p=>p.scope==='post' && p.candidatePostId===null).length;
  for (const p of postCandidates) {
    const own=publicPost(p.permalink);
    if (p.identityIssue==='unnamed' || !p.author?.handle) rootRejections.unnamed++;
    else if (p.identityIssue==='author_mismatch' || (own && own.handle!==p.author.handle)) rootRejections.authorMismatch++;
    else if (!own) rootRejections.unnamed++;
    else if (own.id!==p.postId || own.origin!==currentPost?.origin || (currentPost?.handle!==null && own.handle!==currentPost?.handle)) rootRejections.permalinkMismatch++;
  }
  const entries:XArticleEntry[]=identityProven&&parentObservations.size===1?raw.entries.flatMap(e=>{
    const parent=parentObservations.get(e.parentContainerKey),coordinates=publicPost(e.parentUrl);
    if(!parent || !coordinates || parent.postId!==e.parentPostId || parent.sourceUrl!==e.parentUrl || coordinates.handle!==parent.authorHandle
      || (e.author?.handle!=null && !isXHandle(e.author.handle)) || (e.targetUrl!==null && !publicPost(e.targetUrl))) return [];
    const entry:XArticleEntry={author:e.author,sourceUrl:coordinates.url,parentPostId:e.parentPostId,targetUrl:publicPost(e.targetUrl)?.url??null,label:e.label,observationId:randomUUID(),binding:binding(e)};
    entryParents.set(entry,parent);return [entry];
  }):[];
  const articleParentInventories=new Map<number,{postId:string;sourceUrl:string;authorHandle:string;observedEntries:number;unresolvedEntries:number}>();
  if(parentObservations.size===1&&!raw.truncation.truncated&&!raw.controlTruncation.truncated){
    for(const [key,parent] of parentObservations){const own=raw.posts.find(p=>p.containerKey===key)!;const permitted=entries.filter(e=>entryParents.get(e)===parent).length;if(permitted>own.articleEntryCount)invalid();articleParentInventories.set(key,{...parent,observedEntries:permitted,unresolvedEntries:own.articleEntryCount-permitted});}
  }
  let article:XPageObservation['article']=null;
  const articleSource = publicPost(current.currentUrl);
  const own=raw.article?.ownIdentityLinks;
  const identityAbsent=own===undefined || (own.totalKnown===0 && own.hrefs.length===0);
  const href=own?.totalKnown===1 && own.hrefs.length===1 ? own.hrefs[0] : null;
  const coordinates=href!==null && href!==undefined && articleSource ? parseXArticleAnalyticsHref(href,articleSource.url) : null;
  const identityMatches=!!coordinates && coordinates.id===articleSource?.id && coordinates.handle===articleSource?.handle && coordinates.handle===raw.article?.author?.handle;
  const nativeIdentity: XArticleNativeIdentity | undefined=identityMatches ? {kind:'owned_analytics',href:href!,documentGeneration:`${current.documentEpoch}:${current.routeRevision}:${current.navigationSequence}`} : undefined;
  const directArticle = request.stage==='post' && !!request.directOpen && !!proof.directOpen && exact && current.currentUrl===request.expectedUrl && currentPost?.id===request.postId
    && (identityAbsent ? proof.directOpen.sameGeneration : identityMatches && proof.directOpen.openedLocation.documentEpoch===current.documentEpoch);
  if ((identityAbsent || identityMatches) && ((identityProven && request.stage==='article') || directArticle) && raw.article && articleSource && raw.article.author?.handle===articleSource.handle && raw.article.blocks.some(Boolean)) {
    const a=raw.article, text=a.blocks.join('\n\n');
    if (directArticle) identityProven=true;
    article={...(nativeIdentity?{nativeIdentity}:{}),title:a.title,blocks:a.blocks,links:a.links.map(l=>({...safeLink(l.url),text:l.text})),body:{observationId:randomUUID(),sourceKind:'rendered_ui',sourceUrl:articleSource.url,author:a.author,text,observedAt,containerKind:'article',postId:articleSource.id,truncation:{returned:text.length,totalKnown:a.truncated?null:text.length,truncated:a.truncated}}};
  }
  if(request.stage==='post'&&!article)identityProven=false;
  const state=exact && location.current.origin && raw.state && (raw.state.kind==='auth_required' || identityProven) ? {...raw.state,observationId:randomUUID()} : null;
  const diagnosticFrame: XReadFrameDiagnostic | undefined = request.stage==='post' ? {
    ...(raw.replyUiInventory ? {sourceEndDetector:'not_implemented' as const,replyUiInventory:replyUiInventorySchema.parse(raw.replyUiInventory)} : {}),
    stage:'post',snapshotId:snapshot.snapshotId,location:location.current,
    document:{epoch:current.documentEpoch,routeRevision:current.routeRevision,navigationSequence:current.navigationSequence,generation:snapshot.generation},
    rawUrlMatchesPort:exact,requestPostMatchesLocation:currentPost?.id===request.postId,
    regionObserved:raw.region,inventory:{...raw.truncation},rootCandidateCount:postCandidates.length,rootRejections,
    regionNodeId:raw.diagnosticNodes.regionNodeId,rootNodeId:rootContainerKey!==null?raw.diagnosticNodes.rootNodeId:null,
    rootIdentityProven:rootContainerKey!==null,
    replyCount:replies.length,repliesExpandControlCount:controls.filter(c=>c.kind==='replies_expand').length,
    explicitEndObserved:false,
  } : undefined;
  const result = {stage:request.stage,status:state?.kind ?? (root || posts.length || article ? 'observed':'partial'),identityProven,location,root,posts,quotedPosts,replies,fragments,article,entries,controls,state,diagnosticFrame,scope:{collectedItemCount:raw.posts.length,regionObserved:raw.region,replyParent:null,completeness:'unknown'},truncation:raw.truncation,controlTruncation:{...raw.controlTruncation,returned:controls.length,truncated:raw.controlTruncation.truncated || controls.length<raw.controlTruncation.returned}} as XPageObservation;
  if(rootContainerKey!==null) decodedRootKeys.set(result,rootContainerKey);
  Object.defineProperty(result,'articleParentInventories',{value:articleParentInventories,enumerable:false});
  Object.defineProperty(result,'entryParents',{value:entryParents,enumerable:false});
  Object.defineProperty(result,'snapshot',{value:snapshot,enumerable:false});
  return result;
}



/** Internal envelope: never copied to observations, tools, persistence, or permissions. */
export interface XSourceRootEnvelope {
  lease:string; collectionKey:string; binding:string; reset?:boolean;
  commit?:{collectionKey:string;containerKey:number;generation:string;anchorSnapshotId:string};
}
const nullableBool=z.boolean().nullable();
const identityState=z.enum(['same','changed','missing','ambiguous','unavailable']);
export const sourceRootStateSchema=z.object({
  anchorSnapshotId:z.string().min(1).max(128),availability:z.enum(['captured','unavailable']),
  conversation:z.object({candidates:z.enum(['none','unique','multiple','unavailable']),sameObject:nullableBool,connected:nullableBool,sameDocument:nullableBool,containsRoot:nullableBool}).strict(),
  root:z.object({connection:z.enum(['connected','detached','unavailable']),sameDocument:nullableBool,topLevel:nullableBool,ownBoundary:nullableBool,inRoots:nullableBool,inRawPosts:nullableBool,
    shown:z.enum(['pass','dimensions','hidden','aria_hidden','display_none','visibility_hidden','collapse','unavailable'])}).strict(),
  identity:z.object({members:identityState,coordinates:identityState,owned:nullableBool,rendered:identityState,
    nameCount:z.number().int().min(0).max(33).nullable(),profileLinkCount:z.number().int().min(0).max(33).nullable(),timestampCount:z.number().int().min(0).max(33).nullable()}).strict(),
}).strict();
const sourceRootReplySchema=z.object({lease:z.string(),collectionKey:z.string(),containerKey:z.number().int().nonnegative().nullable(),candidateState:sourceRootStateSchema.nullable(),anchorState:sourceRootStateSchema.nullable()}).strict();
const decodedRootKeys=new WeakMap<XPageObservation,number>();
const rootAdmissions=new WeakMap<XPageObservation,()=>void>();
export function admitXSourceRoot(observation:XPageObservation):void { rootAdmissions.get(observation)?.(); }
export function xSourceRootReleaseExpression(lease:string):string { return `/* kydog-x-root-release */ (${ROOT_SOURCE})(${JSON.stringify({lease,release:true})})`; }
/** Bind only actual decoder output; restored diagnostic DTOs cannot call this path. */
export function bindXSourceRoot(observation:XPageObservation, raw:unknown, envelope:XSourceRootEnvelope, admit:(commit:NonNullable<XSourceRootEnvelope['commit']>)=>boolean):void {
  if (!obj(raw)) return;
  const parsed=sourceRootReplySchema.safeParse(raw.sourceRoot);
  if (!parsed.success) {
    const frame=observation.diagnosticFrame, commit=envelope.commit;
    if(frame && commit && commit.generation===observation.snapshot.generation) frame.sourceRootState={anchorSnapshotId:commit.anchorSnapshotId,availability:'unavailable',
      conversation:{candidates:'unavailable',sameObject:null,connected:null,sameDocument:null,containsRoot:null},
      root:{connection:'unavailable',sameDocument:null,topLevel:null,ownBoundary:null,inRoots:null,inRawPosts:null,shown:'unavailable'},
      identity:{members:'unavailable',coordinates:'unavailable',owned:null,rendered:'unavailable',nameCount:null,profileLinkCount:null,timestampCount:null}};
    return;
  }
  const data=parsed.data;
  if(data.lease!==envelope.lease || data.collectionKey!==envelope.collectionKey) return;
  const frame=observation.diagnosticFrame;
  if(!frame) return;
  if(data.anchorState && (!envelope.commit || data.anchorState.anchorSnapshotId===envelope.commit.anchorSnapshotId))
    frame.sourceRootState=data.anchorState;
  const key=decodedRootKeys.get(observation);
  if (key===undefined || key!==data.containerKey || !data.candidateState
    || !frame.rawUrlMatchesPort || !frame.rootIdentityProven || observation.state || observation.truncation.truncated
    || observation.truncation.totalKnown!==observation.truncation.returned) return;
  const state:XSourceRootState={...data.candidateState,anchorSnapshotId:observation.snapshot.snapshotId};
  rootAdmissions.set(observation,()=>{
    if(admit({collectionKey:envelope.collectionKey,containerKey:key,generation:observation.snapshot.generation,anchorSnapshotId:observation.snapshot.snapshotId})) frame.sourceRootState=state;
  });
}
