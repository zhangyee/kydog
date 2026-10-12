/** Standalone local-only fixture. It imports production services; no test RPC
 * or evaluator is added to the application or to XQueuedPage. */
import { app, BrowserWindow, session, type WebContentsView } from 'electron';
import http from 'node:http';
import tls from 'node:tls';
import key from './tls-key.pem?raw';
import cert from './tls-cert.pem?raw';
import { readX } from '../../../src/main/x/xResearchRead';
import { collectXPage } from '../../../src/main/x/xPageSource';
import type { AddressInfo, Socket } from 'node:net';
import { BrowserService } from '../../../src/main/browser/browserService';
import { pointerFailureDiagnostic, type PointerFailureDiagnostic } from '../../../src/main/browser/pointerDiagnostic';
import { createXResearchBrowser } from '../../../src/main/x/xResearchBrowser';
import { BROWSER_PARTITION } from '../../../src/main/browser/partition';
import type { DispatchAction } from '../../../src/main/browser/actions';

const html = `<!doctype html><meta charset="utf-8"><title>Local native UI</title>
<style>body{margin:30px;font:20px sans-serif}button,input{font:inherit;padding:16px}#cover{position:fixed;inset:0;z-index:100;background:white}</style>
<form id="form"><input id="query" aria-label="Search" value="old"><button type="button" id="open"><span>Open discussion</span></button><input id="password" type="password" aria-label="Password"></form>
<script>
window.facts={clicks:0,keys:0,input:0,trustedClicks:0,trustedKeys:0,value:'old'};
document.addEventListener('click',e=>{if(e.target.closest('#open')){facts.clicks++;if(e.isTrusted)facts.trustedClicks++}});
query.addEventListener('input',()=>{facts.input++;facts.value=query.value});
query.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();facts.keys++;if(e.isTrusted)facts.trustedKeys++}});
</script>`;

const xHtml = `<!doctype html><meta charset="utf-8"><style>body{margin:30px;font:20px sans-serif}button{padding:20px}</style>
<main><div data-testid="primaryColumn"><div aria-label="Timeline: Conversation">
<article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">@alice</a></div><a id="stamp" href="/alice/status/123/history"><time>today</time></a><div data-testid="tweetText">Body</div><button id="expand" role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button><span id="likes">1</span></article>
<article id="otherpost" data-testid="tweet"><div data-testid="User-Name"><a href="/bob">@bob</a></div><a href="/bob/status/456/history"><time>today</time></a><div data-testid="tweetText">Other</div></article>
</div></div></main><form id="compose"></form><script>window.trusted=0;document.addEventListener('click',e=>{if(e.target.closest('#expand')&&e.isTrusted)window.trusted++});document.addEventListener('submit',e=>e.preventDefault());</script>`;

