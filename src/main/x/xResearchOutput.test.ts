import { describe, expect, it } from 'vitest';
import { fixture, post, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { readX } from './xResearchRead';
import { readHtml } from '../../test-support/xResearchFixture';
import { searchX, searchResult } from './xResearchSearch';
import { assertXRequestFits, serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
import { X_RESEARCH_MAX_OUTPUT_BYTES } from './xResearchTypes';
describe('bounded X production tool result',()=>{
  it('counts exact combined JSON envelope, including escaped text and v2 details',async()=>{
    const result=await searchX(searchInput,fixture([searchHtml(post())]).context);
    const serialized=serializeXResearchResult(result);
    const bytes=Buffer.byteLength(JSON.stringify(xResearchToolResult(serialized)),'utf8');
    expect(serialized.result.budgetUsage.outputBytes).toBe(bytes);
    const row=serialized.result.queries[0];
    const rowJson=JSON.stringify(row);
    expect(row.budgetUsage.outputBytes).toBe(Buffer.byteLength(rowJson)+Buffer.byteLength(JSON.stringify(rowJson))-2);
    expect(serialized.result.truncation.truncated).toBe(false);
    expect(JSON.parse(serialized.text)).toEqual(serialized.result);
    const original=result.queries[0].posts[0];
    original.text='汉字\\"'.repeat(100000);
    original.truncation={returned:original.text.length,totalKnown:original.text.length,truncated:false};
    const capped=serializeXResearchResult(result);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(capped.result.truncation).toMatchObject({truncated:true,totalKnown:original.text.length});
    expect(capped.result.queries[0].posts[0].truncation).toMatchObject({truncated:true,totalKnown:original.text.length});
    expect(capped.result.queries[0]).toMatchObject({query:searchInput.search.queries[0],status:'partial',stopReason:'budget_reached'});
    expect(original.text.length).toBe(400000);
  });
  it('exact boundary admitted; one byte over is reduced while all request records survive',async()=>{
    const result=await searchX(searchInput,fixture([searchHtml(post())]).context);
    const body=result.queries[0].posts[0]; body.text='a'.repeat(600000);body.truncation={returned:600000,totalKnown:600000,truncated:false};
    const capped=serializeXResearchResult(result);
    const bytes=Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)),'utf8');
    expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(X_RESEARCH_MAX_OUTPUT_BYTES-bytes).toBeLessThan(5);
    const again=serializeXResearchResult(capped.result);
    expect(again).toEqual(capped);
    expect(capped.result.queries).toHaveLength(1);
    const over=structuredClone(capped.result);
    over.queries[0].posts[0].text+='a';over.queries[0].posts[0].truncation.returned++;
    const overJson=JSON.stringify(over);
    expect(Buffer.byteLength(JSON.stringify({content:[{type:'text',text:overJson}],details:over}))).toBeGreaterThan(X_RESEARCH_MAX_OUTPUT_BYTES);
    const recapped=serializeXResearchResult(over);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(recapped)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(recapped.result.queries[0].posts[0].text.length).toBe(capped.result.queries[0].posts[0].text.length);
  });
  it('prunes secondary metadata while preserving every failed target and root identity',async()=>{
    const f=fixture([readHtml(post())]);
    const result=await readX({tabId:'tab',read:{objective:'read',targets:[{url:'https://x.com/alice/status/123'},{postId:'999'}],includeArticle:false,includeReplies:false,maxRepliesPerPost:100,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},f.context);
    const root=result.targets[0].root!;
    result.targets[0].replies.observations=Array.from({length:2000},(_,i)=>({...root,postId:String(i+1000),observationId:`reply-${i}`,text:'',author:{handle:'a'.repeat(1000),displayName:null,profileUrl:null},containerKind:'reply' as const,truncation:{returned:0,totalKnown:0,truncated:false}}));
    expect(serializeXResearchResult({...result,targets:result.targets.map(t=>({...t,replies:{...t.replies,observations:t.replies.observations.slice(0,1)}}))}).result.truncation.truncated).toBe(false);
    const value=serializeXResearchResult(result);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(value)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(value.result.targets).toHaveLength(2);
    expect(value.result.targets[0].root).toMatchObject({postId:'123',sourceUrl:'https://x.com/alice/status/123'});
    expect(value.result.targets[1]).toMatchObject({postId:'999',status:'failed',reason:'unresolved_target',stopReason:'agent_stopped'});
    expect(value.result.truncation.truncated).toBe(true);
    expect(value.result.targets[0].replies.observations.length).toBeLessThan(2000);
  });
  it('exact full boundary survives real tab/state growth through declared projection without losing requests',()=>{
    const f=fixture([searchHtml(post())]);const input=structuredClone(searchInput);
    let lo=0,hi=600000;
    while(lo<hi) {const mid=Math.ceil((lo+hi)/2);input.search.objective='a'.repeat(mid);const value=serializeXResearchResult(searchResult(input,f.context));if(!value.result.contentProjection) lo=mid;else hi=mid-1;}
    input.search.objective='a'.repeat(lo);const result=searchResult(input,f.context);
    const full=serializeXResearchResult(result);expect(full.result.budgetUsage.outputBytes).toBe(X_RESEARCH_MAX_OUTPUT_BYTES);
    assertXRequestFits(result);result.browserTabId='tab_12345678';result.queries[0].status='partial';result.queries[0].stopReason='budget_reached';
    const projected=serializeXResearchResult(result);expect(projected.result.contentProjection).toBe('x_research_projection_v1');expect(JSON.parse(projected.text).contentProjection).toBe('x_research_projection_v1');
    expect(projected.result.objective).toBe(input.search.objective);expect(projected.result.queries[0]).toMatchObject({query:input.search.queries[0],status:'partial',stopReason:'budget_reached'});
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(projected)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
  });
  it('Unicode text shortening never introduces half a surrogate pair',async()=>{
    const result=await searchX(searchInput,fixture([searchHtml(post())]).context),body=result.queries[0].posts[0];body.text='😀'.repeat(400000);body.truncation={returned:body.text.length,totalKnown:body.text.length,truncated:false};
    const out=serializeXResearchResult(result);expect(out.result.queries[0].posts[0].text.endsWith('\uD83D')).toBe(false);expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)))).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);expect(out.result.queries[0].posts[0].truncation.totalKnown).toBe(800000);
  });
});
