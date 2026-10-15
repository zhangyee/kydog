/** Standalone local-only fixture. It imports production services; no test RPC
 * or evaluator is added to the application or to XQueuedPage. */
import { app, BrowserWindow, session, type WebContentsView } from 'electron';
import http from 'node:http';
import tls from 'node:tls';
import key from './tls-key.pem?raw';
import cert from './tls-cert.pem?raw';
import { xWireResponse, xWireScript } from './xWirePages';
import { xClosurePage } from './xClosurePages';
import { readX } from '../../../src/main/x/xResearchRead';
import { collectXPage } from '../../../src/main/x/xPageSource';
import type { AddressInfo, Socket } from 'node:net';
import { WALKER_WORLD_ID, BrowserService } from '../../../src/main/browser/browserService';
import { logger } from '../../../src/main/log';
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
<article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">@alice</a></div><a id="stamp" href="/alice/status/123/history"><time>today</time></a><div data-testid="tweetText">Body</div><span id="likes">1</span></article>
<article id="otherpost" data-testid="tweet"><div data-testid="User-Name"><a href="/bob">@bob</a></div><a href="/bob/status/456/history"><time>today</time></a><div data-testid="tweetText">Other</div></article>
<div data-testid="cellInnerDiv"><button id="expand" role="button" type="button">Show replies</button></div></div></div></main><form id="compose"></form><script>window.trusted=0;document.addEventListener('click',e=>{if(e.target.closest('#expand')&&e.isTrusted)window.trusted++});document.addEventListener('submit',e=>e.preventDefault());</script>`;

// Source-derived DOM markers; navigation/input are real Chromium, content is offline.
const readerHtml = (handle: string) => `<!doctype html><meta charset="utf-8"><style>body{margin:24px;font:16px sans-serif}button{padding:12px}#entry{padding:16px;border:1px solid;cursor:pointer}</style>
<main><div data-testid="primaryColumn"><div aria-label="Timeline: Conversation">
<article data-testid="tweet"><div data-testid="User-Name"><a href="/${handle}">@${handle}</a></div><a href="/${handle}/status/321"><time>today</time></a><div id="rootText" data-testid="tweetText">Native preview</div><div id="entry" role="link" tabindex="0"><div data-testid="User-Name"><a href="/writer">@writer</a></div><div data-testid="article-cover-image">Article preview</div></div></article>
<article id="firstReply" data-testid="tweet"><div data-testid="User-Name"><a href="/first">@first</a></div><a href="/first/status/801"><time>today</time></a><div data-testid="tweetText">First reply</div></article>
<div data-testid="cellInnerDiv"><button id="replyMore" role="button" type="button">Show replies</button></div>
</div></div></main>${handle==='stalled'?'':'<div style="height:1800px"></div>'}<script>
${xWireScript(handle)}
const record=kind=>{const saved=JSON.parse(sessionStorage.getItem('read-actions')||'[]');saved.push(kind);sessionStorage.setItem('read-actions',JSON.stringify(saved));};
if(['scroller','source','progress'].includes(${JSON.stringify(handle)})) {
 entry.remove();replyMore.remove();
 if(${JSON.stringify(handle)}==='progress'){
  firstReply.remove();
  // Diagnostic labels stay out of flow so the native scroll acknowledgement's
  // original geometry and root-only readiness cause remain unchanged.
  const panel=document.createElement('div');panel.style.cssText='position:absolute;left:600px;top:20px;width:280px';
  panel.innerHTML='<h2 id="inventoryHeading">Native heading</h2><div id="inventoryPrivate" role="status">Private sentinel</div><div role="status">状态信息</div><button type="button">End of conversation</button>';
  document.querySelector('[aria-label="Timeline: Conversation"]').append(panel);
 }
 document.addEventListener('scroll',e=>{
  if(!e.isTrusted || e.target!==document)return;
  window.wireReady=window.wireReady.then(wireFetch);record('scroll-event');requestAnimationFrame(()=>{
   record('scroll-frame');
   if(${JSON.stringify(handle)}==='progress'){
    // Keep the source scroll offset stable: an in-flow insertion changes scroll anchoring before ACK.
    const before=scrollY,arrived=document.createElement('article');arrived.dataset.testid='tweet';
    arrived.style.cssText='position:absolute;left:24px;right:24px;top:'+(scrollY+20)+'px';
    arrived.innerHTML='<div data-testid="User-Name"><a href="/arrived">@arrived</a></div><a href="/arrived/status/809"><time>today</time></a><div data-testid="tweetText">Own reply created by trusted scroll frame</div>';
    document.querySelector('[aria-label="Timeline: Conversation"]').append(arrived);
    document.querySelector('#inventoryHeading').style.visibility='hidden';
    document.querySelector('#inventoryPrivate').innerHTML='<form><span>Private sentinel</span><input type="password" value="credential sentinel"></form>';
    window.sourceGeometry={before,after:scrollY,height:arrived.getBoundingClientRect().height};return;
   }
   if(${JSON.stringify(handle)}==='source'){
    const root=document.querySelector('#rootText').closest('article'),height=root.getBoundingClientRect().height,before=scrollY,spacer=document.createElement('div');
    spacer.style.height=height+'px';root.replaceWith(spacer);
    const current=document.createElement('div');current.style.cssText='position:absolute;left:24px;right:24px;top:'+(scrollY+20)+'px';
    current.innerHTML='<article data-testid="tweet"><div data-testid="User-Name"><a href="/current">@current</a></div><a href="/current/status/805"><time>today</time></a><div data-testid="tweetText">Rootless DOM decoy</div></article>';
    spacer.append(current);window.sourceGeometry={before,after:scrollY,height};return;
   }
   const first=document.querySelector('#firstReply');
   if(first)first.outerHTML='<article data-testid="tweet"><div data-testid="User-Name"><a href="/fourth">@fourth</a></div><a href="/fourth/status/804"><time>today</time></a><div data-testid="tweetText">Reply rendered after actual scroll</div></article>';
  });
 },{once:true});
}
if(${JSON.stringify(handle)}==='repeated') {
 entry.remove();firstReply.remove();
 window.repeatClicks=0;window.repeatOriginal={button:replyMore,root:rootText.closest('article'),conversation:replyMore.closest('[aria-label="Timeline: Conversation"]')};
}
if(${JSON.stringify(handle)}==='stalled') { entry.remove();replyMore.remove(); }

