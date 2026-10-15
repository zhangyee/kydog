import { expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { fixture, post, readHtml } from '../../test-support/xResearchFixture';
import * as reader from '../x/xResearchRead';
import { createXResearchTool } from './xResearchTool';
import { XResearchEvidence } from '../x/xResearchEvidence';
import { hydrateXResearchBranch } from '../x/xResearchBranch';
import { serializeXResearchResult } from '../x/xResearchOutput';
import type { XResearchResult } from '../x/xResearchTypes';

const entry = (details: XResearchResult) => ({type:'message',message:{role:'toolResult',toolName:'x_research',toolCallId:details.callId,isError:false,details}});
it.each([500,1000])('delivers twenty targets with %i Article gaps through persistence and the live ledger', async count => {
  const store = tempXArtifactStore(), f = fixture([readHtml(post('1000000','ReadAuthor','ordinary earlier body'))]);
  const ledger = new XResearchEvidence('/tmp',()=> 'run');
  let canonical: XResearchResult | undefined;
  const tool = createXResearchTool({artifacts:store,browser:f.context.browser,threadId:'thread',sources:f.context.sources,currentRunId:()=> 'run',observeResult:r=>{canonical=r;ledger.observe(r);}});
  const baseline = await tool.execute('baseline',{tabId:'tab',read:{objective:'baseline',targets:[{url:'https://x.com/ReadAuthor/status/1000000'}],includeArticle:false,includeReplies:false}},undefined,undefined,{} as never);
  expect(ledger.guard('/tmp/report.md','[source](https://x.com/ReadAuthor/status/1000000)')).toBeUndefined();
  // Resource-pressure derivation at the collector boundary: unchanged supported
  // gap shape, twenty distinct targets, empty-body carriers retained as gaps.
  const spy = vi.spyOn(reader,'readX').mockImplementationOnce(async (input,context) => {
    expect(input.read.maxRepliesPerPost).toBe(count);
    const result = reader.readResult(input,context); result.status='partial';
    result.targets.forEach((row,t)=>{
      row.status='partial';row.reason='reply_budget_reached';row.stopReason='budget_reached';
      row.collectionStop={status:'partial',reason:row.reason,stopReason:row.stopReason};
      row.budgetUsage.distinctEntries=count;row.sampleTruncation={observed:count,sampled:count,omitted:0};
      row.budgetBinding=[{dimension:'replies',used:count,limit:count,origin:count===500?'default':'explicit'}];
      row.replies.scope.stopReason='budget_reached';
      row.unscopedPosts={observations:[],collection:{kind:'network',provenance:{leaseId:'lease'+t,requestRef:'request'+t,navigationId:'nav',documentEpoch:1,routeRevision:0,navigationSequence:1,operation:'TweetDetail',observedAt:'2026-10-16T00:00:00Z'}},inventory:{scope:'collection',observed:count,retained:0,omitted:count,sourceInventoryTruncated:false,excludedNestedQuotes:0},previewGaps:Array.from({length:count},(_,i)=>({sourceUrl:`https://x.com/ReadAuthor/status/${1000000+t*1000+i}`,unresolved:1}))};
    });
    return result;
  });
  let delivered;
  try { delivered=await tool.execute('gaps',{tabId:'tab',read:{objective:'gap pressure',targets:Array.from({length:20},(_,i)=>({url:`https://x.com/ReadAuthor/status/${9000+i}`})),includeArticle:false,includeReplies:true,...(count===1000?{maxRepliesPerPost:1000}:{})}},undefined,undefined,{} as never); }
  finally {spy.mockRestore();}
  const details=delivered.details!;
  expect(Buffer.byteLength(JSON.stringify(delivered))).toBeLessThanOrEqual(1048576);
  expect(details.delivery).toMatchObject({persistence:'saved',truncated:true,articleObligationCoverage:'not_inline'});
  expect(details.artifact).toBeTruthy();
  expect(canonical?.callId).toBe('gaps');
  const saved=await store.read(details.artifact!);
  expect(saved).toEqual(canonical);
  if(saved.operation!=='read'||details.operation!=='read')throw Error('read');
  expect(saved.targets.map(r=>r.unscopedPosts!.previewGaps.length)).toEqual(Array(20).fill(count));
  for(const [i,row] of details.targets.entries()) {
    expect(row.collectionStop).toEqual(saved.targets[i].collectionStop);
    expect(row.sampleTruncation).toEqual(saved.targets[i].sampleTruncation);
    expect(row.budgetBinding).toEqual(saved.targets[i].budgetBinding);
    expect(row.unscopedPosts!.inventory).toEqual(saved.targets[i].unscopedPosts!.inventory);
    if(row.unscopedPosts!.previewGaps.length<count)expect(details.delivery!.omittedFields).toContain(`targets.${i}.unscopedPosts.previewGaps`);
  }
  expect(()=>ledger.guard('/tmp/report.md','[source](https://x.com/ReadAuthor/status/1000000)')).toThrow(/inventory/);
  expect(serializeXResearchResult(details).result).toEqual(details);
  const branch=[entry(baseline.details!),entry(details)];
  const restored=await hydrateXResearchBranch(branch,store);
  expect(restored.failures).toEqual([]);
  const fresh=new XResearchEvidence('/tmp',()=> 'run');fresh.restore(restored.entries);
  expect(()=>fresh.guard('/tmp/report.md','[source](https://x.com/ReadAuthor/status/1000000)')).toThrow(/inventory/);
  // Every unavailable-artifact route must retain the unknown-obligation block.
  for(const failure of ['missing','corrupt','failed_write','no_ref'] as const){
    const unavailable=structuredClone(details);
    if(failure==='corrupt')await fs.writeFile(store.displayPath(details.artifact!),'{}');
    if(failure==='missing')await fs.rm(store.displayPath(details.artifact!));
    if(failure==='failed_write'){delete unavailable.artifact;unavailable.delivery!.persistence='failed';unavailable.delivery!.failureCode='write';}
    if(failure==='no_ref')delete unavailable.artifact;
    fresh.restore((await hydrateXResearchBranch([entry(baseline.details!)],store)).entries);
    expect(fresh.guard('/tmp/report.md','[source](https://x.com/ReadAuthor/status/1000000)')).toBeUndefined();
    const missing=await hydrateXResearchBranch([entry(baseline.details!),entry(unavailable)],store);
    expect(missing.failures).toHaveLength(1);fresh.restore(missing.entries);
    expect(()=>fresh.guard('/tmp/report.md','[source](https://x.com/ReadAuthor/status/1000000)')).toThrow(/Article|artifact|coverage/);
  }
});
