import { X_DOM_MAX_STRING_UNITS } from './xPageSource';
import { X_RESEARCH_MAX_OUTPUT_BYTES, type XResearchResult, type XTextObservation, type XCollectionTransition } from './xResearchTypes';

export interface XSerializedResult<T extends XResearchResult=XResearchResult> {result:T; text:string}
export function xResearchToolResult(value:XSerializedResult): {content:{type:'text';text:string}[];details:XResearchResult} {
  return {content:[{type:'text',text:value.text}],details:value.result};
}
function texts(result:XResearchResult):XTextObservation[] {
  return result.operation==='search'?result.queries.flatMap(q=>q.posts):result.targets.flatMap(t=>[...(t.root?[t.root]:[]),...t.quotedPosts,...(t.article.body?[t.article.body]:[]),...t.replies.observations]);
}
function body(p:XTextObservation) {
  return {observationId:p.observationId,postId:p.postId,containerKind:p.containerKind,text:p.text,truncation:p.truncation};
}
/** Explicit ordinal references identify original arguments without echoing huge
 * metadata twice. The canonical details retain literal identities and sources. */
function projection(result:XResearchResult) {
  const base={contentProjection:'x_research_projection_v1',identityReferences:'indices refer to original arguments and canonical details; do not infer authors or URLs from omitted metadata',schemaVersion:2,sourceKind:result.sourceKind,operation:result.operation,
    browserTabId:result.browserTabId,callId:result.callId,batchId:result.batchId,runId:result.runId,status:result.status,budgetUsage:result.budgetUsage,truncation:result.truncation,metadataOmissions:result.metadataOmissions??[]};
  return result.operation==='search'?{...base,queries:result.queries.map((q,index)=>({queryIndex:index,product:q.query.product,status:q.status,stopReason:q.stopReason,budgetUsage:q.budgetUsage,posts:q.posts.map(p=>({...body(p),sourceUrl:p.sourceUrl,authorHandle:p.author?.handle??null})),barrier:q.barrier,collectionTransitions:q.collectionTransitions}))}
    :{...base,targets:result.targets.map((t,index)=>({targetIndex:index,inputKind:t.inputKind,inputUrlRedacted:t.inputUrlRedacted,status:t.status,reason:t.reason,stopReason:t.stopReason,budgetUsage:t.budgetUsage,
      root:t.root?{observationId:t.root.observationId,containerKind:'root_post',identityInCanonicalDetails:true,text:t.root.text,truncation:t.root.truncation}:null,
      quotedPosts:t.quotedPosts.map(body),article:{requested:t.article.requested,entryObserved:t.article.entryObserved,actionAttempted:t.article.actionAttempted,navigationStarted:t.article.navigationStarted,bodyObserved:t.article.bodyObserved,body:t.article.body?body(t.article.body):null,barrier:t.article.barrier},
      replies:{requested:t.replies.requested,observations:t.replies.observations.map(body),scope:{completeness:t.replies.scope.completeness,stopReason:t.replies.scope.stopReason,rootIdentityInCanonicalDetails:true,branch:t.replies.scope.branch,sort:t.replies.scope.sort,endEvidence:t.replies.scope.endEvidence,displayedReplyCount:t.replies.scope.displayedReplyCount}},
      documentSource:t.documentSource?{rootObservationId:t.documentSource.rootObservationId,sourceInCanonicalDetails:true}:null,barrier:t.barrier,collectionTransitions:t.collectionTransitions}))};
}
/** Fixed points include both JSON escaping and the decimal byte counters. */
function measure<T extends XResearchResult>(result:T,projected=false):XSerializedResult<T> {
  const rows=result.operation==='search'?result.queries:result.targets;
  for(;;) {
    const projectedRows=projected?(result.operation==='search'?(projection(result) as {queries:unknown[]}).queries:(projection(result) as {targets:unknown[]}).targets):null;
    let changed=false;
    rows.forEach((row,index)=>{
      const json=JSON.stringify(row), model=JSON.stringify(projectedRows?.[index]??row);
      const bytes=Buffer.byteLength(json,'utf8')+Buffer.byteLength(JSON.stringify(model),'utf8')-2;
      if(bytes!==row.budgetUsage.outputBytes){row.budgetUsage.outputBytes=bytes;changed=true;}
    });
    if(!changed) break;
  }
  for(;;) {
    const text=JSON.stringify(projected?projection(result):result);
    const bytes=Buffer.byteLength(JSON.stringify(xResearchToolResult({result,text})),'utf8');
    if(bytes===result.budgetUsage.outputBytes) return {result,text};
    result.budgetUsage.outputBytes=bytes;
  }
}
const emptySafe=()=>({origin:null,path:null,q:null,f:null,fragment:null,redacted:true});
function compactMetadata(result:XResearchResult):void {
  const omitted=result.metadataOmissions??=[];
  const mark=(path:string)=>{if(!omitted.includes(path)) omitted.push(path);};
  const rows=result.operation==='search'?result.queries:result.targets;
  rows.forEach((row,index)=>{
    const prefix=`${result.operation==='search'?'queries':'targets'}.${index}`;
    if(row.location) {
      row.location.requested=emptySafe();mark(`${prefix}.location.requested`);
      if(row.location.committed){row.location.committed=null;mark(`${prefix}.location.committed`);}
      if(row.location.subsequent){row.location.subsequent=null;mark(`${prefix}.location.subsequent`);}
    }
    for(const [n,t] of row.collectionTransitions.entries()) {
      t.before.location=emptySafe();t.after.location=emptySafe();mark(`${prefix}.collectionTransitions.${n}.locations`);
    }
    if(row.barrier) {row.barrier.reason='omitted_due_output_budget';mark(`${prefix}.barrier.reason`);}
  });
  if(result.operation==='read') result.targets.forEach((t,index)=>{
    const prefix=`targets.${index}`;
    if(t.root?.author) {
      if(t.root.author.profileUrl!==null){t.root.author.profileUrl=null;mark(`${prefix}.root.author.profileUrl`);}
      if(t.root.author.displayName!==null){t.root.author.displayName=null;mark(`${prefix}.root.author.displayName`);}
    }
    // Exact equality, not URL normalization. This alias loses no source fact.
    if(t.root && t.sourceUrl!==null && t.sourceUrl===t.root.sourceUrl) {t.sourceUrl=null;t.sourceUrlReference='root.sourceUrl';mark(`${prefix}.sourceUrl (exact alias root.sourceUrl)`);}
    if(t.article.entry){t.article.entry=null;mark(`${prefix}.article.entry`);}
  });
}
/** Admissibility sizes a required-state representation, not max100 optional
 * candidates/replies. Source identity strings are bounded by the actual fixed
 * DOM boundary. UUID/ISO/counter sizes follow production generators. This
 * sizing-only object is never returned, remembered or treated as evidence. */