// Source-derived DOM markers; navigation/input are real Chromium, content is offline.
const readerHtml = (handle: string) => `<!doctype html><meta charset="utf-8"><style>body{margin:24px;font:16px sans-serif}button{padding:12px}#entry{padding:16px;border:1px solid;cursor:pointer}</style>
<main><div data-testid="primaryColumn"><div aria-label="Timeline: Conversation">
<article data-testid="tweet"><div data-testid="User-Name"><a href="/${handle}">@${handle}</a></div><a href="/${handle}/status/321"><time>today</time></a><div id="rootText" data-testid="tweetText">Native preview</div><button id="bodyMore" role="button" type="button" data-testid="tweet-text-show-more-link">Show more</button><div id="entry" role="link" tabindex="0"><div data-testid="User-Name"><a href="/writer">@writer</a></div><div data-testid="article-cover-image">Article preview</div></div></article>
<article id="firstReply" data-testid="tweet"><div data-testid="User-Name"><a href="/first">@first</a></div><a href="/first/status/801"><time>today</time></a><div data-testid="tweetText">First reply</div></article>
<div data-testid="cellInnerDiv"><button id="replyMore" role="button" type="button">Show replies</button></div>
</div></div></main><div style="height:1800px"></div><script>
const record=kind=>{const saved=JSON.parse(sessionStorage.getItem('read-actions')||'[]');saved.push(kind);sessionStorage.setItem('read-actions',JSON.stringify(saved));};
if(${JSON.stringify(handle)}==='scroller') {
 bodyMore.remove();entry.remove();replyMore.remove();
 document.addEventListener('scroll',e=>{
  if(!e.isTrusted || e.target!==document)return;
  record('scroll-event');requestAnimationFrame(()=>{
   record('scroll-frame');
   const first=document.querySelector('#firstReply');
   if(first)first.outerHTML='<article data-testid="tweet"><div data-testid="User-Name"><a href="/fourth">@fourth</a></div><a href="/fourth/status/804"><time>today</time></a><div data-testid="tweetText">Reply rendered after actual scroll</div></article>';
  });
 },{once:true});
}

document.addEventListener('click',e=>{
 if(!e.isTrusted)return;
 if(e.target.closest('#bodyMore')){record('body');rootText.textContent='Native expanded body';bodyMore.remove();firstReply.outerHTML='<article data-testid="tweet"><div data-testid="User-Name"><a href="/second">@second</a></div><a href="/second/status/802"><time>today</time></a><div data-testid="tweetText">Second reply</div></article>';return;}
 if(e.target.closest('#entry')){record('article');history.pushState({},'', '/writer/status/654');document.querySelector('main').innerHTML='<article data-testid="tweet"><div data-testid="User-Name"><a href="/writer">@writer</a></div><article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">Native Article</div><div data-testid="twitterArticleRichTextView"><div data-testid="longformRichTextComponent" contenteditable="false"><div data-block="true">Native paragraph <strong>rich</strong></div><h2 data-block="true">Native heading</h2></div></div></article></article>';return;}
 if(e.target.closest('#replyMore')){record('replies');document.querySelector('[aria-label="Timeline: Conversation"]').innerHTML='<article data-testid="tweet"><div data-testid="User-Name"><a href="/third">@third</a></div><a href="/third/status/803"><time>today</time></a><div data-testid="tweetText">Replacement reply</div></article>';}
});
</script>`;

