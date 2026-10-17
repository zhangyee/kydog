import {replyScopeSchema,networkPageSchema,networkReadScopeValid} from './xResearchCanonical';
import { z } from 'zod';
import type { XReportScopeFacts, XReportRunScopeFacts, XResearchResult } from './xResearchTypes';

const text = z.string().min(1);
const status = z.enum(['observed','partial','explicit_empty','auth_required','action_required','rate_limited','access_denied','unavailable','cancelled','failed']);
const stop = z.enum(['explicit_ui_end','source_unavailable','cursor_exhausted','budget_reached','action_failed','navigation_failed','identity_unproven','wait_timeout','access_barrier','cancelled','agent_stopped']);
const barrier = z.object({status,reason:z.string(),observationId:text.nullable()}).nullable();
const scope=replyScopeSchema;
const identity = z.object({schemaVersion:z.literal(2),sourceKind:z.enum(['rendered_ui','page_graphql','mixed']),runId:text,callId:text});
const base = {...identity.shape,batchId:text};
// Validate only canonical scope source fields. Body/diagnostic validation belongs
// to the evidence ledger; this independent bookkeeping cannot authorize evidence.
const scopeResult = z.discriminatedUnion('operation',[
  z.object({...base,operation:z.literal('search'),queries:z.array(z.object({
    query:z.object({id:text,query:text,purpose:text,product:z.enum(['Top','Latest'])}),
    status,stopReason:stop,barrier,posts:z.array(z.unknown()),
  })).min(1).max(6)}),
  z.object({...base,operation:z.literal('read'),targets:z.array(z.object({
    postId:z.string().nullable().optional(),networkPages:z.array(networkPageSchema).optional(),
    target:z.union([z.object({postId:text}).strict(),z.object({url:text}).strict()]),
    status,stopReason:stop,reason:z.string().nullable(),
    root:z.object({}).nullable(),quotedPosts:z.array(z.object({})),
    article:z.object({requested:z.boolean(),entryObserved:z.boolean(),actionAttempted:z.boolean(),navigationStarted:z.boolean(),bodyObserved:z.boolean(),entry:z.object({}).nullable(),body:z.object({}).nullable(),barrier}),
    replies:z.object({requested:z.boolean(),observations:z.array(z.unknown()),scope}),
  }).refine(networkReadScopeValid)).min(1).max(20)}),
]);
type ParsedScopeResult = z.infer<typeof scopeResult>;
type ScopeResult =
  | {operation:'search'; queries:Pick<Extract<ParsedScopeResult,{operation:'search'}>['queries'][number],'status'|'stopReason'|'barrier'>[]}
  | {operation:'read'; targets:Pick<Extract<ParsedScopeResult,{operation:'read'}>['targets'][number],'status'|'stopReason'|'reason'|'replies'>[]};

