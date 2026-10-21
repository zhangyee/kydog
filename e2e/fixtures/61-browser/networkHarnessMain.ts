import { app, BrowserWindow, session, webContents, type WebContents } from 'electron';
import { BrowserService } from '../../../src/main/browser/browserService';
import { BROWSER_PARTITION } from '../../../src/main/browser/partition';
import type { BrowserNetworkLease } from '../../../src/main/browser/networkResponses';

type Trace = { seq: number; event: string; method?: string; pid?: number; wcId?: number; reason?: string; history?: { index: number; urls: string[] } };
export interface NetworkHarnessResult {
  tabId: string; history: { canGoBack: boolean; urls: string[] }; trace: Trace[]; events: Array<{ kind: string; bytes?: number; sha256?: string; body?: string; navigationId?: string; isMainFrame?:boolean|null; sessionId?:string|null; reason?: string }>;
}
export interface NetworkHarness {
  configure(port: number, cert: string): Promise<void>;
  capture(name: string, tabId?: string): Promise<NetworkHarnessResult>;
  end(kind: 'detach' | 'crash'): Promise<{ closed: string }>;
}
declare global { var networkHarness: NetworkHarness }
let trace: Trace[] = [], sequence = 0;
let gate: { name: string; wcId?: number; release: () => void; promise: Promise<void>; armed: boolean } | undefined;
const record = (event: string, wc: WebContents, method?: string) => trace.push({ seq: ++sequence, event, method, pid: wc.getOSProcessId(), wcId: wc.id });
// Test-owned transparent wrapper: forwards every actual production command. It
// gates only return of the existing awaited viewport ACK after target commit.
// BrowserService still resolves at commit (not load completion); no product seam.
app.on('web-contents-created', (_event, wc) => {
  record('created', wc);
  trace[trace.length - 1].history = { index: wc.navigationHistory.getActiveIndex(), urls: wc.navigationHistory.getAllEntries().map(e => e.url) };
  wc.on('did-navigate', (_event, url) => { if (gate && url === `https://example.org/page/${gate.name}`) { gate.wcId = wc.id; gate.armed = true; record('target-committed', wc); } });
  const send = wc.debugger.sendCommand.bind(wc.debugger);
  wc.debugger.sendCommand = async (method, params, sessionId) => {
    record('command', wc, method);
    let result;
    try { result = await send(method, params, sessionId); }
    catch (error) { trace.push({ seq: ++sequence, event: 'command-failed', method, reason: String(error) }); throw error; }
    if (method === 'Network.getResponseBody' && gate?.wcId === wc.id) {
      record('body-settled', wc, method);
      gate.release();
      // Release the controlled load-blocking subresource after the real body read.
      await session.fromPartition(BROWSER_PARTITION).fetch(`https://example.org/release/${gate.name}`);
    }
    if (method === 'Emulation.setDeviceMetricsOverride' && gate?.armed && gate.wcId === wc.id) await gate.promise;
    return result;
  };
});
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1024, height: 720, webPreferences: { sandbox: true } });
  void win.loadURL('about:blank');
  const service = new BrowserService(); service.attach(win);
  let lastLease: BrowserNetworkLease | undefined, lastTab: string | undefined, lastWcId: number | undefined;
  globalThis.networkHarness = {
    async configure(port, cert) {
      const ses = session.fromPartition(BROWSER_PARTITION);
      await ses.setProxy({ proxyRules: `http://127.0.0.1:${port}` });
      ses.setCertificateVerifyProc((req, cb) => cb(req.hostname === 'example.org' && req.certificate.data.replace(/\s/g, '') === cert.replace(/\s/g, '') ? 0 : -3));
    },
    async capture(name, tabId) {
      trace = []; sequence = 0;
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      gate = { name, release, promise, armed: false };
      const timer = setTimeout(release, 5000); // bounded test failure, never a success criterion
      try {
        const opened = await service.open({ url: `https://example.org/page/${name}`, tabId,
          network: { ownerId: 'network-fixture', accepts: request => request.url === `https://example.org/body/${name}` } });
        const wc = webContents.getAllWebContents().find(w => w.getURL() === `https://example.org/page/${name}`)!;
        record('open-resolved', wc);
        lastLease = opened.networkLease!; lastTab = opened.tabId; lastWcId = wc.id;
        // consume real queue only after the handle is returned
        const events = await lastLease.drain();
        return { tabId: opened.tabId, history: { canGoBack: wc.navigationHistory.canGoBack(), urls: wc.navigationHistory.getAllEntries().map(e => e.url) }, trace: [...trace], events: events.map(e => e.kind === 'response'
          ? { kind: e.kind, bytes: e.bytes, sha256: e.sha256, ...(name === 'top' ? {} : { body: e.body }), navigationId: e.request.navigationId, isMainFrame:e.request.isMainFrame, sessionId:e.request.sessionId }
          : { kind: e.kind, ...('reason' in e ? { reason: e.reason } : {}) }) };
      } catch (error) { throw new Error(`${String(error)}; trace=${JSON.stringify(trace)}; states=${JSON.stringify(webContents.getAllWebContents().map(w => ({ pid: w.getOSProcessId(), url: w.getURL(), length: w.navigationHistory.length(), index: w.navigationHistory.getActiveIndex(), entries: w.navigationHistory.getAllEntries().map(e => e.url) })))}`); }
      finally { clearTimeout(timer); release(); gate = undefined; }
    },
    async end(kind) {
      if (!lastLease || !lastTab) throw new Error('capture required');
      const wc = webContents.fromId(lastWcId!)!;
      const waiting = lastLease.take(undefined, 5000);
      if (kind === 'detach') wc.debugger.detach(); else wc.forcefullyCrashRenderer();
      const result = await waiting;
      return { closed: result.kind };
    },
  };
  app.on('before-quit', () => service.disposeAll());
});
