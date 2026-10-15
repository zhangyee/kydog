import { test, expect } from '@playwright/test';
import { promises as fs, readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import tls from 'node:tls';
import type { AddressInfo, Socket } from 'node:net';
import { launchKydog, teardown, seedProject, newThread, type LaunchedApp } from './helpers';
import { BROWSER_PARTITION } from '../src/main/browser/partition';
import type { RuntimeEvent } from '../src/shared/protocol';
import type { XResearchResult } from '../src/main/x/xResearchTypes';
import {xWireResponse, WIRE_ROOT, WIRE_PLAIN, LARGE_BODY} from './fixtures/61-browser/xWirePages';
import { xClosurePage } from './fixtures/61-browser/xClosurePages';

type Call = { name: string; args: Record<string, unknown>; toolCallId: string };
type Events = RuntimeEvent[];
declare global { interface Window { __xClosureEvents: Events } }
const hosts = ['x.com', 'example.org'];
const cert = readFileSync(path.join(__dirname, 'fixtures/61-browser/tls-cert.pem'), 'utf8');
const key = readFileSync(path.join(__dirname, 'fixtures/61-browser/tls-key.pem'));
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args, toolCallId: randomUUID() });

// One application session for auth/search/read/report, then one genuine process restart.
// Ordinary text comes from capture-derived HTTP responses; Article remains DOM sourced.
test.describe('normal application X research closure (offline)', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp, dir: string, fixture: string, project: string, threadId: string;
  let proxy: http.Server, loggedIn = false;
  const sockets = new Set<Socket>();
  let tabId: string, userTabId: string;
  let discovered: Extract<XResearchResult, { operation: 'search' }>;
  let read: Extract<XResearchResult, { operation: 'read' }>;
  const cleanup = async () => {
    try { if (launched) await teardown(launched); }
    finally { for (const socket of sockets) socket.destroy(); if (proxy?.listening) await new Promise<void>(r => proxy.close(() => r())); }
  };
  test.beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-x-closure-'));
    console.info('[isolated-fixture-directory]', dir);
    project = path.join(dir, 'project'); fixture = path.join(dir, 'fixture.json');
    await fs.mkdir(project); await fs.writeFile(fixture, JSON.stringify({ events: [] }));
    const origin = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `https://${req.headers.host}`);
      if (url.pathname === '/fixture-login' && req.method === 'POST') { loggedIn = true; res.end('confirmed'); return; }
      if (url.hostname === 'x.com' && !loggedIn && url.pathname !== '/i/jf/onboarding/web') { res.writeHead(302, { location: '/i/jf/onboarding/web' }); res.end(); return; }
      if (url.pathname === '/favicon.ico') { res.writeHead(404); res.end(); return; }
      const wire=xWireResponse(url);
      res.writeHead(200, { 'content-type': wire===null?'text/html; charset=utf-8':'application/json; charset=utf-8' }); res.end(wire??xClosurePage(url, loggedIn));
    });
    origin.on('clientError', (_e, s) => s.destroy());
    proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
    proxy.on('connection', s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
    proxy.on('connect', (req, socket: Socket, head) => {
      if (!hosts.some(host => req.url === `${host}:443`)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) socket.unshift(head);
      origin.emit('connection', new tls.TLSSocket(socket, { isServer: true, key, cert, ALPNProtocols: ['http/1.1'] }));
    });
    try {
      await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
      launched = await launchKydog({ fixture, seed: home => seedProject(home, project) });
      await configure();
      threadId = await newThread(launched.page);
      userTabId = (await launched.page.evaluate(() => window.kydog.invoke('browser.open', { url: 'https://example.org/user-tab' }))).tabId;
    } catch (error) { await cleanup(); throw error; }
  });
  test.afterAll(cleanup);
  async function configure() {
    const port = (proxy.address() as AddressInfo).port;
    expect(await launched.app.evaluate(async ({ session }, a) => {
      const ses = session.fromPartition(a.partition);
      await ses.setProxy({ proxyRules: `http://127.0.0.1:${a.port}` });
      ses.setCertificateVerifyProc((req, cb) => cb(a.hosts.includes(req.hostname) && req.certificate.data.replace(/\s/g, '') === a.cert.replace(/\s/g, '') ? 0 : -3));
      return ses.resolveProxy('https://x.com/search');
    }, { port, partition: BROWSER_PARTITION, hosts, cert })).toBe(`PROXY 127.0.0.1:${port}`);
    await launched.page.evaluate(async () => {
      const settings = await window.kydog.invoke('research.get');
      await window.kydog.invoke('research.save', { ...settings, xResearchEnabled: true });
      window.__xClosureEvents = [];
      const topics = ['run.started', 'run.tool_call_chunk', 'run.tool_call_end', 'run.ended', 'run.ask_start', 'run.ask_end'] as const;
      for (const topic of topics) window.kydog.on(topic, payload => window.__xClosureEvents.push({ topic, payload } as RuntimeEvent));
    });
  }

  async function run(calls: Call[], during?: () => Promise<void>) {
    await fs.writeFile(fixture, JSON.stringify({ events: [
      { type: 'agent_start', after_ms: 0 },
      ...calls.map(c => ({ ...c, type: 'tool', after_ms: 0 })),
      { type: 'agent_end', reason: 'completed', after_ms: 0 },
    ] }));
    const { runId } = await launched.page.evaluate(a => window.kydog.invoke('thread.send', a), { threadId, content: randomUUID() });
    if (during) await during();
    const events = () => launched.page.evaluate(a => window.__xClosureEvents.filter(e => e.payload && 'runId' in e.payload && e.payload.runId === a.runId && 'threadId' in e.payload && e.payload.threadId === a.threadId), { threadId, runId });
    await expect.poll(async () => (await events()).some(e => e.topic === 'run.ended')).toBe(true);
    const received = await events();
    expect(received.find(e => e.topic === 'run.ended')).toMatchObject({ payload: { reason: 'completed' } });
    return calls.map(c => {
      if (c.name === 'ask_user_question') {
        const answered = received.find(e => e.topic === 'run.ask_end' && e.payload.toolCallId === c.toolCallId);
        expect(answered).toMatchObject({ payload: { outcome: { kind: 'answered' } } });
        return { runId, callId: c.toolCallId, status: 'ok', text: '' };
      }
      const end = received.find(e => e.topic === 'run.tool_call_end' && e.payload.toolCallId === c.toolCallId);
      expect(end).toBeTruthy();
      return { runId, callId: c.toolCallId, status: end?.topic === 'run.tool_call_end' ? end.payload.status : '',
        text: received.flatMap(e => e.topic === 'run.tool_call_chunk' && e.payload.toolCallId === c.toolCallId ? [e.payload.chunk] : []).join('') };
    });
  }
  function canonical(outcome: Awaited<ReturnType<typeof run>>[number]): XResearchResult {
    expect(outcome.status).toBe('ok'); const result = JSON.parse(outcome.text) as XResearchResult;
    expect(result).toMatchObject({ schemaVersion: 2, runId: outcome.runId, callId: outcome.callId });
    console.info('[result-receipt]',JSON.stringify({operation:result.operation,runId:result.runId,callId:result.callId,artifact:result.artifact,delivery:result.delivery,scope:result.reportScopeFacts})); return result;
  }
  const searchArgs = () => ({ ...(tabId ? { tabId } : {}), search: { objective: 'Offline rendered evidence', queries: [
    { id: 'top', query: 'fixture primary', purpose: 'initial', product: 'Top' },
    { id: 'latest', query: 'fixture secondary', purpose: 'cross-check', product: 'Latest' },
  ], maxPostsPerQuery: 3, maxScrollsPerQuery: 0 } });

  test('auth returns before an independent original-tab ask; fresh fixture confirmation releases the next hidden query', async () => {
    const result = canonical((await run([call('x_research', searchArgs())]))[0]);
    expect(result.operation).toBe('search'); if (result.operation !== 'search') throw new Error('search expected');
    expect(result.queries.map(q => q.status)).toEqual(['auth_required', 'auth_required']);
    expect(result.queries[1].barrier?.reason).toBe('not_attempted:auth_required'); tabId = result.browserTabId;
    const ask = call('ask_user_question', { browserTabId: tabId, questions: [{ header: 'Login', question: 'Confirm this isolated fixture login?', options: [{ label: 'Confirmed', description: 'Fresh fixture human confirmation' }, { label: 'Cancel', description: 'Stop' }] }] });
    await run([ask], async () => {
      await expect(launched.page.getByTestId('question-composer')).toBeVisible();
      await expect(launched.page.locator('[data-pane="browser"]')).toBeVisible();
      const state = await launched.page.evaluate(() => window.kydog.invoke('browser.getState'));
      expect(state.activeTabId).toBe(tabId);
      // Native trusted mouse delivery supplies the fixture user's login confirmation.
      await launched.app.evaluate(async ({ webContents, BrowserWindow }) => {
        const views = webContents.getAllWebContents().filter(w => w.getURL().includes('/i/jf/onboarding/web'));
        if (views.length !== 1) throw new Error('Expected original auth view');
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents === views[0]);
        if (!view) throw new Error('Missing native auth view');
        const logical = await views[0].executeJavaScript("(()=>{const r=document.querySelector('#fixtureLogin').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})()");
        const scale = view.getBounds().width / logical.width;
        const point = { x: Math.round(logical.x * scale), y: Math.round(logical.y * scale) };
        console.info('[fixture-human-click]', { logical, bounds: view.getBounds(), point });
        views[0].sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        views[0].sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      });
      await expect.poll(() => launched.app.evaluate(async ({ webContents }) => {
        const view = webContents.getAllWebContents().find(w => w.getURL().includes('/i/jf/onboarding/web'))!;
        return view.executeJavaScript('document.body.dataset.fixtureConfirmed');
      })).toBe('true');
      await launched.page.getByRole('button', { name: 'Confirmed', exact: false }).click();
      await launched.page.getByTestId('ask-submit').click();
    });
    const asks = await launched.page.evaluate(() => window.__xClosureEvents.filter(e => e.topic === 'run.ask_start'));
    expect(asks).toHaveLength(1); expect(asks[0]).toMatchObject({ payload: { toolCallId: ask.toolCallId, threadId, browserTabId: tabId } });
    await launched.page.getByTestId('titlebar-browser').click();
    await expect(launched.page.locator('[data-pane="browser"]')).toHaveCount(0);
    await launched.page.evaluate(id => window.kydog.invoke('browser.activate', { tabId: id }), userTabId);
    const next = canonical((await run([call('x_research', searchArgs())]))[0]);
    if (next.operation !== 'search') throw new Error('search expected'); discovered = next;
    expect(next.browserTabId).toBe(tabId);
    for (const row of next.queries) {expect(row.posts.map(p => p.text)).toEqual([WIRE_ROOT, WIRE_PLAIN]);expect(row.stopReason).toBe('budget_reached');}
    expect(next.sourceKind).toBe('page_graphql');
    expect((await launched.page.evaluate(() => window.kydog.invoke('browser.getState'))).activeTabId).toBe(userTabId);
  });

  test('network search → exact read preview → native Article → guarded rendered report', async () => {
    const root = discovered.queries[0].posts[0], plain=discovered.queries[0].posts[1];
    const reportPath='x-research-offline-2026-10-16.md', initial=`# Offline evidence\n\n[Plain](${plain.sourceUrl})\n`;
    expect((await run([call('write',{path:reportPath,content:initial})]))[0].status).toBe('ok');
    const preview=canonical((await run([call('x_research',{tabId,read:{objective:'Observe exact native Article preview',targets:[{url:root.sourceUrl}],includeArticle:false,includeReplies:false,maxScrollsPerPost:0}})]))[0]);
    if(preview.operation!=='read')throw Error('read expected');
    expect(preview.targets[0].root).toMatchObject({text:WIRE_ROOT,sourceKind:'page_graphql',articlePreviewInventory:{observed:1,retained:1,unresolved:0}});
    const denied=(await run([call('write',{path:'x-research-preview-2026-10-16.md',content:`[Parent](${root.sourceUrl})`})]))[0];
    expect(denied.status).toBe('failed');expect(denied.text).toContain('accurate entry');
    const readArgs={tabId,read:{objective:'Read observed exact sources',targets:[{url:root.sourceUrl}],includeArticle:true,includeReplies:true,maxRepliesPerPost:3,maxScrollsPerPost:1,maxExpandActionsPerPost:4}};
    const result=canonical((await run([call('x_research',readArgs)]))[0]);
    if(result.operation!=='read')throw Error('read expected');read=result;
    const target=read.targets[0],articleUrl='https://x.com/writer/status/654';
    expect(target.root).toMatchObject({postId:'321',author:{handle:'reader'},text:WIRE_ROOT,sourceKind:'page_graphql'});
    expect(target.article).toMatchObject({entryObserved:true,actionAttempted:true,navigationStarted:true,bodyObserved:true,body:{postId:'654',sourceUrl:articleUrl,author:{handle:'writer'},sourceKind:'rendered_ui',text:'ARTICLE_BODY_DOM_a751\n\nhttps://example.org/observed-external'}});
    expect(target.replies.observations.map(p=>p.text)).toContain('NETWORK_REPLY_802');
    expect(target.replies.scope).toMatchObject({kind:'network',extent:'unknown',context:{accountContextId:null}});
    const native=await launched.app.evaluate(async({webContents})=>{
      const view=webContents.getAllWebContents().find(w=>w.getURL()==='https://x.com/reader/status/321')!;
      return view.executeJavaScript("({actions:JSON.parse(sessionStorage.getItem('nativeActions')||'[]'),decoy:document.querySelector('[data-testid=\"tweetText\"]').textContent})");
    });
    expect(native.actions).toContain('article');expect(native.actions).toContain('replies');
    expect(native.decoy).toBe('ROOT_DOM_094a');expect(target.root?.text).not.toBe(native.decoy);
    const direct=canonical((await run([call('x_research',{tabId,read:{objective:'Read own Article URI',targets:[{url:articleUrl}],includeArticle:true,includeReplies:false}})]))[0]);
    if(direct.operation!=='read')throw Error('read expected');
    expect(direct.targets[0]).toMatchObject({root:null,status:'observed',article:{actionAttempted:false,bodyObserved:true,body:{postId:'654'},provenance:{kind:'direct_open',nativeIdentity:{kind:'owned_analytics',href:'/writer/status/654/analytics'}}},budgetUsage:{distinctEntries:1}});
    const report=`# Offline evidence\n\n${WIRE_ROOT}\n\n[Parent](${root.sourceUrl}) · [Article](${articleUrl})\n\n${target.article.body!.text}\n\n${target.replies.observations.map(p=>p.text).join('\n')}\n\n\`\`\`mermaid\nflowchart LR\nObserved --> Qualified\n\`\`\`\n`;
    // Resolve the current parent frame's Article inventory before citing it.
    const refreshed=canonical((await run([call('x_research',{tabId,read:{objective:'Resolve current Article inventory',targets:[{url:root.sourceUrl}],includeArticle:true,includeReplies:false,maxScrollsPerPost:0,maxExpandActionsPerPost:2}})]))[0]);
    if(refreshed.operation!=='read')throw Error('read expected');
    expect(refreshed.targets[0].article.bodyObserved).toBe(true);
    const saved=await run([call('read',{path:reportPath}),call('edit',{path:reportPath,edits:[{oldText:initial,newText:report}]})]);
    expect(saved[0].text).toContain(initial.trim());expect(saved[1].status).toBe('ok');
    const bad='https://x.com/unobserved/status/999';
    const rejects=await run([call('write',{path:reportPath,content:'replacement'}),call('write',{path:'x-research-bad-2026-10-16.md',content:`[Bad](${bad})`}),call('edit',{path:reportPath,edits:[{oldText:'Offline evidence',newText:`[Bad](${bad})`}]})]);
    expect(rejects.map(r=>r.status)).toEqual(['failed','failed','failed']);
    expect(await fs.readFile(path.join(project,reportPath),'utf8')).toBe(report);
    const observedExternal=target.article.body!.text.match(/https:\/\/example\.org\/observed-external/)?.[0];
    expect(observedExternal).toBe('https://example.org/observed-external');
    const external=(await run([call('browser_open',{url:observedExternal})]))[0];
    expect(external.status).toBe('ok');expect(external.text).toContain('EXTERNAL_DOM_8b2e');
    const state=await launched.page.evaluate(()=>window.kydog.invoke('browser.getState'));
    expect(state.activeTabId).toBe(userTabId);
    expect(state.tabs.some(t=>t.url===observedExternal&&t.id!==tabId)).toBe(true);
    const history=await launched.page.evaluate(id=>window.kydog.invoke('thread.loadHistory',{threadId:id}),threadId);
    expect(JSON.stringify(history)).toContain('ARTICLE_BODY_DOM_a751');
    const sessionDir=path.join(launched.kydogHome,'.kydog','sessions');
    const sessionFiles=(await fs.readdir(sessionDir,{recursive:true})).filter(file=>path.basename(file)===`${threadId}.jsonl`);
    expect(sessionFiles).toHaveLength(1);
    const entries=(await fs.readFile(path.join(sessionDir,sessionFiles[0]),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const persisted=entries.filter(entry=>entry.message?.role==='toolResult'&&entry.message.toolCallId===read.callId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].message).toMatchObject({toolName:'x_research',isError:false,details:read});
    expect(entries.find(entry=>entry.id===persisted[0].parentId)?.message.content).toContainEqual({type:'toolCall',id:read.callId,name:'x_research',arguments:readArgs});
    await launched.page.getByTestId(`fs-${path.join(project,reportPath)}`).dblclick();
    const editor=launched.page.locator('.kydog-md-editor .ProseMirror').locator('visible=true');
    await expect(editor.locator('a[href="https://x.com/writer/status/654"]')).toHaveText('Article');
    await expect(editor.locator('.kydog-mermaid-preview[data-status="ready"] svg')).toBeVisible();
    await launched.page.screenshot({path:test.info().outputPath('rendered-report.png')});
  });

  test('full canonical artifact exceeds 1 MiB and the same current-branch evidence guards files after a real process restart',async()=>{
    const outcome=(await run([call('x_research',{tabId,search:{objective:'Capture-derived resource pressure',queries:[{id:'pressure',query:'pressure',purpose:'full artifact',product:'Top'}],maxPostsPerQuery:1000,maxScrollsPerQuery:0}})]))[0];
    const result=canonical(outcome);
    expect(Buffer.byteLength(outcome.text)).toBeLessThanOrEqual(1048576);
    expect(result.artifact!.bytes).toBeGreaterThan(1048576);
    if(result.operation!=='search')throw Error('search expected');
    expect(result.queries[0]).toMatchObject({stopReason:'budget_reached',sampleTruncation:{observed:1000,sampled:1000,omitted:0},budgetBinding:[{dimension:'posts',limit:1000,used:1000,origin:'explicit'},{dimension:'scrolls',limit:0,used:0,origin:'explicit'}]});
    expect(result.delivery).toMatchObject({persistence:'saved',truncated:true});
    const manifestPath=result.delivery!.artifactPath!;
    const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
    const chunks=await Promise.all(manifest.chunks.map(async(c:{name:string;bytes:number;sha256:string})=>{
      const bytes=await fs.readFile(path.join(path.dirname(manifestPath),c.name));
      expect(bytes.length).toBe(c.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(c.sha256);return bytes;
    }));
    const bytes=Buffer.concat(chunks),full=JSON.parse(bytes.toString());
    expect(bytes.length).toBe(result.artifact!.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.artifact!.sha256);
    expect(full.queries[0].posts[1].text).toBe(LARGE_BODY);
    const citation='https://x.com/pressure/status/1699';
    expect(full.queries[0].posts.at(-1)).toMatchObject({postId:'1699',sourceUrl:citation,text:'RESOURCE_PRESSURE_1699'});
    expect(outcome.text).not.toContain(citation);
    expect(JSON.stringify(result)).not.toContain(citation);
    const endChunk=manifest.chunks[chunks.findIndex(bytes=>bytes.toString().includes('_CANONICAL_FULL_END'))];
    expect(endChunk).toBeDefined();
    const readManifest=(await run([call('read',{path:manifestPath})]))[0];
    expect(readManifest.status).toBe('ok');expect(readManifest.text).toContain(result.artifact!.sha256);
    const chunkRead=(await run([call('read',{path:path.join(path.dirname(manifestPath),endChunk.name)})]))[0];
    expect(chunkRead.status).toBe('ok');expect(chunkRead.text).toContain('_CANONICAL_FULL_END');
    const sessions=path.join(launched.kydogHome,'.kydog','sessions');
    const files=(await fs.readdir(sessions,{recursive:true})).filter(file=>path.basename(file)===`${threadId}.jsonl`);
    expect(files).toHaveLength(1);
    const entries=(await fs.readFile(path.join(sessions,files[0]),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const persisted=entries.find(e=>e.message?.role==='toolResult'&&e.message.toolCallId===outcome.callId);
    expect(persisted.message.details.artifact).toEqual(result.artifact);
    expect(JSON.stringify({content:persisted.message.content,details:persisted.message.details})).not.toContain(citation);
    expect(Buffer.byteLength(JSON.stringify({content:persisted.message.content,details:persisted.message.details}))).toBeLessThanOrEqual(1048576);
    const home=launched.kydogHome,oldPid=launched.app.process().pid;
    await teardown(launched);
    launched=await launchKydog({fixture,kydogHome:home});await configure();
    expect(launched.app.process().pid).not.toBe(oldPid);
    const history=await launched.page.evaluate(id=>window.kydog.invoke('thread.loadHistory',{threadId:id}),threadId);
    expect(JSON.stringify(history)).toContain(result.artifact!.directoryId);
    const restored=await run([call('write',{path:'x-research-restored-2026-10-16.md',content:`# Restored\n\n[Evidence](${citation})`}),call('write',{path:'x-research-restored-bad-2026-10-16.md',content:'[Unobserved](https://x.com/unobserved/status/999)'})]);
    expect(restored[0].status).toBe('ok');expect(restored[1].status).toBe('failed');expect(restored[1].text).toContain('unobserved');
    expect(await fs.readFile(manifestPath,'utf8')).toBe(JSON.stringify(manifest,null,2));
    const restoredRead=(await run([call('read',{path:path.join(path.dirname(manifestPath),endChunk.name)})]))[0];
    expect(restoredRead.text).toContain('_CANONICAL_FULL_END');
    const receipt=canonical((await run([call('x_research',{search:{objective:'Restoration receipt without new evidence',queries:[{id:'zero',query:'zero',purpose:'receipt',product:'Top'}],maxPostsPerQuery:0}})]))[0]);
    expect(receipt.artifactRestoration?.missingCalls??0).toBe(0);
    console.info('[artifact-restart-receipt]',JSON.stringify({oldPid,newPid:launched.app.process().pid,artifact:result.artifact,artifactOnlySource:{postId:'1699',sourceUrl:citation},envelopeBytes:Buffer.byteLength(JSON.stringify({content:persisted.message.content,details:persisted.message.details})),restoration:receipt.artifactRestoration}));
  });
});
