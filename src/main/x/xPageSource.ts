import { randomUUID } from 'node:crypto';
import SOURCE from './injected/xPage.js?raw';
import POINTER_GUARD from '../browser/injected/pointerGuard.js?raw';
import WALKER from '../browser/injected/walker.js?raw';
import { KydogError } from '../../shared/errors';
import type { BrowserLocationFacts } from '../browser/browserService';
import type { AxSnapshot } from '../browser/snapshot';
import type { XActionResult, XOpenResult, XQueuedPage } from './xResearchBrowser';
import { compareXLocation, toSafeXLocation, parseXSourcePost, parseXPostCoordinates, isXPostId, isXHandle, X_MAX_RAW_URL_UNITS } from './xResearchIdentity';
import type { XArticleEntry, XAuthorIdentity, XControlBinding, XLocationRelation, XResearchStatus, XSafeLocation, XTextObservation, XTruncation, XReplyScope } from './xResearchTypes';

export type XPageRequest =
  | { stage: 'search'; expectedUrl: string; query: string; product: 'Top' | 'Latest' }
  | { stage: 'post'; expectedUrl: string; postId: string }
  | { stage: 'article'; expectedUrl: string; entry: XArticleEntry; via: { kind: 'action'; result: XActionResult } | { kind: 'open'; result: XOpenResult } };
