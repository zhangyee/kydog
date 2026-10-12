/** Standalone local-only fixture. It imports production services; no test RPC
 * or evaluator is added to the application or to XQueuedPage. */
import { app, BrowserWindow, session, type WebContentsView } from 'electron';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { BrowserService } from '../../../src/main/browser/browserService';
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

void app.whenReady().then(async () => {
  const sockets = new Set<Socket>();
  const proxy = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://invalid.test');
    if (!['example.com', 'example.org'].includes(url.hostname)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const portNumber = (proxy.address() as AddressInfo).port;
  const ses = session.fromPartition(BROWSER_PARTITION);
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
    faults: async (mode: 'cover' | 'replace' | 'cancel' | 'password' | 'form-owner' | 'semantic') => {
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
      let error: string | null = null;
      try {
        await act(mode === 'password' ? { kind: 'type', selector: '#password', text: 'blocked' } : { kind: 'click', selector: '#open' }, abort.signal);
      } catch (cause) { error = (cause as { code?: string }).code ?? String(cause); }
      finally { wc.capturePage = original; }
      const after = await read();
      await wc.executeJavaScript("document.querySelector('#cover')?.remove();document.querySelector('#open').removeAttribute('aria-label');document.querySelector('#open').removeAttribute('form');document.querySelector('#other')?.remove()");
      return { before, after, error };
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
