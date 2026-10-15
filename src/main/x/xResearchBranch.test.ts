import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { fixture, post, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { searchX } from './xResearchSearch';
import { hydrateXResearchBranch } from './xResearchBranch';
import { XResearchEvidence } from './xResearchEvidence';
import { XResearchScopeLedger } from './xResearchScopeFacts';
const entry=(details:unknown,id='call')=>({id:'entry-'+id,type:'message',message:{role:'toolResult',toolName:'x_research',toolCallId:id,isError:false,details}});
it('restores only referenced branch artifacts, reports corruption and retains valid details evidence subset and old history',async()=>{
 const store=tempXArtifactStore();
 const full=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},fixture([searchHtml(post()+post('456','bob','second body'))]).context);
 const artifact=await store.write(full);
 const projected=structuredClone(full);projected.queries[0].posts=projected.queries[0].posts.slice(0,1);
 const branch=[entry({...projected,artifact})];
 const restored=await hydrateXResearchBranch(branch,store);
 const evidence=new XResearchEvidence('/tmp',()=> 'run');evidence.restore(restored.entries);
 expect(evidence.observations.map(p=>p.text)).toEqual(['original','second body']);
 expect(restored.failures).toEqual([]);
 expect(branch[0].message.details).toEqual({...projected,artifact});
 // A sibling branch has no authority to discover A's existing files.
 evidence.restore((await hydrateXResearchBranch([],store)).entries);
 expect(evidence.observations).toHaveLength(0);
 const bad=structuredClone(branch);(bad[0].message.details as any).queries[0].posts.push({text:'invalid body'});
 const manifest=JSON.parse(await fs.readFile(store.displayPath(artifact),'utf8'));
 manifest.sha256='0'.repeat(64);await fs.writeFile(store.displayPath(artifact),JSON.stringify(manifest));
 const missing=await hydrateXResearchBranch(bad,store);
 expect(missing.failures).toEqual([{callId:'call',reason:'integrity'}]);
 expect(missing.entries[0]).toMatchObject({message:{details:{restoration:{status:'missing',reason:'integrity'}}}});
 evidence.restore(missing.entries);expect(evidence.observations.map(p=>p.text)).toEqual(['original']);
 const scope=new XResearchScopeLedger();scope.restore(missing.entries);
 expect(scope.prior('run').withCurrent({...full,callId:'next'})).toMatchObject({callCount:1,unavailableCallCount:1});
 const old=await hydrateXResearchBranch([entry(full)],store);evidence.restore(old.entries);
 expect(evidence.observations.map(p=>p.text)).toEqual(['original','second body']);
});
it('rejects mismatched tool call and artifact identity before granting full evidence',async()=>{
 const store=tempXArtifactStore(),full=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},fixture([searchHtml(post())]).context);
 const artifact=await store.write(full);
 expect((await hydrateXResearchBranch([entry({...full,artifact})],store)).entries[0]).toMatchObject({message:{details:{queries:[{posts:[{text:'original'}]}]}}});
 for(const bad of [entry({...full,artifact},'other'),entry({...full,artifact:{...artifact,batchId:'other'}})]){
  const result=await hydrateXResearchBranch([bad],store);
  expect(result.failures).toHaveLength(1);
  const evidence=new XResearchEvidence('/tmp',()=> 'run');evidence.restore(result.entries);
  expect(evidence.observations.length).toBe(bad.message.toolCallId==='other'?0:1);
 }
});

