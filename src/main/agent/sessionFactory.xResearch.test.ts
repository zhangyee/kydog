import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { SessionManager, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { fixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { KydogError } from '../../shared/errors';
import { SEQUENTIAL_TOOL_NAMES } from './askSequentialTools';
const H=vi.hoisted(()=>({enabled:true,port:null as any,production:[] as ToolDefinition[],fixture:[] as ToolDefinition[],created:[] as ToolDefinition[]}));
vi.mock('../settings/settingsService',()=>({settingsService:{get:async()=>({ui:{locale:'en'},institution:null,research:{xResearchEnabled:H.enabled}})},toInstitutionPublic:()=>null}));
vi.mock('../browser/browserService',()=>({browserService:{}}));
vi.mock('../browser/loginFlow',()=>({loginFlow:{noteFor:()=>null}}));
vi.mock('../x/xResearchBrowser',()=>({createXResearchBrowser:()=>H.port}));
vi.mock('../llm/providerRegistry',()=>({getProviderRegistry:()=>({modelRuntime:{getModel:()=>({id:'test'})}})}));
vi.mock('../skills/skillResourceLoader',()=>({createKydogResourceLoader:async()=>({reload:async()=>{}})}));
vi.mock('@earendil-works/pi-coding-agent',async original=>({...await original<any>(),createAgentSession:async(o:any)=>{H.production=o.customTools;return {session:{sessionManager:o.sessionManager,prompt:async()=>{},abort:()=>{},subscribe:()=>()=>{}}};}}));
vi.mock('./fixtureProvider',async original=>{const real=await original<typeof import('./fixtureProvider')>();return {...real,createFixtureSession:async(...args:Parameters<typeof real.createFixtureSession>)=>{H.fixture=args[4] as ToolDefinition[];return real.createFixtureSession(...args);}};});
vi.mock('./xResearchTool',async original=>{const real=await original<typeof import('./xResearchTool')>();return {...real,createXResearchTool:(...args:Parameters<typeof real.createXResearchTool>)=>{const tool=real.createXResearchTool(...args);H.created.push(tool as unknown as ToolDefinition);return tool;}};});
const {createSession}=await import('./sessionFactory');
let dir:string,scriptPath:string,run:string|null;
let f:ReturnType<typeof fixture>;
beforeEach(async()=>{dir=await mkdtemp(path.join(os.tmpdir(),'kydog-x-catalog-'));scriptPath=path.join(dir,'script.json');await writeFile(scriptPath,JSON.stringify({events:[]}));H.enabled=true;H.created=[];run='protocol-run-one';f=fixture([searchHtml(post())]);H.port=f.context.browser;});
afterEach(async()=>{delete process.env.KYDOG_AGENT_FIXTURE;await rm(dir,{recursive:true,force:true});});
async function build(mode:'fixture'|'production'='fixture'){
 if(mode==='fixture')process.env.KYDOG_AGENT_FIXTURE=scriptPath;else delete process.env.KYDOG_AGENT_FIXTURE;
 return createSession({cwd:dir,sessionsDir:path.join(dir,'sessions'),sessionId:'thread',providerId:'anthropic',modelId:'test',askShared:{onOpened:()=>{},onClosed:()=>{}},currentRunId:()=>run});
}
async function execute(session:Awaited<ReturnType<typeof build>>,name:string,args:unknown,id=name){
 await writeFile(scriptPath,JSON.stringify({events:[{type:'tool',after_ms:0,toolCallId:id,name,args},{type:'agent_end',after_ms:0,reason:'completed'}]}));
 const events:any[]=[];const off=session.subscribe(e=>events.push(e));await session.prompt(id);off();return events.find(e=>e.type==='tool_execution_end');
}
it('oneToolCatalogForProductionAndFixture uses each exact created object with the same complete file/catalog and sequential policy',async()=>{
 for(const mode of ['production','fixture'] as const){
  await build(mode);const catalog=H[mode];expect(catalog.filter(t=>t.name==='x_research')).toEqual([H.created.at(-1)]);
  for(const name of ['read','write','edit','read_pdf_figure','read_docx'])expect(catalog.filter(t=>t.name===name)).toHaveLength(1);
  expect(catalog.filter(t=>t.executionMode==='sequential').map(t=>t.name).sort()).toEqual([...SEQUENTIAL_TOOL_NAMES].sort());
  H.enabled=false;await build(mode);expect(H[mode].some(t=>t.name==='x_research')).toBe(false);H.enabled=true;
 }
});
it('actual canonical execution persists through SDK branch and disable/enable generations, retaining owned tab and source guards',async()=>{
 let session=await build();const starts:number[]=[];session.subscribe(e=>{if(e.type==='agent_start')starts.push(session.state!.messages.length);});
 const search=await execute(session,'x_research',searchInput,'actual-search');expect(search.isError).toBe(false);
 expect(search.result.details).toMatchObject({runId:'protocol-run-one',callId:'actual-search'});expect(starts).toEqual([0]);
 const markdown='Original [source](https://x.com/alice/status/123)';
 const saved=await execute(session,'write',{path:'x-research-test-2026-10-13.md',content:markdown},'save');expect(saved.isError).toBe(false);
 expect(await readFile(path.join(dir,'x-research-test-2026-10-13.md'),'utf8')).toBe(markdown);
 expect((await execute(session,'write',{path:'x-research-test-2026-10-13.md',content:'replacement'},'conflict')).isError).toBe(true);
 await session.cleanup?.();H.enabled=false;session=await build();
 expect((await execute(session,'read',{path:'x-research-test-2026-10-13.md'},'read-existing')).result.content[0].text).toContain(markdown);
 expect((await execute(session,'edit',{path:'x-research-test-2026-10-13.md',edits:[{oldText:'Original',newText:'Updated'}]},'edit-existing')).isError).toBe(false);
 H.enabled=true;run='protocol-run-two';session=await build();
 expect((await execute(session,'x_research',searchInput,'restored-search')).result.details.runId).toBe(run);expect(f.open.mock.calls.at(-1)![1]).toBe('research-tab');
 const manager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 const branch=manager.getBranch();const savedResult=branch.find(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolCallId==='actual-search');
 expect(savedResult).toMatchObject({type:'message',message:{details:{callId:'actual-search',sourceKind:'rendered_ui'}}});
 manager.branch(branch[0].id);
 expect((await execute(session,'write',{path:'ordinary.md',content:markdown},'branched-write')).isError).toBe(true);
 expect((await execute(session,'write',{path:'ordinary.md',content:'No citation'},'ordinary-write')).isError).toBe(false);
});
it('a search-only later preview blocks real write until an accurate independent read; no fixture-supplied result oracle',async()=>{
 const card='<div role="link" tabindex="0" href="https://x.com/bob/status/456"><div data-testid="User-Name"><a href="/bob">bob</a><a href="/bob">@bob</a></div><img data-testid="article-cover-image"></div>';
 const plain=post('123','alice','long original body');const withCard=post('123','alice','preview body').replace('</article>',card+'</article>');
 f=fixture([searchHtml(plain),searchHtml(withCard)]);H.port=f.context.browser;const session=await build();
 const r=await execute(session,'x_research',searchInput,'discover');expect(r.result.details.queries[0].posts[0].text).toBe('long original body');expect(r.result.details.queries[0].postObservations[0].articlePreviews).toHaveLength(1);
 const args={path:'x-research-preview-2026-10-13.md',content:'[Source](https://x.com/alice/status/123)'};
 expect((await execute(session,'write',args,'blocked')).result.content[0].text).toContain('accurate entry');
 const read=fixture([readHtml(withCard)],{scrollError:new KydogError('browser.target_unusable','real safety rejection')});
 // Same production tool object, new actual source operation through the retained port.
 f.open.mockImplementation(read.open.getMockImplementation()!);(H.port.withPage as any).mockImplementation(read.context.browser.withPage);
 const attempt=await execute(session,'x_research',{tabId:'research-tab',read:{objective:'read exact entry',targets:[{url:'https://x.com/alice/status/123'}],includeReplies:false}},'accurate-attempt');
 expect(attempt.result.details.targets[0].article.actionAttempted).toBe(true);
 expect((await execute(session,'write',args,'saved')).isError).toBe(false);
 run=null;expect((await execute(session,'x_research',searchInput,'idle')).isError).toBe(true);
});

it('settled branch baseline includes the last actual result before branching to its exact assistant parent',async()=>{
 const session=await build();expect((await execute(session,'x_research',searchInput,'last-result')).isError).toBe(false);
 const manager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 const branch=manager.getBranch(),last=branch.at(-1)!;
 expect(last).toMatchObject({type:'message',message:{role:'toolResult',toolCallId:'last-result'}});
 const parentId=last.parentId;
 if(parentId===null) throw new Error('Expected the actual assistant tool-call parent');
 expect(branch.find(entry=>entry.id===parentId)).toMatchObject({type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'last-result',name:'x_research',arguments:searchInput}]}});
 manager.branch(parentId);
 const denied=await execute(session,'write',{path:'ordinary.md',content:'[source](https://x.com/alice/status/123)'},'removed-result');
 expect(denied.isError).toBe(true);expect(denied.result.content[0].text).toContain('unobserved');
});

