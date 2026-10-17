import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { SessionManager, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { fixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { KydogError } from '../../shared/errors';
import { SEQUENTIAL_TOOL_NAMES } from './askSequentialTools';
import type { XResearchDeliveryEnvelope } from '../x/xResearchTaskShell';
import { XResearchTaskService, xResearchTaskService } from '../x/xResearchTaskService';

/** 任务目录：单例 service 的 store 根在模块加载时定死，所以整个文件共用一个临时目录。 */
const H = vi.hoisted(() => ({
  enabled: true,
  port: null as any,
  production: [] as ToolDefinition[],
  fixture: [] as ToolDefinition[],
  created: [] as ToolDefinition[],
  taskDir: `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/kydog-x-task-${process.pid}-${Date.now()}`,
}));
vi.mock('../persist/paths', async importOriginal => ({
  ...await importOriginal<typeof import('../persist/paths')>(),
  X_RESEARCH_DIR: H.taskDir,
}));
vi.mock('../settings/settingsService',()=>({settingsService:{get:async()=>({ui:{locale:'en'},institution:null,research:{xResearchEnabled:H.enabled}})},toInstitutionPublic:()=>null}));
vi.mock('../browser/browserService',()=>({browserService:{}}));
vi.mock('../browser/loginFlow',()=>({loginFlow:{noteFor:()=>null}}));
vi.mock('../x/xResearchBrowser',()=>({createXResearchBrowser:()=>H.port}));
vi.mock('../llm/providerRegistry',()=>({getProviderRegistry:()=>({modelRuntime:{getModel:()=>({id:'test'})}})}));
vi.mock('../skills/skillResourceLoader',()=>({createKydogResourceLoader:async()=>({reload:async()=>{}})}));
vi.mock('@earendil-works/pi-coding-agent',async original=>({...await original<any>(),createAgentSession:async(o:any)=>{H.production=o.customTools;return {session:{sessionManager:o.sessionManager,prompt:async()=>{},abort:()=>{},subscribe:()=>()=>{}}};}}));
vi.mock('./fixtureProvider',async original=>{const real=await original<typeof import('./fixtureProvider')>();return {...real,createFixtureSession:async(...args:Parameters<typeof real.createFixtureSession>)=>{H.fixture=args[4] as ToolDefinition[];return real.createFixtureSession(...args);}};});
// 注册交换的唯一证据：会话交进 pi 的那一个工具就是 `createXResearchTools` 造出来的这一个。
vi.mock('./xResearchTools',async original=>{const real=await original<typeof import('./xResearchTools')>();return {...real,createXResearchTools:(...args:Parameters<typeof real.createXResearchTools>)=>{const tool=real.createXResearchTools(...args);H.created.push(tool as unknown as ToolDefinition);return tool;}};});
const {createSession}=await import('./sessionFactory');
/** 真 thread id 的形状：任务 store 按 UUID 校验目录名（`XResearchTaskStore` 的穿越防线）。 */
const THREAD_ID='11111111-1111-4111-8111-111111111111';
let dir:string,scriptPath:string,run:string|null;
let f:ReturnType<typeof fixture>;
beforeEach(async()=>{
  mkdirSync(H.taskDir,{recursive:true});
  dir=await mkdtempSync(path.join(os.tmpdir(),'kydog-x-catalog-'));
  scriptPath=path.join(dir,'script.json');await writeFile(scriptPath,JSON.stringify({events:[]}));
  H.enabled=true;H.created=[];run='protocol-run-one';f=fixture([searchHtml(post())]);H.port=f.context.browser;
});
afterEach(async()=>{delete process.env.KYDOG_AGENT_FIXTURE;await rmSync(dir,{recursive:true,force:true});});
afterAll(()=>{rmSync(H.taskDir,{recursive:true,force:true});});
async function build(mode:'fixture'|'production'='fixture'){
 if(mode==='fixture')process.env.KYDOG_AGENT_FIXTURE=scriptPath;else delete process.env.KYDOG_AGENT_FIXTURE;
 return createSession({cwd:dir,sessionsDir:path.join(dir,'sessions'),sessionId:THREAD_ID,providerId:'anthropic',modelId:'test',askShared:{onOpened:()=>{},onClosed:()=>{}},currentRunId:()=>run});
}
async function execute(session:Awaited<ReturnType<typeof build>>,name:string,args:unknown,id=name){
 await writeFile(scriptPath,JSON.stringify({events:[{type:'tool',after_ms:0,toolCallId:id,name,args},{type:'agent_end',after_ms:0,reason:'completed'}]}));
 const events:any[]=[];const off=session.subscribe(e=>events.push(e));await session.prompt(id);off();return events.find(e=>e.type==='tool_execution_end');
}
/** 动作面的一次研究：`submit` 立即返回，`wait` 交付一份。两次 prompt 之间只有用例自己的断言。 */
async function research(session:Awaited<ReturnType<typeof build>>,args:Record<string,unknown>,id:string){
 const submitted=await execute(session,'x_research',{action:'submit',...args},`${id}-submit`);
 expect(submitted.isError).toBe(false);
 const runId=(submitted.result.details as {researchRunId:string}).researchRunId;
 const waited=await execute(session,'x_research',{action:'wait',researchRunId:runId},`${id}-wait`);
 expect(waited.isError).toBe(false);
 return waited;
}
function envelopeOf(end:{result:{details?:unknown}}):XResearchDeliveryEnvelope{
 return end.result.details as XResearchDeliveryEnvelope;
}
function deliveredOf(end:{result:{details?:unknown}}) {
 const delivery=envelopeOf(end).delivery;
 if(!delivery)throw new Error('expected a delivery');
 return delivery.result;
}
it('oneToolCatalogForProductionAndFixture uses each exact created object with the same complete file/catalog and sequential policy',async()=>{
 for(const mode of ['production','fixture'] as const){
  await build(mode);const catalog=H[mode];expect(catalog.filter(t=>t.name==='x_research')).toEqual([H.created.at(-1)]);
  for(const name of ['read','write','edit','read_pdf_figure','read_docx'])expect(catalog.filter(t=>t.name===name)).toHaveLength(1);
  expect(catalog.filter(t=>t.executionMode==='sequential').map(t=>t.name).sort()).toEqual([...SEQUENTIAL_TOOL_NAMES].sort());
  H.enabled=false;await build(mode);expect(H[mode].some(t=>t.name==='x_research')).toBe(false);H.enabled=true;
 }
});
// R42：实例在第一次建会话时懒构造一次；重建会话不造第二个（访问器的守卫会当场抛 research.conflict）。
it('registers exactly one task service and binds the new action tool to it',async()=>{
 const first=await build();
 const service=xResearchTaskService();
 expect(service).toBeInstanceOf(XResearchTaskService);
 const tool=H.fixture.find(t=>t.name==='x_research')!;
 // 「注册的是新工具面」的协议层事实：参数里认 `action`（旧工具只有 tabId/search/read）。
 expect((tool.parameters as {properties?:Record<string,unknown>}).properties).toHaveProperty('action');
 expect(tool).toBe(H.created.at(-1));
 await first.cleanup?.();
 const second=await build();
 expect(xResearchTaskService()).toBe(service);
 // 工具本身是每个会话一份（它闭包着这条 thread 的账本），service 只有那一个。
 expect(H.fixture.find(t=>t.name==='x_research')).not.toBe(tool);
 expect(H.fixture.find(t=>t.name==='x_research')).toBe(H.created.at(-1));
 await second.cleanup?.();
});
it('actual canonical execution persists through SDK branch and disable/enable generations, retaining owned tab and source guards',async()=>{
 let session=await build();const starts:number[]=[];session.subscribe(e=>{if(e.type==='agent_start')starts.push(session.state!.messages.length);});
 const search=await research(session,searchInput,'actual-search');
 const delivered=deliveredOf(search);
 expect(delivered).toMatchObject({runId:'protocol-run-one'});
 // 提交那一轮的身份由 service 铸：结果里的 `callId` 与壳上的 `submitCallId` 是同一个。
 expect(delivered.callId).toBe(envelopeOf(search).delivery!.submitCallId);
 expect(starts[0]).toBe(0);
 const markdown='Original [source](https://x.com/alice/status/123)';
 const saved=await execute(session,'write',{path:'x-research-test-2026-10-13.md',content:markdown},'save');expect(saved.isError).toBe(false);
 expect(await readFile(path.join(dir,'x-research-test-2026-10-13.md'),'utf8')).toBe(markdown);
 expect((await execute(session,'write',{path:'x-research-test-2026-10-13.md',content:'replacement'},'conflict')).isError).toBe(true);
 await session.cleanup?.();H.enabled=false;session=await build();
 expect((await execute(session,'read',{path:'x-research-test-2026-10-13.md'},'read-existing')).result.content[0].text).toContain(markdown);
 expect((await execute(session,'edit',{path:'x-research-test-2026-10-13.md',edits:[{oldText:'Original',newText:'Updated'}]},'edit-existing')).isError).toBe(false);
 H.enabled=true;run='protocol-run-two';session=await build();
 // 带着同一段研究的 id 续跑：标签页记在任务的 `browserTabId` 上，跨会话活着（spec §4.3）。
 const resumed=await research(session,{...searchInput,researchRunId:envelopeOf(search).researchRunId},'restored-search');
 expect(deliveredOf(resumed).runId).toBe(run);
 expect(f.open.mock.calls.at(-1)![1]).toBe('research-tab');
 const manager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 const branch=manager.getBranch();
 const savedResult=branch.find(e=>e.type==='message'&&e.message.role==='toolResult'&&e.message.toolCallId==='actual-search-wait');
 expect(savedResult).toMatchObject({type:'message',message:{details:{kind:'x_research',delivery:{result:{sourceKind:'page_graphql'}}}}});
 manager.branch(branch[0].id);
 expect((await execute(session,'write',{path:'ordinary.md',content:markdown},'branched-write')).isError).toBe(true);
 expect((await execute(session,'write',{path:'ordinary.md',content:'No citation'},'ordinary-write')).isError).toBe(false);
});
it('a search-only later preview blocks real write until an accurate independent read; no fixture-supplied result oracle',async()=>{
 const card='<div role="link" tabindex="0" href="https://x.com/bob/status/456"><div data-testid="User-Name"><a href="/bob">bob</a><a href="/bob">@bob</a></div><img data-testid="article-cover-image"></div>';
 const plain=post('123','alice','long original body');const withCard=post('123','alice','preview body').replace('</article>',card+'</article>');
 f=fixture([searchHtml(plain),searchHtml(withCard)]);H.port=f.context.browser;const session=await build();
 const r=await research(session,searchInput,'discover');
 const discovered=deliveredOf(r);
 if(discovered.operation!=='search')throw new Error('search expected');
 expect(discovered.queries[0].posts[0].text).toBe('long original body');expect(discovered.queries[0].postObservations?.[0].articlePreviews).toHaveLength(1);
 const args={path:'x-research-preview-2026-10-13.md',content:'[Source](https://x.com/alice/status/123)'};
 expect((await execute(session,'write',args,'blocked')).result.content[0].text).toContain('accurate entry');
 const read=fixture([readHtml(withCard)],{scrollError:new KydogError('browser.target_unusable','real safety rejection')});
 // Same production tool object, new actual source operation through the retained port.
 f.open.mockImplementation(read.open.getMockImplementation()!);(H.port.withPage as any).mockImplementation(read.context.browser.withPage);
 const attempt=await research(session,{read:{objective:'read exact entry',targets:[{url:'https://x.com/alice/status/123'}],includeReplies:false}},'accurate-attempt');
 const readResult=deliveredOf(attempt);
 if(readResult.operation!=='read')throw new Error('read expected');
 expect(readResult.targets[0].article.actionAttempted).toBe(true);
 expect((await execute(session,'write',args,'saved')).isError).toBe(false);
 run=null;const idle=await execute(session,'x_research',{action:'submit',...searchInput},'idle');
 expect(idle.isError).toBe(true);
 expect(idle.result.content[0].text).toContain('active run');
});
it('settled branch baseline includes the last actual result before branching to its exact assistant parent',async()=>{
 const session=await build();expect((await research(session,searchInput,'last-result')).isError).toBe(false);
 const manager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 const branch=manager.getBranch(),last=branch.at(-1)!;
 expect(last).toMatchObject({type:'message',message:{role:'toolResult',toolCallId:'last-result-wait'}});
 const parentId=last.parentId;
 if(parentId===null) throw new Error('Expected the actual assistant tool-call parent');
 expect(branch.find(entry=>entry.id===parentId)).toMatchObject({type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'last-result-wait',name:'x_research',arguments:{action:'wait',researchRunId:expect.any(String)}}]}});
 manager.branch(parentId);
 const denied=await execute(session,'write',{path:'ordinary.md',content:'[source](https://x.com/alice/status/123)'},'removed-result');
 expect(denied.isError).toBe(true);expect(denied.result.content[0].text).toContain('unobserved');
});
// Catches missing production ledger wiring, persisted restore, and branch/run leakage.
it('counts only actual current-run calls across SDK persistence and current branch changes',async()=>{
 let session=await build();
 const first=await research(session,searchInput,'scope-first');
 expect(deliveredOf(first).reportRunScopeFacts).toMatchObject({version:1,runId:run,callCount:1,unavailableCallCount:0,search:{totalRows:1},read:{totalRows:0}});
 const manager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 const firstLeaf=manager.getLeafId()!;
 const second=await research(session,searchInput,'scope-second');
 expect(deliveredOf(second).reportRunScopeFacts).toMatchObject({callCount:2,search:{totalRows:2}});
 expect(JSON.parse((second.result.content[0] as {text:string}).text).delivery.result.reportRunScopeFacts)
   .toEqual(deliveredOf(second).reportRunScopeFacts);
 await session.cleanup?.();session=await build();
 const restored=await research(session,searchInput,'scope-third');
 expect(deliveredOf(restored).reportRunScopeFacts).toMatchObject({callCount:3,search:{totalRows:3}});
 const restoredManager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 restoredManager.branch(firstLeaf);
 const sibling=await research(session,searchInput,'scope-sibling');
 expect(deliveredOf(sibling).reportRunScopeFacts).toMatchObject({callCount:2,search:{totalRows:2}});
 run='new-scope-run';
 const nextRun=await research(session,searchInput,'scope-next-run');
 expect(deliveredOf(nextRun).reportRunScopeFacts).toMatchObject({runId:run,callCount:1,search:{totalRows:1}});
 const stored=restoredManager.getBranch().at(-1);
 expect(stored).toMatchObject({type:'message',message:{role:'toolResult',toolCallId:'scope-next-run-wait',details:{kind:'x_research',delivery:{result:{reportRunScopeFacts:deliveredOf(nextRun).reportRunScopeFacts}}}}});
});
// F4: `pendingResults` 的判据是 submitCallId **与** batchId 一起对上。下面让同一个 submitCallId
// 在 pending 里挂着另一个 batchId：这一份不是「我亲手交的」，必须回到磁盘，而不是被当成 live。
it('re-reads from disk when the pending batch for a submit call id differs',async()=>{
 const session=await build();
 const tool=H.fixture.find(candidate=>candidate.name==='x_research')!;
 const submitted=(await tool.execute('direct-submit',{action:'submit',...searchInput} as never,undefined,undefined,{} as never)).details as XResearchDeliveryEnvelope;
 const waited=(await tool.execute('direct-wait',{action:'wait',researchRunId:submitted.researchRunId} as never,undefined,undefined,{} as never)).details as XResearchDeliveryEnvelope;
 const delivered=waited.delivery!;expect(delivered.result.artifact).toBeDefined();
 // 直接调工具不经 `session.prompt` 的 syncBranch：`pendingResults` 仍记着这一份。transcript 里再放
 // 一条同 submitCallId、不同 batchId 的壳 —— 这就是「pending 里有，但不是这一份」。
 const manager=(session as unknown as {sessionManager:SessionManager}).sessionManager;
 manager.appendMessage({role:'toolResult',toolCallId:'mismatch-wait',toolName:'x_research',content:[{type:'text',text:'{}'}],isError:false,timestamp:Date.now(),details:{kind:'x_research',action:'wait',delivery:{deliveryCallId:'mismatch-wait',submissionId:delivered.submissionId,submitCallId:delivered.submitCallId,operation:delivered.operation,result:{...delivered.result,batchId:'xbatch_not_mine'}}}} as never);
 // guard 工具的 execute 先跑 syncBranch：这就是「重新读盘」的入口。
 const write=H.fixture.find(candidate=>candidate.name==='write')!;
 await write.execute('trigger-sync',{path:'sync.md',content:'plain text'},undefined,undefined,{} as never);
 // 恢复链碰了这条壳（参考对不上 → `restoration: missing`），账本因此记了一个不可用调用；
 // 若它被当成 live，这个数会是 0。
 const after=await research(session,searchInput,'after-mismatch');
 expect(deliveredOf(after).reportRunScopeFacts).toMatchObject({callCount:1,unavailableCallCount:1});
 await session.cleanup?.();
});
it('waits for artifact hydration before guarded writes and discards stale branch reads',async()=>{
 const {fileService}=await import('../fs/fileService');
 const session=await build();
 const delivered=await research(session,searchInput,'artifact-A');
 expect(deliveredOf(delivered).delivery!.persistence).toBe('saved');
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
// 活交付绕过磁盘恢复（账本里那一份仍是「生产」的），而**别的会话**交付的那一份只能从工件读回来。
// 观测点取 `reportRunScopeFacts.unavailableCallCount`：恢复链读不回来的那一条提交记在这里
// （`XResearchScopeLedger.restore` 的唯一出口），而活交付那条根本不走恢复。
it('keeps the delivery it just made out of the disk restore but re-reads it from another session',async()=>{
 let session=await build();
 const live=await research(session,searchInput,'live-delivery');
 const artifactPath=deliveredOf(live).delivery!.artifactPath!;
 expect(artifactPath).toContain(THREAD_ID);
 expect(artifactPath.endsWith('manifest.json')).toBe(true);
 // 同一会话里把工件弄坏，再跑一次：上一份是这一轮亲手交的，没有从盘上重读 —— 不记「不可用」。
 writeFileSync(artifactPath,'corrupt');
 const sibling=await research(session,searchInput,'same-session');
 expect(deliveredOf(sibling).reportRunScopeFacts).toMatchObject({callCount:2,unavailableCallCount:0});
 await session.cleanup?.();
 // 新会话只能从分支恢复：坏工件那一份记成不可用，`callCount` 只数读得回来的两次（当场 +
 // 同一会话里那次），所以是 2/1 —— 两个数一起说明「读盘发生了、而且只发生了这一次」。
 session=await build();
 const restored=await research(session,searchInput,'restored-session');
 expect(deliveredOf(restored).reportRunScopeFacts).toMatchObject({callCount:2,unavailableCallCount:1});
 await session.cleanup?.();
});