it('missing artifact obligation coverage blocks older proof, and a new complete read clears only its exact parent',async()=>{
 const {readX}=await import('./xResearchRead');
 const {readHtml}=await import('../../test-support/xResearchFixture');
 const {serializeXResearchResult}=await import('./xResearchOutput');
 const store=tempXArtifactStore();
 const original=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},fixture([searchHtml(post()+post('456','bob','other parent'))]).context);
 const evidence=new XResearchEvidence('/tmp',()=> 'run');
 evidence.observe(original);expect(evidence.guard('/tmp/report.md','[source](https://x.com/alice/status/123)')).toBeUndefined();
 const later=structuredClone(original);later.callId='later';later.objective='x'.repeat(600000);
 later.queries[0].posts=Array.from({length:100},(_,i)=>({...structuredClone(original.queries[0].posts[i%2]),observationId:`body-${i}`,articlePreviews:Array.from({length:20},(_,j)=>({entryObservationId:`entry-${i}-${j}`,parentPostId:i%2?'456':'123',sourceUrl:i%2?'https://x.com/bob/status/456':'https://x.com/alice/status/123',targetUrl:`https://x.com/carol/status/${1000+i*20+j}`})),articlePreviewInventory:{scope:'collection' as const,observed:20,retained:20,omitted:0,unresolved:0}}));
 const artifact=await store.write(later);
 const projected=serializeXResearchResult({...later,artifact}).result;
 expect(projected.delivery!.omittedObservations).toBeGreaterThan(0);
 expect(projected.delivery!.articleObligationCoverage).toBe('not_inline');
 await fs.unlink(store.displayPath(artifact));
 // Retain only earlier bodies in details to isolate the unknown omitted-parent obligation.
 const omitted={...projected,queries:[{...projected.queries[0],posts:[]}]};
 const restored=await hydrateXResearchBranch([entry(original),entry(omitted,'later')],store);
 evidence.restore(restored.entries);
 expect(()=>evidence.guard('/tmp/report.md','[source](https://x.com/alice/status/123)')).toThrow('restoration');
 const fresh=await readX({tabId:'tab',read:{objective:'resolve',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:true,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},fixture([readHtml(post())]).context);
 evidence.observe({...fresh,callId:'new-proof'});
 expect(evidence.guard('/tmp/report.md','[source](https://x.com/alice/status/123)')).toBeUndefined();
 expect(()=>evidence.guard('/tmp/report.md','[source](https://x.com/bob/status/456)')).toThrow('restoration');
 // Identical missing-body count with known inline obligation coverage creates no unknown gap.
 evidence.restore([entry(original),entry({...omitted,restoration:{status:'missing',reason:'read'},delivery:{...omitted.delivery!,articleObligationCoverage:'inline'}},'later')]);
 expect(evidence.guard('/tmp/report.md','[source](https://x.com/bob/status/456)')).toBeUndefined();
 // Missing old delivery coverage is unknown, but only its associated run/evidence is affected.
 evidence.restore([entry({...original,runId:'older-run'}),entry({...omitted,runId:'older-run',restoration:{status:'missing',reason:'read'},delivery:{...omitted.delivery!,articleObligationCoverage:undefined}},'later')]);
 expect(()=>evidence.guard('/tmp/report.md','[source](https://x.com/bob/status/456)')).toThrow('restoration');
 const unrelated=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},fixture([searchHtml(post('789','carol','fresh current evidence'))]).context);
 evidence.observe(unrelated);
 expect(evidence.guard('/tmp/report.md','[source](https://x.com/carol/status/789)')).toBeUndefined();
});

it('restores failed persistence as missing with verified subset, instead of treating new delivery as legacy',async()=>{
 const store=tempXArtifactStore();
 const full=await searchX({...searchInput,search:{...searchInput.search,maxScrollsPerQuery:0}},fixture([searchHtml(post())]).context);
 const evidence=new XResearchEvidence('/tmp',()=> 'run');evidence.observe(full);
 expect(evidence.guard('/tmp/report.md','[source](https://x.com/alice/status/123)')).toBeUndefined();
 const failed={...full,delivery:{truncated:true,omittedObservations:1,omittedFields:['queries.0.posts'],artifactPath:null,persistence:'failed' as const,failureCode:'write' as const,articleObligationCoverage:'not_inline' as const}};
 const hydrated=await hydrateXResearchBranch([entry(failed)],store);
 expect(hydrated.failures).toEqual([{callId:'call',reason:'write'}]);
 expect(hydrated.entries[0]).toMatchObject({message:{details:{restoration:{status:'missing',reason:'write'},delivery:{persistence:'failed'}}}});
 evidence.restore(hydrated.entries);
 expect(evidence.observations[0].text).toBe('original');
 expect(()=>evidence.guard('/tmp/report.md','[source](https://x.com/alice/status/123)')).toThrow('restoration');
});