document.addEventListener('click',e=>{
 if(!e.isTrusted)return;
 if(e.target.closest('#entry')){record('article');history.pushState({},'', '/writer/status/654');document.querySelector('main').innerHTML='<article data-testid="tweet"><div data-testid="User-Name"><a href="/writer">@writer</a></div><article data-testid="twitterArticleReadView"><div data-testid="twitter-article-title">Native Article</div><div data-testid="twitterArticleRichTextView"><div data-testid="longformRichTextComponent" contenteditable="false"><div data-block="true">Native paragraph <strong>rich</strong></div><h2 data-block="true">Native heading</h2></div></div></article></article>';return;}
 if(e.target.closest('#replyMore'))window.wireReady=window.wireReady.then(wireFetch);
 if(e.target.closest('#replyMore') && ${JSON.stringify(handle)}==='repeated') {
  const ordinal=++window.repeatClicks,reply=document.createElement('article');reply.dataset.testid='tweet';
  reply.innerHTML='<div data-testid="User-Name"><a href="/own'+ordinal+'">@own'+ordinal+'</a></div><a href="/own'+ordinal+'/status/'+(900+ordinal)+'"><time>today</time></a><div data-testid="tweetText">Native own reply '+ordinal+'</div>';
  window.repeatOriginal.conversation.append(reply);return;
 }
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
  const origin = http.createServer((req,res) => {
    const url=new URL(req.url??'/', 'https://x.com'),wire=xWireResponse(url);
    if(wire!==null){res.writeHead(200,{'content-type':'application/json'});res.end(wire);return;}
    const handle=/^\/(reader|blocked|scroller|stalled|source|progress|repeated)\/status\/321$/.exec(url.pathname)?.[1];
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    res.end(url.pathname==='/writer/status/654'?xClosurePage(url,true):handle?readerHtml(handle):xHtml);
  });
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
    directIdentity: async () => {
      const url='https://x.com/writer/status/654';
      const opened=await port.open(url,undefined), view=browser.webContentsOf(opened.tabId)!;
      const evaluate=browser.evalInPage.bind(browser);
      const run=async(wrong:boolean)=>{
        let collections=0;
        const receipts: unknown[]=[];
        browser.evalInPage=async(tabId,code)=>{
          if(tabId!==opened.tabId || typeof code!=='string' || !code.includes('const request = {"stage":"post"')) return evaluate(tabId,code);
          if(wrong && collections===0) await view.executeJavaScript("document.querySelector('[role=group] a').setAttribute('href','/writer/status/655/analytics')");
          const raw=await evaluate(tabId,code);
          if(++collections===1) {
            const before=browser.locationFacts(tabId);
            const routed=new Promise<{url:string;isMainFrame:boolean}>(resolve=>view.once('did-navigate-in-page',(_event,url,isMainFrame)=>resolve({url,isMainFrame})));
            await view.executeJavaScript("history.replaceState({},'',location.href)");
            const event=await routed,after=browser.locationFacts(tabId);
            receipts.push({before,after,event,raw});
          }
          return raw;
        };
        try {
          const result=await readX({tabId:opened.tabId,read:{objective:'native own identity transition',targets:[{url}],includeArticle:true,includeReplies:false,maxRepliesPerPost:0,maxScrollsPerPost:0,maxExpandActionsPerPost:0}},
            {browser:port,threadId:'fixture-thread',runId:'native-identity',callId:wrong?'negative':'positive',batchId:'native-identity',sources:new Map()});
          return {result,collections,receipts};
        } finally {browser.evalInPage=evaluate;}
      };
      try {return {positive:await run(false),negative:await run(true)};}
      finally {browser.evalInPage=evaluate;browser.close(opened.tabId);}
    },
    replyContinuation: async () => {
      const url='https://x.com/repeated/status/321',opened=await port.open(url,undefined),view=browser.webContentsOf(opened.tabId)!;
      const evaluate=view.executeJavaScriptInIsolatedWorld.bind(view),send=view.debugger.sendCommand.bind(view.debugger);
      let input=0;
      const collections:{nodeId:number;generation:string;hasSourcePermission:boolean}[]=[];
      view.debugger.sendCommand=(method,params)=>{if(method.startsWith('Input.'))input++;return send(method,params);};
      view.executeJavaScriptInIsolatedWorld=async(world,scripts,...rest)=>{
        const raw=await evaluate(world,scripts,...rest);
        if(scripts[0].code.includes('const request = {"stage":"post"')) {
          const control=raw.controls.find((c:{kind:string})=>c.kind==='replies_expand');
          const node=raw.snapshot.nodes.find((n:{nodeId:number})=>n.nodeId===control?.nodeId);
          collections.push({nodeId:control?.nodeId,generation:raw.snapshot.generation,hasSourcePermission:node?.collectedPermission?.purpose==='replies_expand'});
        }
        return raw;
      };
      try {
        const result=await readX({tabId:opened.tabId,read:{objective:'reusable reply native control',targets:[{url}],includeArticle:false,includeReplies:true,maxRepliesPerPost:20,maxScrollsPerPost:0,maxExpandActionsPerPost:3}},
          {browser:port,threadId:'fixture-thread',runId:'native-repeat',callId:'native-repeat',batchId:'native-repeat',sources:new Map()});
        const physical=await view.executeJavaScript(`({trusted:window.repeatClicks,sameButton:repeatOriginal.button===document.querySelector('#replyMore'),sameRoot:repeatOriginal.root===document.querySelector('#rootText').closest('article'),sameConversation:repeatOriginal.conversation===document.querySelector('[aria-label="Timeline: Conversation"]')})`);
        return {result,input,collections,physical};
      } finally {view.executeJavaScriptInIsolatedWorld=evaluate;view.debugger.sendCommand=send;browser.close(opened.tabId);}
    },
    readStages: async (mode: string) => {
      const progressCase=mode==='progress'||mode==='progress-zero';
      const handle=progressCase?'progress':mode.startsWith('source-')?'source':mode==='blocked'?'blocked':mode==='scroll'?'scroller':mode==='stalled'?'stalled':'reader', url=`https://x.com/${handle}/status/321`;
      const opened=await port.open(url,undefined), view=browser.webContentsOf(opened.tabId)!;
      await view.executeJavaScript("sessionStorage.removeItem('read-actions')");
      const capture=view.capturePage.bind(view); let rejectedNode=false;
      const evaluate=view.executeJavaScriptInIsolatedWorld.bind(view);
      const sourceCleanup={populated:false,cleared:false},sourceActions:string[]=[];
      const dispatch=browser.dispatchAndObserveNavigation.bind(browser);
      if(mode.startsWith('source-')||progressCase) browser.dispatchAndObserveNavigation=async(...args)=>{sourceActions.push('dispatch:'+args[1].kind);const result=await dispatch(...args);if(mode==='source-invalidated')await view.executeJavaScript("history.replaceState({},'',location.href)");return result;};
      if(mode==='source-state') view.executeJavaScriptInIsolatedWorld=async(world,scripts,...rest)=>{
        const code=scripts[0].code,collecting=code.includes('const request = {"stage":"post"');
        if(code.includes('/* kydog-x-root-release */')) sourceCleanup.populated=await evaluate(WALKER_WORLD_ID,[{code:'!!window.__kydogXRootState?.anchor || !!window.__kydogXRootState?.pending'}]);
        const raw=await evaluate(world,scripts,...rest);
        if(collecting && await view.executeJavaScript("!document.querySelector('#rootText') && !!document.querySelector('a[href=\"/current/status/805\"]')"))sourceActions.push('collection:rootless');
        if(code.includes('/* kydog-x-root-release */')) sourceCleanup.cleared=await evaluate(WALKER_WORLD_ID,[{code:'window.__kydogXRootState === undefined'}]);
        return raw;
      };
      if(mode==='blocked') view.capturePage=async(...args)=>{
        const image=await capture(...args);
        if(await view.executeJavaScript("!!document.querySelector('#entry')")) {
          await view.executeJavaScript("document.querySelector('#entry').setAttribute('aria-disabled','true')"); rejectedNode=true;
        }
        return image;
      };
      try {
        const scrollCase=progressCase||mode==='scroll'||mode==='stalled'||mode.startsWith('source-');
        // Progress mode owns the native scroll cause.
        const result=await readX({tabId:opened.tabId,read:{objective:'offline native stages',targets:[{url}],includeArticle:!scrollCase,includeReplies:true,maxRepliesPerPost:progressCase?4:scrollCase?2:10,maxScrollsPerPost:mode==='progress-zero'?0:progressCase?1:2,maxExpandActionsPerPost:scrollCase?0:4}},
          {browser:port,threadId:'fixture-thread',runId:'native-run',callId:'native-read',batchId:'native-batch',sources:new Map()});
        const actions=await view.executeJavaScript("JSON.parse(sessionStorage.getItem('read-actions')||'[]')");
        const sourceGeometry=mode==='source-state'||progressCase?await view.executeJavaScript('window.sourceGeometry ?? null'):null;

        return {result,actions,rejectedNode,sourceCleanup,sourceGeometry,sourceActions,activeTabId:browser.getState().activeTabId,userTabId:user.tabId};
      } finally {view.capturePage=capture;view.executeJavaScriptInIsolatedWorld=evaluate;browser.dispatchAndObserveNavigation=dispatch;browser.close(opened.tabId);}
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
        const click=(observation:typeof first)=>{const c=observation.controls.find(c=>c.kind==='replies_expand')!;return page.act({kind:'click',index:c.binding.index,snapshotId:c.binding.snapshotId},observation.snapshot);};
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
            || (mode==='after-frame' && scripts[0].code.includes('"op":"finalize_collected_pointer"')))) {
            await xwc.executeJavaScript(mutation[mode]);changed=true;
          }
          return original(world,scripts,...rest);
        };
        let error:string|null=null;
        try {
          if(mode!=='at-measure' && mode!=='after-frame') {await xwc.executeJavaScript(mutation[mode]);changed=true;}
          await click(second);
        } catch(cause) {error=(cause as {code?:string}).code??String(cause);}
        finally {xwc.executeJavaScriptInIsolatedWorld=original;}
        return {positive,after:{input,trusted:await xwc.executeJavaScript('window.trusted')},error,mutationApplied:changed,
          sameNode:await xwc.executeJavaScript('window.collectedNode===document.querySelector("#expand")'),
          nativeOwnerProven:first.diagnosticFrame?.rootIdentityProven,activeTabId:browser.getState().activeTabId,userTabId:user.tabId};
      }).finally(()=>browser.close(opened.tabId));
    },
    pointerEligibility: async (mode: string) => {
      const opened=await port.open('https://x.com/alice/status/123',undefined);
      const xwc=browser.webContentsOf(opened.tabId)!;
      const evaluate=xwc.executeJavaScriptInIsolatedWorld.bind(xwc),send=xwc.debugger.sendCommand.bind(xwc.debugger);
      let input=0,measures=0,phase='positive',sameBinding=true;
      let originalTarget:string|undefined;
      const observations:string[]=[];
      const abort=new AbortController();
      let beforeWriter:unknown=null;
      const isolated=(code:string)=>evaluate(WALKER_WORLD_ID,[{code}]);
      const counters=async()=>({input,measures,...await isolated('({...window.__eligibilityFixture.counts})') as {scrolls:number;hits:number},trusted:await xwc.executeJavaScript('window.trusted') as number});
      xwc.debugger.sendCommand=(method,params)=>{if(method.startsWith('Input.'))input++;return send(method,params);};
      xwc.executeJavaScriptInIsolatedWorld=async(world,scripts,...rest)=>{
        const code=scripts[0].code;
        if(code.includes('const measured ='))measures++;
        const result=await evaluate(world,scripts,...rest);
        if(code.includes('"readPointerEligibility":true')) {
          const request=JSON.parse(code.slice(code.lastIndexOf('})(')+3,-1)) as {target:unknown};
          const binding=JSON.stringify(request.target);
          if(phase==='pending') {originalTarget??=binding;sameBinding&&=binding===originalTarget;}
          const value=(result as {pointerEligibility?:string}).pointerEligibility;
          observations.push(value??'invalid');
          if(phase==='pending' && value==='none') {
            beforeWriter=await counters();phase='released';
            if(mode==='cancel')abort.abort();
            else if(mode==='changed')await xwc.executeJavaScript("document.querySelector('#expand').setAttribute('aria-label','Reply')");
            else await xwc.executeJavaScript("document.querySelector('#expand').style.pointerEvents='auto'");
          } else if(phase==='released')sameBinding&&=binding===originalTarget;
        }
        return result;
      };
      let positive:Awaited<ReturnType<typeof counters>>|undefined,error:string|null=null,after:Awaited<ReturnType<typeof counters>>|undefined;
      let replayError:string|null=null,replayCounters:Awaited<ReturnType<typeof counters>>|undefined;
      try {
        await port.withPage(opened.tabId,abort.signal,async page=>{
          const request={stage:'post' as const,expectedUrl:'https://x.com/alice/status/123',postId:'123'};
          const observed=await collectXPage(page,request);
          await isolated(`(()=>{const scroll=Element.prototype.scrollIntoView,hit=document.elementFromPoint.bind(document);
            window.__eligibilityFixture={counts:{scrolls:0,hits:0},race:false};
            Element.prototype.scrollIntoView=function(...args){window.__eligibilityFixture.counts.scrolls++;if(window.__eligibilityFixture.race)this.style.pointerEvents='none';return scroll.apply(this,args);};
            document.elementFromPoint=(...args)=>{window.__eligibilityFixture.counts.hits++;return hit(...args);};
          })()`);
          const control=observed.controls.find(c=>c.kind==='replies_expand')!;
          const action={kind:'click' as const,index:control.binding.index,snapshotId:control.binding.snapshotId};
          await page.act(action,observed.snapshot);positive=await counters();
          try { await page.act(action,observed.snapshot); } catch(cause) { replayError=(cause as {code?:string}).code??String(cause); }
          replayCounters=await counters();
          const fresh=await collectXPage(page,request),freshControl=fresh.controls.find(c=>c.kind==='replies_expand')!;
          const freshAction={kind:'click' as const,index:freshControl.binding.index,snapshotId:freshControl.binding.snapshotId};
          input=0;measures=0;observations.length=0;
          await isolated('window.__eligibilityFixture.counts={scrolls:0,hits:0}');
          // Fresh one-shot permission on the same physical control. The pending
          // native attempt must retain this one binding across all eligibility reads.
          await xwc.executeJavaScript("window.eligibilityOriginal=document.querySelector('#expand');eligibilityOriginal.style.pointerEvents='none'");
          if(mode==='race')await isolated('window.__eligibilityFixture.race=true');
          phase='pending';await page.act(freshAction,fresh.snapshot);
        });
      } catch(cause){error=(cause as {code?:string}).code??String(cause);}
      finally {
        // Outer cancellation can return first; wait for the issued read and lease cleanup.
        try {
          await browser.enqueue(opened.tabId,async()=>{});
          after=await counters();
          sameBinding&&=await xwc.executeJavaScript('window.eligibilityOriginal===document.querySelector("#expand")') as boolean;
        } finally {
          xwc.executeJavaScriptInIsolatedWorld=evaluate;xwc.debugger.sendCommand=send;
          browser.close(opened.tabId);
        }
      }
      return {positive,beforeWriter,after,observations,sameBinding,error,replayError,replayCounters};
    },
    postFrameDiagnostic: async (mode: string) => {
      const opened = await port.open('https://x.com/alice/status/123', undefined);
      const xwc = browser.webContentsOf(opened.tabId)!;
      const evaluate = xwc.executeJavaScriptInIsolatedWorld.bind(xwc), send = xwc.debugger.sendCommand.bind(xwc.debugger);
      const capture = xwc.capturePage.bind(xwc), info = logger.info;
      let input = 0, measures = 0, frames = 0, phase = 'positive';
      const results: unknown[] = [], receipts: unknown[] = [], preflights: unknown[] = [];
      const abort=new AbortController();let recoveryFrames=0;const observations:string[]=[];
      const isolated = (code: string) => evaluate(WALKER_WORLD_ID, [{ code }]);
      const counters = async () => ({ input, measures, frames, ...await isolated('({...window.__postFrameFixture})') as { scrolls: number; hits: number }, trusted: await xwc.executeJavaScript('window.trusted') as number });
      xwc.debugger.sendCommand = (method, params) => { if (method.startsWith('Input.')) input++; return send(method, params); };
      logger.info = (scope, message, context) => {
        if (scope === 'browser.pointer_eligibility' && (context as { phase?: string })?.phase === 'post_frame') receipts.push(context);
        return info(scope, message, context);
      };
      xwc.executeJavaScriptInIsolatedWorld = async (world, scripts, ...rest) => {
        const code = scripts[0].code;
        if (code.includes('const measured =')) measures++;
        const result = await evaluate(world, scripts, ...rest);
        if (code.includes('"op":"finalize_collected_pointer"')) {
          results.push(result);
          if(phase==='negative' && (result as {phase?:string}).phase==='pending') {
            if(mode==='none')abort.abort();
            else if(mode==='recover')await xwc.executeJavaScript("window.postFrameOriginal.style.pointerEvents='auto'");
          }
        }
        if(phase==='negative'&&mode==='recover'&&code.includes('"op":"validate_collected"')){
          const state=(result as {pointerEligibility?:string}).pointerEligibility;observations.push(state??'unknown');
          if(state==='none')await xwc.executeJavaScript("window.postFrameOriginal.style.pointerEvents='auto'");
        }
        return result;
      };
      xwc.capturePage = async (...args) => {
        const image = await capture(...args);
        if (!image.isEmpty()) frames++;
        if (phase === 'negative' && (mode!=='recover'||++recoveryFrames<=2)) await xwc.executeJavaScript(mode === 'none'||mode==='recover'
          ? "window.postFrameOriginal.style.pointerEvents='none'"
          : "document.body.insertAdjacentHTML('beforeend','<div id=postFrameCover style=\"position:fixed;inset:0;z-index:100;background:white\">Covered</div>')");
        return image;
      };
      let positive: Awaited<ReturnType<typeof counters>> | undefined, after: Awaited<ReturnType<typeof counters>> | undefined;
      let error: string | null = null, sameControl = false;
      let diagnostic: Readonly<PointerFailureDiagnostic> | null = null;
      try {
        await port.withPage(opened.tabId, abort.signal, async page => {
          const observed = await collectXPage(page, { stage: 'post', expectedUrl: 'https://x.com/alice/status/123', postId: '123' });
          const control = observed.controls.find(c => c.kind === 'replies_expand')!;
          const action = { kind: 'click' as const, index: control.binding.index, snapshotId: control.binding.snapshotId };
          await xwc.executeJavaScript("window.postFrameOriginal=document.querySelector('#expand')");
          await isolated(`(()=>{const scroll=Element.prototype.scrollIntoView,hit=document.elementFromPoint.bind(document);
            window.__postFrameFixture={scrolls:0,hits:0};
            Element.prototype.scrollIntoView=function(...args){window.__postFrameFixture.scrolls++;return scroll.apply(this,args);};
            document.elementFromPoint=(...args)=>{window.__postFrameFixture.hits++;return hit(...args);};
          })()`);
          await page.act(action, observed.snapshot,{onPointerPreflight:r=>preflights.push(r)}); positive = await counters();
          const fresh=await collectXPage(page,{stage:'post',expectedUrl:'https://x.com/alice/status/123',postId:'123'});
          const freshControl=fresh.controls.find(c=>c.kind==='replies_expand')!;
          const freshAction={kind:'click' as const,index:freshControl.binding.index,snapshotId:freshControl.binding.snapshotId};
          input = measures = frames = 0;
          await isolated('window.__postFrameFixture={scrolls:0,hits:0}');
          phase = 'negative';
          if(mode==='recover')await xwc.executeJavaScript("window.postFrameOriginal.style.pointerEvents='none'");
          await page.act(freshAction, fresh.snapshot,{onPointerPreflight:r=>preflights.push(r)});
        });
      } catch (cause) { error = (cause as { code?: string }).code ?? String(cause); diagnostic = pointerFailureDiagnostic(cause) ?? null; }
      finally {
        try {
          await browser.enqueue(opened.tabId, async () => {});
          after = await counters();
          sameControl = await xwc.executeJavaScript("window.postFrameOriginal===document.querySelector('#expand')") as boolean;
        } finally {
          xwc.capturePage = capture; xwc.executeJavaScriptInIsolatedWorld = evaluate;
          xwc.debugger.sendCommand = send; logger.info = info; browser.close(opened.tabId);
        }
      }
      return { positive, after, results, receipts, preflights, observations, error, sameControl, diagnostic };
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