export interface XPageControl { kind: 'body_expand' | 'replies_expand' | 'article_entry'; postId: string | null; binding: XControlBinding }
export interface XPageObservation {
  stage: XPageRequest['stage']; status: XResearchStatus; identityProven: boolean;
  location: { requested: XSafeLocation; current: XSafeLocation; relation: XLocationRelation; documentEpoch: number; routeRevision: number; navigationSequence: number; navigationEvent: string | null };
  root: XTextObservation | null; posts: XTextObservation[]; quotedPosts: XTextObservation[];
  replies: XTextObservation[]; fragments: XTextObservation[];
  article: { title: string; body: XTextObservation; blocks: string[]; links: {url: string | null; text: string; redacted: boolean}[] } | null;
  replyScope?: XReplyScope;
  readonly entryParents: WeakMap<XArticleEntry,XTextObservation>;
  entries: XArticleEntry[]; controls: XPageControl[];
  state: {kind: 'auth_required' | 'explicit_empty'; text: string; observationId: string} | null;
  /** Count of this bounded extractor's items, including quotes/fragments; never a page total. */
  scope: { collectedItemCount: number; regionObserved: boolean; selectedProduct: string | null; replyParent: null; completeness: 'unknown' };
  truncation: XTruncation; controlTruncation: XTruncation;
  /** Trusted main-process only; non-enumerable, never serialize or persist. */
  readonly snapshot: AxSnapshot;
}
export const X_DOM_MAX_STRING_UNITS = X_MAX_RAW_URL_UNITS;
export const X_DOM_MAX_QUERY_UNITS = 4096;
interface RawPost {containerKey:number;articleEntryCount:number;scope:'post'|'quote';postId:string|null;permalink:string|null;author:XAuthorIdentity|null;text:string;truncation:XTruncation}
interface RawControl {kind:XPageControl['kind'];postId:string|null;nodeId:number;index:number}
interface RawEntry {parentContainerKey:number;author:XAuthorIdentity|null;parentPostId:string;parentUrl:string;targetUrl:string|null;label:string;nodeId:number;index:number}
interface RawPage {
  rawUrl:string;region:boolean;selectedProduct:string|null;
  state:{kind:'auth_required'|'explicit_empty';text:string}|null;
  posts:RawPost[];controls:RawControl[];entries:RawEntry[];truncation:XTruncation;controlTruncation:XTruncation;
  article:{author:XAuthorIdentity|null;title:string;blocks:string[];links:{url:string;text:string}[];truncated:boolean}|null;
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
function validateRaw(v: unknown): asserts v is RawPage {
  if (!obj(v) || !str(v.rawUrl) || typeof v.region !== 'boolean' || !nullable(v.selectedProduct) || !truncation(v.truncation)
    || !truncation(v.controlTruncation) || !list(v.posts,100) || !list(v.controls,100) || !list(v.entries,100)) invalid();
  if (v.state !== null && (!obj(v.state) || !['auth_required','explicit_empty'].includes(String(v.state.kind)) || !str(v.state.text,4000))) invalid();
  for (const p of v.posts) if (!obj(p) || !integer(p.containerKey) || !integer(p.articleEntryCount) || !['post','quote'].includes(String(p.scope)) || !nullable(p.postId) || !nullable(p.permalink) || !author(p.author) || !str(p.text,4000) || !truncation(p.truncation)) invalid();
  for (const c of v.controls) if (!obj(c) || !['body_expand','replies_expand','article_entry'].includes(String(c.kind)) || !nullable(c.postId) || !integer(c.nodeId) || !integer(c.index)) invalid();
  for (const e of v.entries) if (!obj(e) || !integer(e.parentContainerKey) || !author(e.author) || !str(e.parentPostId) || !str(e.parentUrl) || !nullable(e.targetUrl) || !str(e.label,512) || !integer(e.nodeId) || !integer(e.index)) invalid();
  const a = v.article;
  if (a !== null) {
    if (!obj(a) || !author(a.author) || !str(a.title,1000) || !list(a.blocks,256) || !a.blocks.every(b=>str(b,64000)) || a.blocks.join('').length>64000 || !list(a.links,100) || typeof a.truncated !== 'boolean') invalid();
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
  else if (request.stage==='post') { if (!isXPostId(request.postId) || requestedPostId(request.expectedUrl)!==request.postId) invalid(); }
  else if (request.stage==='article') { if (!publicPost(request.expectedUrl) || !obj(request.entry) || !obj(request.via) || !['action','open'].includes(request.via.kind) || !obj(request.via.result)) invalid(); }
  else invalid();
}
/** Serializes only fixed data fields; provenance objects never enter the page. */
export function xPageExpression(request: XPageRequest): string {
  validRequest(request);
  return SOURCE.replace('const request = X_REQUEST;', () => `const request = ${JSON.stringify({stage:request.stage,postId:request.stage==='post'?request.postId:null,permissionNamespace:randomUUID()})};`).replace('const snapshot = X_WALKER;', () => `const snapshot = ${WALKER.trim().replace(/;$/, '')};`).replace('const permissionGuard = X_PERMISSION;', () => `const permissionGuard = (${POINTER_GUARD});`);
}
/** articleProven is supplied only by the port's object-identity provenance registry. */
export function decodeXPage(raw: unknown, request: XPageRequest, current: BrowserLocationFacts, articleProven: boolean): XPageObservation {
  validRequest(request); validateRaw(raw);
  const snapshot: AxSnapshot = { ...raw.snapshot, snapshotId: `xsnap_${randomUUID()}` };
  const observedAt = new Date().toISOString();
  const relation = compareXLocation(request.expectedUrl,current.currentUrl);
  const location = {requested:toSafeXLocation(request.expectedUrl),current:toSafeXLocation(current.currentUrl),relation,documentEpoch:current.documentEpoch,routeRevision:current.routeRevision,navigationSequence:current.navigationSequence,navigationEvent:current.navigationEvent};
  const exact = raw.rawUrl===current.currentUrl;
  const currentPost = publicPost(current.currentUrl,true);
  let identityProven = false;
  if (exact && request.stage==='search') {
    const u=new URL(current.currentUrl);
    identityProven = location.current.origin!==null && u.pathname==='/search' && !u.username && !u.password
      && u.searchParams.getAll('q').length===1 && u.searchParams.get('q')===request.query
      && u.searchParams.getAll('f').length===1 && u.searchParams.get('f')===(request.product==='Latest'?'live':'top')
      && raw.selectedProduct===request.product && raw.region;
  } else if (exact && request.stage==='post') identityProven = !!currentPost && currentPost.id===request.postId && raw.region;
  else if (exact && request.stage==='article') identityProven = articleProven && current.currentUrl===request.expectedUrl && !!currentPost;
  const binding = (v: {nodeId:number;index:number}): XControlBinding => ({nodeId:v.nodeId,index:v.index,snapshotId:snapshot.snapshotId,generation:snapshot.generation});
  const named = (p: RawPost): boolean => { const id=publicPost(p.permalink);return !!id && id.id===p.postId && !!p.author?.handle && id.handle===p.author.handle; };
  const makeText = (p: RawPost,kind: XTextObservation['containerKind']): XTextObservation => ({observationId:randomUUID(),sourceKind:'rendered_ui',sourceUrl:publicPost(p.permalink)?.url??null,author:p.author,text:p.text,observedAt,truncation:p.truncation,containerKind:kind,...(kind==='reply'?{directParent:null}:{}),postId:kind==='unattributed_fragment'?null:p.postId} as XTextObservation);
  let root: XTextObservation|null = null;
  const parentObservations = new Map<number,XTextObservation>();
  const posts:XTextObservation[]=[],quotedPosts:XTextObservation[]=[],replies:XTextObservation[]=[],fragments:XTextObservation[]=[];
  if (identityProven && request.stage!=='article') {
    const rootPosts=raw.posts.filter(p=>{
      const own=publicPost(p.permalink);
      return p.scope==='post' && named(p) && request.stage==='post' && p.postId===request.postId
        && own?.origin===currentPost?.origin && (currentPost?.handle===null || own?.handle===currentPost?.handle);
    });
    if (request.stage==='post' && rootPosts.length===1) {root=makeText(rootPosts[0],'root_post');parentObservations.set(rootPosts[0].containerKey,root);}
    for (const p of raw.posts) {
      if (!named(p)) { fragments.push(makeText(p,'unattributed_fragment'));continue; }
      if (request.stage==='post' && !root) continue;
      if (p.scope==='quote') {const value=makeText(p,'quoted_post');quotedPosts.push(value);parentObservations.set(p.containerKey,value);}
      else if (request.stage==='search') {const value=makeText(p,'root_post');posts.push(value);parentObservations.set(p.containerKey,value);}
      else if (p.postId!==request.postId) {const value=makeText(p,'reply');replies.push(value);parentObservations.set(p.containerKey,value);}
    }
    if (request.stage==='post' && !root) identityProven=false;
  }
  if(new Set(raw.posts.map(p=>p.containerKey)).size!==raw.posts.length) invalid();
  const entryParents=new WeakMap<XArticleEntry,XTextObservation>();
  const controls=identityProven?raw.controls.map(c=>({kind:c.kind,postId:c.postId,binding:binding(c)})):[];
  const entries:XArticleEntry[]=identityProven?raw.entries.flatMap(e=>{
    const parent=parentObservations.get(e.parentContainerKey),coordinates=publicPost(e.parentUrl);
    if(!parent || parent.containerKind==='quoted_post' || !coordinates || parent.postId!==e.parentPostId || parent.sourceUrl!==e.parentUrl || coordinates.handle!==parent.author?.handle
      || (e.author?.handle!=null && !isXHandle(e.author.handle)) || (e.targetUrl!==null && !publicPost(e.targetUrl))) return [];
    const entry:XArticleEntry={author:e.author,sourceUrl:coordinates.url,parentPostId:e.parentPostId,targetUrl:publicPost(e.targetUrl)?.url??null,label:e.label,observationId:randomUUID(),binding:binding(e)};
    entryParents.set(entry,parent);return [entry];
  }):[];
  for(const rawPost of raw.posts) {
    const parent=parentObservations.get(rawPost.containerKey);if(!parent) continue;
    const matching=entries.filter(entry=>entryParents.get(entry)===parent);
    if(matching.length>rawPost.articleEntryCount) invalid();
    if(rawPost.scope==='post') parent.articlePreviewInventory={scope:'collection',observed:matching.length,retained:0,omitted:matching.length,unresolved:rawPost.articleEntryCount-matching.length};
  }
  let article:XPageObservation['article']=null;
  const articleSource = publicPost(current.currentUrl);
  if (identityProven && request.stage==='article' && raw.article && articleSource && raw.article.author?.handle===articleSource.handle && raw.article.blocks.some(Boolean)) {
    const a=raw.article, text=a.blocks.join('\n\n');
    article={title:a.title,blocks:a.blocks,links:a.links.map(l=>({...safeLink(l.url),text:l.text})),body:{observationId:randomUUID(),sourceKind:'rendered_ui',sourceUrl:articleSource.url,author:a.author,text,observedAt,containerKind:'article',postId:articleSource.id,truncation:{returned:text.length,totalKnown:a.truncated?null:text.length,truncated:a.truncated}}};
  }
  const state=exact && location.current.origin && raw.state && (raw.state.kind==='auth_required' || identityProven) ? {...raw.state,observationId:randomUUID()} : null;
  const replyScope: XReplyScope = {rootPostId:root?.postId??null,branch:null,sort:null,displayedReplyCount:null,completeness:'unknown',endEvidence:null,stopReason:'agent_stopped'};
  const result = {replyScope,stage:request.stage,status:state?.kind ?? (root || posts.length || article ? 'observed':'partial'),identityProven,location,root,posts,quotedPosts,replies,fragments,article,entries,controls,state,scope:{collectedItemCount:raw.posts.length,regionObserved:raw.region,selectedProduct:raw.selectedProduct,replyParent:null,completeness:'unknown'},truncation:raw.truncation,controlTruncation:{...raw.controlTruncation,returned:controls.length,truncated:raw.controlTruncation.truncated || controls.length<raw.controlTruncation.returned}} as XPageObservation;
  Object.defineProperty(result,'entryParents',{value:entryParents,enumerable:false});
  Object.defineProperty(result,'snapshot',{value:snapshot,enumerable:false});
  return result;
}
/** Public fixed-purpose adapter; the port validates raw DOM before returning. */
export async function collectXPage(page: XQueuedPage, request: XPageRequest): Promise<XPageObservation> {
  return page.collect(request);
}