// Catches missing production ledger wiring, persisted restore, and branch/run leakage.
it('counts only actual current-run calls across SDK persistence and current branch changes',async()=>{
 let session=await build();
 const first=await execute(session,'x_research',searchInput,'scope-first');
 expect(first.isError).toBe(false);
 expect(first.result.details.reportRunScopeFacts).toMatchObject({version:1,runId:run,callCount:1,unavailableCallCount:0,search:{totalRows:1},read:{totalRows:0}});
 const manager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 const firstLeaf=manager.getLeafId()!;
 const second=await execute(session,'x_research',searchInput,'scope-second');
 expect(second.result.details.reportRunScopeFacts).toMatchObject({callCount:2,search:{totalRows:2}});
 expect(JSON.parse(second.result.content[0].text).reportRunScopeFacts).toEqual(second.result.details.reportRunScopeFacts);
 await session.cleanup?.();session=await build();
 const restored=await execute(session,'x_research',searchInput,'scope-third');
 expect(restored.result.details.reportRunScopeFacts).toMatchObject({callCount:3,search:{totalRows:3}});
 const restoredManager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 restoredManager.branch(firstLeaf);
 const sibling=await execute(session,'x_research',searchInput,'scope-sibling');
 expect(sibling.result.details.reportRunScopeFacts).toMatchObject({callCount:2,search:{totalRows:2}});
 run='new-scope-run';
 const nextRun=await execute(session,'x_research',searchInput,'scope-next-run');
 expect(nextRun.result.details.reportRunScopeFacts).toMatchObject({runId:run,callCount:1,search:{totalRows:1}});
 const stored=restoredManager.getBranch().at(-1);
 expect(stored).toMatchObject({type:'message',message:{role:'toolResult',toolCallId:'scope-next-run',details:{reportRunScopeFacts:nextRun.result.details.reportRunScopeFacts}}});
});