export function assertXRequestFits(original:XResearchResult):void {
  const state=structuredClone(original);
  if(!state.browserTabId) state.browserTabId='tab_00000000'; // actual tab_<UUID slice8> format
  const uuid='00000000-0000-0000-0000-000000000000', date='0'.repeat(27);
  const rows=state.operation==='search'?state.queries:state.targets;
  const transition=(stage:'search'|'post'):XCollectionTransition=>({stage,before:{location:emptySafe(),documentEpoch:Number.MAX_SAFE_INTEGER,routeRevision:Number.MAX_SAFE_INTEGER,navigationSequence:Number.MAX_SAFE_INTEGER,navigationEvent:'did-navigate-in-page'},after:{location:emptySafe(),documentEpoch:Number.MAX_SAFE_INTEGER,routeRevision:Number.MAX_SAFE_INTEGER,navigationSequence:Number.MAX_SAFE_INTEGER,navigationEvent:'did-navigate-in-page'},relation:{origin:'different',path:'different',postId:'different',query:'different',product:'different',fragment:'different'},rereadRequested:true,outcome:'same_url_generation_changed'});
  rows.forEach(row=>{
    row.status='action_required';row.stopReason='navigation_failed';row.budgetUsage={scrolls:20,expandActions:20,distinctEntries:100,outputBytes:X_RESEARCH_MAX_OUTPUT_BYTES};
    row.barrier={status:'action_required',reason:'omitted_due_output_budget',observationId:uuid};
    row.location={committedNavigationOutcome:'ok_same_document',requested:emptySafe(),committed:null,subsequent:null,relation:{origin:'different',path:'different',postId:'different',query:'different',product:'different',fragment:'different'},documentGeneration:'0'.repeat(50),navigationEvent:'did-navigate-in-page'};
    row.collectionTransitions=[transition(state.operation==='search'?'search':'post'),transition(state.operation==='search'?'search':'post')];
  });
  if(state.operation==='read') state.targets.forEach(t=>{
    t.reason='collection_failed:browser.not_dispatchable';
    const id=t.postId;
    // A named permalink's handle+ID must fit the same literal URL boundary.
    const handleUnits=id?X_DOM_MAX_STRING_UNITS-'https://x.com//status/'.length-id.length:0;
    if(id && handleUnits>=1) {
      t.root={observationId:uuid,sourceKind:'rendered_ui',sourceUrl:'u'.repeat(X_DOM_MAX_STRING_UNITS),author:{handle:'a'.repeat(handleUnits),displayName:'d',profileUrl:'p'},text:'',observedAt:date,truncation:{returned:0,totalKnown:4000,truncated:true},containerKind:'root_post',postId:id};
      t.sourceUrl=t.root.sourceUrl;t.replies.scope.rootPostId=id;
      t.documentSource={urlKind:'document',sourceUrl:'u'.repeat(X_DOM_MAX_STRING_UNITS),observationId:uuid,rootObservationId:uuid,observedAt:date,containerKind:'root_post',runId:state.runId,callId:state.callId,batchId:state.batchId,queryId:null,query:null,purpose:null,product:null};
    }
    t.article.entryObserved=true;t.article.actionAttempted=true;t.article.navigationStarted=true;t.article.bodyObserved=true;
  });
  state.budgetUsage={scrolls:400,expandActions:400,distinctEntries:2000,outputBytes:X_RESEARCH_MAX_OUTPUT_BYTES};
  state.truncation={returned:0,totalKnown:8080000,truncated:true};state.contentProjection='x_research_projection_v1';
  compactMetadata(state);
  if(measure(state,true).result.budgetUsage.outputBytes>X_RESEARCH_MAX_OUTPUT_BYTES) throw new Error('x_research: request metadata exceeds 1 MiB required-state envelope; shorten or split the request');
}
export function serializeXResearchResult<T extends XResearchResult>(original:T):XSerializedResult<T> {
  const result=structuredClone(original), bodies=texts(result), previous=result.truncation;
  const totalKnown=previous.truncated?previous.totalKnown:bodies.some(p=>p.truncation.totalKnown===null)?null:bodies.reduce((n,p)=>n+p.truncation.totalKnown!,0);
  let projected=!!result.contentProjection;
  const update=()=>{
    result.truncation={returned:texts(result).reduce((n,p)=>n+p.text.length,0),totalKnown,truncated:previous.truncated || bodies.some(p=>p.truncation.truncated) || texts(result).length<bodies.length || !!result.metadataOmissions?.length};
    return measure(result,projected);
  };
  let value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES) return value;
  projected=true;result.contentProjection='x_research_projection_v1';
  value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES) return value;
  for(const p of bodies.filter(b=>b.text.length).sort((a,b)=>b.text.length-a.text.length)) {
    const full=p.text;let lo=0,hi=full.length;p.truncation.truncated=true;
    while(lo<hi) {const mid=Math.ceil((lo+hi)/2);p.text=full.slice(0,mid);p.truncation.returned=p.text.length;if(update().result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES) lo=mid;else hi=mid-1;}
    p.text=full.slice(0,lo);if(/[\uD800-\uDBFF]$/.test(p.text)) p.text=p.text.slice(0,-1);p.truncation.returned=p.text.length;
    value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES) return value;
  }
  const lists=result.operation==='search'?result.queries.map(q=>q.posts):result.targets.flatMap(t=>[t.replies.observations,t.quotedPosts]);
  for(const list of lists) {
    const entries=[...list];let lo=0,hi=entries.length;
    while(lo<hi) {const mid=Math.ceil((lo+hi)/2);list.splice(0,list.length,...entries.slice(0,mid));if(update().result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES) lo=mid;else hi=mid-1;}
    list.splice(0,list.length,...entries.slice(0,lo));value=update();if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES) return value;
  }
  compactMetadata(result);value=update();
  if(value.result.budgetUsage.outputBytes<=X_RESEARCH_MAX_OUTPUT_BYTES) return value;
  // The factory's required-state admission prevents this branch for supported
  // production source bounds. Reject unsupported direct helper callers clearly.
  throw new Error('x_research: retained result metadata exceeds 1 MiB required-state envelope');
}