void app.whenReady().then(async () => {
  const sockets = new Set<Socket>();
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://invalid.test');
    if (!['example.com', 'example.org'].includes(url.hostname)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
  });
  const origin = http.createServer((req,res) => { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); const handle=/^\/(reader|blocked|scroller)\/status\/321$/.exec(req.url??'')?.[1]; res.end(handle?readerHtml(handle):xHtml); });
  origin.on('clientError', (_error,socket) => socket.destroy());
  proxy.on('connect', (req,socket: Socket,head: Buffer) => {
    socket.on('error',()=>{});
    if(req.url!=='x.com:443') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if(head.length) socket.unshift(head);
    origin.emit('connection',new tls.TLSSocket(socket,{isServer:true,key,cert,ALPNProtocols:['http/1.1']}));
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const portNumber = (proxy.address() as AddressInfo).port;
  const ses = session.fromPartition(BROWSER_PARTITION);
  ses.setCertificateVerifyProc((req,cb)=>cb(req.hostname==='x.com' && req.certificate.data.replace(/\s+/g,'')===cert.replace(/\s+/g,'') ? 0 : -3));
  await ses.setProxy({ proxyRules: `http://127.0.0.1:${portNumber}` });
  const win = new BrowserWindow({ width: 1024, height: 720, show: true });
  await win.loadURL('data:text/html,<h1>Local native fixture controller</h1>');
  const browser = new BrowserService(); browser.attach(win);
  const port = createXResearchBrowser(browser, 'fixture-thread');
  const target = await port.open('http://example.org/native/', undefined);
  const user = await browser.open({ url: 'http://example.com/user/', activate: true });
  const wc = browser.webContentsOf(target.tabId)!;
  let native = 0, inserts = 0;
  const send = wc.debugger.sendCommand.bind(wc.debugger);
  wc.debugger.sendCommand = (method, params) => { if (method.startsWith('Input.')) native++; if (method === 'Input.insertText') inserts++; return send(method, params); };
  const layout = (visible: boolean) => browser.syncView({ epoch: browser.getState().epoch, visible, occluded: false,
    bounds: { x: 0, y: 80, width: 900, height: 580 } });
  const read = async () => ({ page: await wc.executeJavaScript('({...window.facts})'), native, inserts,
    activeTabId: browser.getState().activeTabId, targetTabId: target.tabId, userTabId: user.tabId,
    focused: await wc.executeJavaScript('document.hasFocus()') });
  const act = (action: DispatchAction, signal?: AbortSignal) => port.withPage(target.tabId, signal, async page => {
    const snap = await page.snapshot(); return page.act(action, snap);
  });
  const controller = {
    read,
    sourceContainers: async () => {
      const opened=await port.open('https://x.com/search?q=containers&f=top',undefined);
      const view=browser.webContentsOf(opened.tabId)!;
      await view.executeJavaScript(`document.querySelector('[data-testid="primaryColumn"]').insertAdjacentHTML('afterbegin','<div role="tab" aria-selected="true">Top</div>');const original=document.querySelector('article[data-testid="tweet"]');
        original.querySelector('[data-testid="tweetText"]').textContent='PLAIN_EXACT_CONTAINER';
        const duplicate=original.cloneNode(true);duplicate.querySelector('[data-testid="tweetText"]').textContent='PREVIEW_EXACT_CONTAINER';
        duplicate.insertAdjacentHTML('beforeend','<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/writer">@writer</a></div><div data-testid="article-cover-image">Preview</div></div>');
        original.after(duplicate);`);
      return port.withPage(opened.tabId,undefined,async page=>{
        const observed=await collectXPage(page,{stage:'search',expectedUrl:'https://x.com/search?q=containers&f=top',query:'containers',product:'Top'});
        return {posts:observed.posts,entryParents:observed.entries.map(entry=>({author:entry.author?.handle,parentText:observed.entryParents.get(entry)?.text}))};
      });
    },
    readStages: async (mode: string) => {
      const handle=mode==='blocked'?'blocked':mode==='scroll'?'scroller':'reader', url=`https://x.com/${handle}/status/321`;
      const opened=await port.open(url,undefined), view=browser.webContentsOf(opened.tabId)!;
      await view.executeJavaScript("sessionStorage.removeItem('read-actions')");
      const capture=view.capturePage.bind(view); let rejectedNode=false;
      const evaluate=view.executeJavaScriptInIsolatedWorld.bind(view), readinessFrames:string[]=[];
      if(mode==='delayed') view.executeJavaScriptInIsolatedWorld=async(world,scripts,...rest)=>{
        const collecting=scripts[0].code.includes('const request = {"stage":"post"');
        const returning=collecting && view.getURL()===url && await view.executeJavaScript("JSON.parse(sessionStorage.getItem('read-actions')||'[]').includes('article')");
        if(returning && readinessFrames.length===0) await view.executeJavaScript("window.parentRegion=document.querySelector('[aria-label=\"Timeline: Conversation\"]');window.parentParts=Array.from(parentRegion.children);parentRegion.replaceChildren()");
        const raw=await evaluate(world,scripts,...rest);
        if(returning && readinessFrames.length===0 && raw.posts.length===0){
          readinessFrames.push('return-empty');
          await view.executeJavaScript('parentRegion.append(parentParts[0])');
        } else if(returning && readinessFrames.length===1 && raw.posts.length===1 && raw.posts[0].postId==='321'){
          readinessFrames.push('discussion-empty');
          await view.executeJavaScript('parentRegion.append(...parentParts.slice(1))');
        } else if(returning && readinessFrames.length===2 && raw.posts.some((p:{postId:string|null})=>p.postId==='801') && raw.controls.some((c:{kind:string})=>c.kind==='replies_expand')) readinessFrames.push('discussion-ready');
        return raw;
      };
      if(mode==='blocked') view.capturePage=async(...args)=>{
        const image=await capture(...args);
        if(await view.executeJavaScript("!document.querySelector('#bodyMore') && !!document.querySelector('#entry')")) {
          await view.executeJavaScript("document.querySelector('#entry').setAttribute('aria-disabled','true')"); rejectedNode=true;
        }
        return image;
      };
      try {
        const result=await readX({tabId:opened.tabId,read:{objective:'offline native stages',targets:[{url}],includeArticle:mode!=='scroll',includeReplies:true,maxRepliesPerPost:mode==='scroll'?2:10,maxScrollsPerPost:2,maxExpandActionsPerPost:mode==='scroll'?0:4}},
          {browser:port,threadId:'fixture-thread',runId:'native-run',callId:'native-read',batchId:'native-batch',sources:new Map()});
        const actions=await view.executeJavaScript("JSON.parse(sessionStorage.getItem('read-actions')||'[]')");
        const currentPosts=await view.executeJavaScript("Array.from(document.querySelectorAll('a[href]')).filter(a=>a.querySelector('time')).map(a=>a.getAttribute('href'))");
        return {result,actions,currentPosts,rejectedNode,readinessFrames,activeTabId:browser.getState().activeTabId,userTabId:user.tabId};
      } finally {view.capturePage=capture;view.executeJavaScriptInIsolatedWorld=evaluate;}
    },
    collectedPermission: async (mode: string) => {
      const opened=await port.open('https://x.com/alice/status/123',undefined);
      const xwc=browser.webContentsOf(opened.tabId)!;
      let input=0;
      const send=xwc.debugger.sendCommand.bind(xwc.debugger);
      xwc.debugger.sendCommand=(method,params)=>{if(method.startsWith('Input.'))input++;return send(method,params);};
      return port.withPage(opened.tabId,undefined,async page=>{
        const request={stage:'post' as const,expectedUrl:'https://x.com/alice/status/123',postId:'123'};
        const first=await collectXPage(page,request);
        const click=(observation:typeof first)=>{const c=observation.controls.find(c=>c.kind==='body_expand')!;return page.act({kind:'click',index:c.binding.index,snapshotId:c.binding.snapshotId},observation.snapshot);};
        // Unrelated metric changes are not part of expansion permission.
        await xwc.executeJavaScript("document.querySelector('#likes').textContent='999'");
        await click(first);
        const positive={input,trusted:await xwc.executeJavaScript('window.trusted')};
        const second=await collectXPage(page,request);
        await xwc.executeJavaScript('window.collectedNode=document.querySelector("#expand")');
        const mutation:Record<string,string>={
          submit:"collectedNode.type='submit'", name:"collectedNode.setAttribute('name','reply')", text:"collectedNode.textContent='Reply'",
          'form-owner':"collectedNode.setAttribute('form','compose')",
          'post-owner':"document.querySelector('#otherpost').append(collectedNode)",
          'post-identity':"document.querySelector('#stamp').href='/alice/status/999/history'",
          'at-measure':"collectedNode.type='submit';collectedNode.setAttribute('form','compose');collectedNode.textContent='Reply'",
          'after-frame':"document.querySelector('#stamp').href='/alice/status/999/history'",
        };
        const original=xwc.executeJavaScriptInIsolatedWorld.bind(xwc);
        let changed=false;
        xwc.executeJavaScriptInIsolatedWorld=async(world,scripts,...rest)=>{
          if(!changed && ((mode==='at-measure' && scripts[0].code.includes('const measured ='))
            || (mode==='after-frame' && scripts[0].code.includes('"op":"validate"')))) {
            await xwc.executeJavaScript(mutation[mode]);changed=true;
          }
          return original(world,scripts,...rest);
        };
        let error:string|null=null;
        try {
          if(mode!=='at-measure' && mode!=='after-frame') await xwc.executeJavaScript(mutation[mode]);
          await click(second);
        } catch(cause) {error=(cause as {code?:string}).code??String(cause);}
        finally {xwc.executeJavaScriptInIsolatedWorld=original;}
        return {positive,after:{input,trusted:await xwc.executeJavaScript('window.trusted')},error,
          sameNode:await xwc.executeJavaScript('window.collectedNode===document.querySelector("#expand")'),
          identity:first.identityProven,activeTabId:browser.getState().activeTabId,userTabId:user.tabId};
      });
    },
    neverShown: async () => {
      // Fresh service: stage is null from construction; not one syncView call.
      const fresh = new BrowserService(); fresh.attach(win);
      const freshPort = createXResearchBrowser(fresh, 'never-shown-thread');
      const opened = await freshPort.open('http://example.org/never-shown/', undefined);
      const userTab = await fresh.open({ url: 'http://example.com/never-user/', activate: true });
      const hidden = fresh.webContentsOf(opened.tabId)!;
      const view = win.contentView.children.find(child => 'webContents' in child && (child as WebContentsView).webContents === hidden) as WebContentsView;
      const before = { bounds: view.getBounds(), visible: view.getVisible(), activeTabId: fresh.getState().activeTabId, userTabId: userTab.tabId };
      const phases: string[] = [];
      let error: null | { code?: string; message: string; cause?: { name: string; message: string } } = null;
      try {
        for (const action of [{ kind: 'click', selector: '#open' }, { kind: 'type', selector: '#query', text: 'never shown query' }, { kind: 'key', key: 'Enter' }] as DispatchAction[]) {
          await freshPort.withPage(opened.tabId, undefined, async page => { const snap = await page.snapshot(); await page.act(action, snap); });
          phases.push(action.kind);
        }
      } catch (cause) {
        const value = cause as Error & { code?: string; cause?: Error };
        error = { code: value.code, message: value.message,
          ...(value.cause ? { cause: { name: value.cause.name, message: value.cause.message } } : {}) };
      }
      const result = { before, phases, error, page: await hidden.executeJavaScript('({...window.facts})'),
        activeTabId: fresh.getState().activeTabId, userTabId: userTab.tabId, visible: view.getVisible(), bounds: view.getBounds() };
      fresh.disposeAll(); return result;
    },
    typingBoundary: async (mode: 'focus' | 'selection') => {
      await wc.executeJavaScript("document.querySelector('#other')?.remove();document.body.insertAdjacentHTML('beforeend','<input id=other value=other-original style=\"position:fixed;left:20px;top:300px\">')");
      const before = await read(), original = wc.executeJavaScriptInIsolatedWorld.bind(wc);
      let validations = 0;
      wc.executeJavaScriptInIsolatedWorld = async (world, scripts, ...rest) => {
        const code = scripts[0].code;
        if (code.includes('"op":"validate_typing"') || code.includes('"op":"validate"') && ++validations === 2) {
          await wc.executeJavaScript(mode === 'focus' ? "document.querySelector('#other').focus()" : "document.querySelector('#query').setSelectionRange(2,2)");
        }
        return original(world, scripts, ...rest);
      };
      let error: string | null = null;
      try { await act({ kind: 'type', selector: '#query', text: 'must not insert' }); }
      catch (cause) { error = (cause as { code?: string }).code ?? String(cause); }
      finally { wc.executeJavaScriptInIsolatedWorld = original; }
      const after = await read(), destination = await wc.executeJavaScript("({query:document.querySelector('#query').value,other:document.querySelector('#other').value,active:document.activeElement.id})");
      await wc.executeJavaScript("document.querySelector('#other').remove()");
      return { before, after, error, destination };
    },
    visible: async () => { browser.activate(target.tabId); layout(true); },
    hidden: async () => { browser.activate(user.tabId); layout(false); },
    act,
    faults: async (mode: 'cover-before' | 'cover' | 'replace' | 'cancel' | 'password' | 'form-owner' | 'semantic') => {
      await wc.executeJavaScript("document.querySelector('#cover')?.remove();document.querySelector('#open').removeAttribute('aria-label');document.querySelector('#open').removeAttribute('form')");
      const before = await read(), abort = new AbortController();
      const original = wc.capturePage.bind(wc);
      wc.capturePage = async (...args) => {
        const image = await original(...args);
        if (mode === 'cover') await wc.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<div id=cover>Covered</div>')");
        if (mode === 'replace') await wc.executeJavaScript("const old=document.querySelector('#open');old.replaceWith(old.cloneNode(true))");
        if (mode === 'form-owner') await wc.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<form id=other></form>');document.querySelector('#open').setAttribute('form','other')");
        if (mode === 'semantic') await wc.executeJavaScript("document.querySelector('#open').setAttribute('aria-label','Publish')");
        if (mode === 'cancel') abort.abort();
        return image;
      };
      let error: string | null = null, diagnostic: Readonly<PointerFailureDiagnostic> | null = null;
      if (mode === 'cover-before') await wc.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<div id=cover>Covered</div>')");
      try {
        await act(mode === 'password' ? { kind: 'type', selector: '#password', text: 'blocked' } : { kind: 'click', selector: '#open' }, abort.signal);
      } catch (cause) {
        error = (cause as { code?: string }).code ?? String(cause);
        diagnostic = pointerFailureDiagnostic(cause) ?? null;
      }
      finally { wc.capturePage = original; }
      const after = await read();
      await wc.executeJavaScript("document.querySelector('#cover')?.remove();document.querySelector('#open').removeAttribute('aria-label');document.querySelector('#open').removeAttribute('form');document.querySelector('#other')?.remove()");
      return { before, after, error, diagnostic };
    },
    lease: async () => {
      const sequence: string[] = [];
      await port.withPage(target.tabId, undefined, async () => { sequence.push('control entered'); });
      const control = [...sequence]; sequence.length = 0;
      const before = await read(), abort = new AbortController();
      const originalSend = wc.debugger.sendCommand.bind(wc.debugger), originalEval = wc.executeJavaScriptInIsolatedWorld.bind(wc);
      let pressStarted!: () => void, releasePress!: () => void, cleanupStarted!: () => void, releaseCleanup!: () => void;
      const pressed = new Promise<void>(r => { pressStarted = r; });
      const cleaned = new Promise<void>(r => { cleanupStarted = r; });
      wc.debugger.sendCommand = async (method, params) => {
        const result = await originalSend(method, params);
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
          sequence.push('native press ACK'); pressStarted(); await new Promise<void>(r => { releasePress = r; });
        }
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') sequence.push('native release ACK');
        return result;
      };
      wc.executeJavaScriptInIsolatedWorld = async (world, scripts, ...rest) => {
        const result = await originalEval(world, scripts, ...rest);
        if (scripts[0].code.includes('"op":"dispose"')) {
          sequence.push('owned cleanup in flight'); cleanupStarted(); await new Promise<void>(r => { releaseCleanup = r; });
          sequence.push('owned cleanup ACK');
        }
        return result;
      };
      try {
        const old = act({ kind: 'click', selector: '#open' }, abort.signal);
        const caller = old.then(() => null, cause => (cause as { code?: string }).code ?? String(cause));
        await pressed; abort.abort(); const error = await caller; sequence.push('caller cancelled');
        const next = port.withPage(target.tabId, undefined, async () => { sequence.push('next entered'); });
        for (let i = 0; i < 24; i++) await Promise.resolve();
        const beforeRelease = [...sequence]; releasePress(); await cleaned;
        for (let i = 0; i < 24; i++) await Promise.resolve();
        const beforeCleanup = [...sequence]; releaseCleanup(); await next;
        return { control, error, beforeRelease, beforeCleanup, sequence, before, after: await read() };
      } finally { wc.debugger.sendCommand = originalSend; wc.executeJavaScriptInIsolatedWorld = originalEval; }
    },
    bindings: async () => port.withPage(target.tabId, undefined, async page => {
      const snapshot = await page.snapshot();
      await page.act({ kind: 'click', selector: '#open' }, snapshot);
      const before = page.location();
      const routed = new Promise<void>(resolve => wc.once('did-navigate-in-page', () => resolve()));
      await wc.executeJavaScript("history.pushState({},'', '/native/normalized')"); await routed;
      const after = page.location();
      let error: string | null = null;
      try { await page.act({ kind: 'click', selector: '#open' }, snapshot); }
      catch (cause) { error = (cause as { code?: string }).code ?? String(cause); }
      return { before, after, error };
    }),
    stop: () => { browser.disposeAll(); for (const socket of sockets) socket.destroy(); proxy.close(); },
  };
  Object.assign(globalThis, { __xUiHarness: controller, __xUiReady: true });
});