// Only protocol-controlled, finite reason labels enter the aggregate. Search
// barriers can contain localized page text, so all other values count as unknown.
const REPORT_REASONS = new Set([
  'scroll_no_movement', 'scroll_ack_timeout',
  'post_identity_unproven', 'reply_readiness_timeout',
  'action_failed:browser.click_intercepted',
  'not_attempted', 'cancelled', 'unsafe_target_url', 'unresolved_target',
  'auth_required', 'unsupported_document_route',
  'direct_article_discussion_unobserved', 'post_wait_timeout',
  'parent_return_identity_unproven', 'parent_return_navigation_failed',
  'body_expand_budget_reached', 'reply_budget_reached',
  'body_expand_control_unchanged', 'replies_expand_control_unchanged',
  'body_observations_output_budget', 'article_inventory_audit_output_budget',
  'navigation_failed', 'not_attempted:auth_required',
  'not_attempted:navigation_failed', 'not_attempted:rate_limited', 'internal_adapter_stopped',
  'article_body_wait_timeout', 'article_budget_reached', 'article_navigation_failed', 'no_entry_observed',
  'action_failed:browser.wait_timeout', 'navigation_failed:browser.no_tab',
  // `source_unavailable:<reason>` specifics a read row can carry.
  'lease_missing', 'network_cleanup_failed', 'generation_changed', 'cursor_not_advanced',
  'cursor_chain_mismatch', 'decode_failed', 'invalid_json', 'request_changed',
  'accept_failed', 'body_limit', 'loading_failed', 'body_unavailable', 'enable_failed',
  'tab_closed', 'crashed', 'detached', 'superseded', 'closed',
  'collection_failed:browser.not_dispatchable',
  'omitted_due_output_budget',
]);
export function reportScopeFacts(result: ScopeResult): XReportScopeFacts {
  const facts: XReportScopeFacts = {
    version: 1, operation: result.operation,
    reasonSource: result.operation === 'search' ? 'barrier.reason' : 'reason',
    totalRows: result.operation === 'search' ? result.queries.length : result.targets.length,
    statusCounts: {}, stopReasonCounts: {}, reasonCounts: {}, replyScopeCounts: {},
  };
  const count = (counts: Record<string, number>, key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const countRow = (row: {status: keyof XReportScopeFacts['statusCounts']; stopReason: keyof XReportScopeFacts['stopReasonCounts']}, reason: string | null | undefined) => {
    count(facts.statusCounts, row.status);
    count(facts.stopReasonCounts, row.stopReason);
    count(facts.reasonCounts, reason && REPORT_REASONS.has(reason) ? reason : 'unknown');
  };
  if (result.operation === 'search') {
    for (const row of result.queries) countRow(row, row.barrier?.reason);
  } else {
    for (const row of result.targets) {
      countRow(row, row.reason);
      count(facts.replyScopeCounts, 'kind' in row.replies.scope?row.replies.scope.extent:row.replies.scope.completeness);
    }
  }
  return facts;
}


type Call = {fingerprint:string; facts:XReportScopeFacts} | null;
/** 壳（`./xResearchTaskShell`）→ `delivery.result`；改造前的平铺 details → 原样。
 *  `null` = 这个壳没有结果（`submit` / `inspect` / `cancel`）：它没有可入账的调用。 */
function deliveryResult(details:unknown):unknown|null {
  if(!details||typeof details!=='object')return details;
  const value=details as {kind?:unknown;delivery?:{result?:unknown}};
  return value.kind==='x_research'?value.delivery?.result??null:details;
}
/** 这条工具结果属于哪一轮调用：平铺 details 说的是自己的 `callId`，壳说的是**交付**那一轮
 *  （`delivery.deliveryCallId`）—— 壳里的 `result.callId` 是**提交**那一轮，
 *  拿它比 `toolCallId` 永远不相等。 */
function resultCallId(details:unknown):unknown {
  if(!details||typeof details!=='object')return null;
  const value=details as {kind?:unknown;callId?:unknown;delivery?:{deliveryCallId?:unknown}};
  return value.kind==='x_research'?value.delivery?.deliveryCallId??null:value.callId??null;
}
/** 壳自己的两轮也得对得上：`result.callId` 是提交那一轮，必须等于壳记下的 `submitCallId`。
 *  与恢复链（`./xResearchBranch`）同一条判据 —— 只认「交付那一轮」的话，一份壳能借另一份
 *  提交的结果入账。平铺 details 没有这层壳，放行。 */
function shellChainValid(details:unknown):boolean {
  if(!details||typeof details!=='object')return true;
  const value=details as {kind?:unknown;delivery?:{submitCallId?:unknown;result?:{callId?:unknown}|null}};
  if(value.kind!=='x_research')return true;
  return value.delivery?.result?.callId===value.delivery?.submitCallId;
}
function call(raw:unknown):Call {
  if(raw && typeof raw==='object' && 'restoration' in raw &&
     (raw.restoration as {status?:unknown})?.status==='missing') return null;
  const parsed=scopeResult.safeParse(raw);
  if(!parsed.success)return null;
  const value=parsed.data;
  // Keep row identity/order and exact scope source facts, excluding bodies and
  // derived summaries/bytes. Equivalent aggregate totals alone do not dedupe.
  const rows=value.operation==='search'
    ? value.queries.map(({query,status,stopReason,barrier})=>({query,status,stopReason,barrier}))
    : value.targets.map(({target,status,stopReason,reason,replies})=>({target,status,stopReason,reason,replies:{requested:replies.requested,scope:replies.scope}}));
  return {fingerprint:JSON.stringify({batchId:value.batchId,operation:value.operation,rows}),facts:reportScopeFacts(value)};
}
function add(calls:Map<string,Call>,id:string,value:Call):void {
  if(!calls.has(id))calls.set(id,value);
  else if(calls.get(id)?.fingerprint!==value?.fingerprint)calls.set(id,null);
}
function empty(operation:'search'|'read'):XReportScopeFacts {
  return {version:1,operation,reasonSource:operation==='search'?'barrier.reason':'reason',totalRows:0,statusCounts:{},stopReasonCounts:{},reasonCounts:{},replyScopeCounts:{}};
}
function aggregate(runId:string,calls:ReadonlyMap<string,Call>):XReportRunScopeFacts {
  const result:XReportRunScopeFacts={version:1,runId,callCount:0,unavailableCallCount:0,search:empty('search'),read:empty('read')};
  for(const value of calls.values()) {
    if(!value){result.unavailableCallCount++;continue;}
    result.callCount++;
    const target=result[value.facts.operation];target.totalRows+=value.facts.totalRows;
    for(const field of ['statusCounts','stopReasonCounts','reasonCounts','replyScopeCounts'] as const){
      const counts:Record<string,number>=target[field];
      for(const [key,n] of Object.entries(value.facts[field]))counts[key]=(counts[key]??0)+n;
    }
  }
  return result;
}
/** Only the main-process ledger supplies this snapshot to the serializer. */
export interface XResearchScopePrior {withCurrent(result:XResearchResult):XReportRunScopeFacts}
export class XResearchScopeLedger {
  private runs=new Map<string,Map<string,Call>>();
  observe(result:unknown):void {
    const id=identity.safeParse(result);if(!id.success)return;
    let calls=this.runs.get(id.data.runId);
    if(!calls){calls=new Map();this.runs.set(id.data.runId,calls);}
    add(calls,id.data.callId,call(result));
  }
  restore(entries:readonly unknown[]):void {
    this.runs.clear();
    const envelope=z.object({type:z.literal('message'),message:z.object({role:z.literal('toolResult'),toolName:z.literal('x_research'),toolCallId:text,isError:z.literal(false),details:z.unknown()})});
    for(const entry of entries){
      const parsed=envelope.safeParse(entry);if(!parsed.success)continue;
      const details=deliveryResult(parsed.data.message.details);if(details===null)continue;
      // 壳自己的两轮对不上：恢复链不收它的结果，账本也不收 —— 否则一份错壳能入账。
      if(!shellChainValid(parsed.data.message.details))continue;
      const id=identity.safeParse(details);
      if(!id.success||resultCallId(parsed.data.message.details)!==parsed.data.message.toolCallId)continue;
      this.observe(details);
    }
  }
  prior(runId:string):XResearchScopePrior {
    const snapshot=new Map(this.runs.get(runId));
    return {withCurrent(result){
      if(result.runId!==runId)throw new Error('X research scope prior belongs to a different run');
      const calls=new Map(snapshot);add(calls,result.callId,call(result));
      return aggregate(runId,calls);
    }};
  }
}