it('waits for artifact hydration before guarded writes and discards stale branch reads',async()=>{
 const {fileService}=await import('../fs/fileService');
 const session=await build();
 const result=await execute(session,'x_research',searchInput,'artifact-A');
 expect(result.result.details.delivery.persistence).toBe('saved');
 const manager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 const leafA=manager.getLeafId()!;
 const entryA=manager.getBranch().at(-1)!;
 const leafB=entryA.parentId!;
 const citation='[source](https://x.com/alice/status/123)';
 expect((await execute(session,'write',{path:'positive.md',content:citation},'positive')).isError).toBe(false);
 manager.branch(leafB);
 expect((await execute(session,'write',{path:'negative.md',content:citation},'negative')).isError).toBe(true);
 manager.branch(leafA);
 await writeFile(path.join(dir,'guarded.md'),'original');
 const originalRead=fileService.readBytes.bind(fileService);
 let release!:()=>void,entered!:()=>void;
 const pendingRead=new Promise<void>(resolve=>{release=resolve;});
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const spy=vi.spyOn(fileService,'readBytes').mockImplementation(async args=>{
  if(args.path.endsWith('manifest.json')){entered();await pendingRead;}
  return originalRead(args);
 });
 try {
  const write=H.fixture.find(tool=>tool.name==='write')!;
  const pending=write.execute('pending',{path:'guarded.md',content:citation},undefined,undefined,{} as never);
  const outcome=pending.then(()=> 'saved',error=>String(error));
  await started;
  expect(await readFile(path.join(dir,'guarded.md'),'utf8')).toBe('original');
  manager.branch(leafB);release();
  expect(await outcome).toContain('unobserved');
  expect(await readFile(path.join(dir,'guarded.md'),'utf8')).toBe('original');
  manager.branch(leafA);
  await write.execute('restored',{path:'guarded.md',content:citation},undefined,undefined,{} as never);
  expect(await readFile(path.join(dir,'guarded.md'),'utf8')).toBe(citation);
 } finally {release();spy.mockRestore();}
});

it('reports missing older-run artifacts as bounded current-branch restoration metadata',async()=>{
 let session=await build();
 const first=await execute(session,'x_research',searchInput,'old-artifact');
 expect(first.result.details.delivery.persistence).toBe('saved');
 const manager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 const firstLeaf=manager.getLeafId()!;
 const parent=manager.getBranch().at(-1)!.parentId!;
 await session.cleanup?.();
 await writeFile(first.result.details.delivery.artifactPath,'corrupt');
 run='new-run';session=await build();
 const next=await execute(session,'x_research',searchInput,'new-artifact');
 expect(next.result.details.artifactRestoration).toEqual({scope:'current_branch',missingCalls:1,reasonCounts:{read:1}});
 expect(JSON.parse(next.result.content[0].text).artifactRestoration).toEqual(next.result.details.artifactRestoration);
 expect(next.result.details.reportRunScopeFacts).toMatchObject({runId:'new-run',callCount:1,unavailableCallCount:0});
 const restoredManager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 restoredManager.branch(parent);
 const sibling=await execute(session,'x_research',searchInput,'sibling-artifact');
 expect(sibling.result.details.artifactRestoration).toBeUndefined();
 restoredManager.branch(firstLeaf);
 run='protocol-run-one';
 const sameRun=await execute(session,'x_research',searchInput,'same-run-artifact');
 expect(sameRun.result.details.reportRunScopeFacts).toMatchObject({callCount:1,unavailableCallCount:1});
});
