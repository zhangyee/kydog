import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import SOURCE from './injected/researchDocument.js?raw';
import { observeResearchDocument, type ResearchDocumentPort } from './researchDocument';

const windows: JSDOM[] = [];
function fixture(html: string, url = 'https://example.org/article') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  windows.push(dom);
  Object.assign(dom.window, { TextEncoder });
  const run = (op: string, extra = {}): any => dom.window.eval(`(${SOURCE})(${JSON.stringify({ op, token: 'lease', url, ...extra })})`);
  run('observe');
  return { dom, document: dom.window.document, run };
}
afterEach(() => { for (const dom of windows.splice(0)) { dom.window.__kydogResearchDocument?.observer.disconnect(); dom.window.close(); } });

describe('researchDocument injected capture', () => {
  // Choosing body, the InfoQ wrapper, or an input-bearing clone leaks these same-page controls.
  it.each([
    ['https://www.infoq.cn/article/example', '<div class="article-detaile"><aside>outer-sidebar</aside><div class="article-preview">BODY</div></div>', '.article-detaile .article-preview'],
    ['https://blog.csdn.net/author/article/details/1', '<main><aside>outer-sidebar</aside><div id="content_views">BODY</div></main>', '#content_views'],
    ['https://example.org/article', '<article>BODY</article><aside>outer-sidebar</aside>', 'article'],
    ['https://example.org/article', '<main>BODY</main><aside>outer-sidebar</aside>', 'main'],
  ])('captures only the supported article root without mutating live DOM: %s / %s', (url, root, rootRule) => {
    const body = '<h1>正文证据</h1><p>多字节 😀</p><form><input value="private-form-value"></form>' +
      '<aside>inner-sidebar</aside><nav>inner-navigation</nav><iframe srcdoc="private-embed"></iframe>' +
      '<script>private-script</script><style>.private-style{}</style><p onclick="private-handler()">保留正文</p>';
    const f = fixture('<title>文章标题</title>' + root.replace('BODY', body), url);
    const before = f.document.documentElement.outerHTML;
    for (const forbidden of ['private-form-value', 'outer-sidebar', 'inner-sidebar', 'inner-navigation', 'private-embed', 'private-script', 'private-style', 'private-handler']) {
      expect(before).toContain(forbidden);
    }
    const result = f.run('capture', { maxBytes: 100_000 });
    expect(result.status).toBe('snapshot');
    expect(result.html).toContain('正文证据');
    expect(result.html).toContain('文章标题');
    expect(result.rootRule).toBe(rootRule);
    for (const forbidden of ['private-form-value', 'outer-sidebar', 'inner-sidebar', 'inner-navigation', 'private-embed', 'private-script', 'private-style', 'private-handler']) {
      expect(result.html).not.toContain(forbidden);
    }
    expect(f.document.querySelector('input')!.value).toBe('private-form-value');
    expect(f.document.documentElement.outerHTML).toBe(before);
    expect(result.utf8Bytes).toBe(new TextEncoder().encode(result.html).length);
  });

  it.each(['https://www.infoq.cn/article/example', 'https://blog.csdn.net/a/article/details/1', 'https://example.org/article'])(
    'does not fall back to body or generic roots on known sites: %s', url => {
      const root = url.includes('infoq') ? '<div class="article-detaile"><div class="article-preview">正文</div></div>'
        : url.includes('csdn') ? '<div id="content_views">正文</div>' : '<article>正文</article>';
      const f = fixture(root, url);
      expect(f.run('capture', { maxBytes: 10_000 }).status).toBe('snapshot');
      f.document.body.innerHTML = '<div>navigation text</div>' + (url.includes('example.org') ? '' : '<main>wrong article</main>');
      expect(f.run('capture', { maxBytes: 10_000 })).toMatchObject({ status: 'pending', reason: 'article_root_missing' });
    });

  it('accepts the exact UTF-8 boundary and returns only the actual size when oversize', () => {
    const f = fixture('<article><h1>中文 😀</h1><p>正文</p></article>');
    const first = f.run('capture', { maxBytes: 100_000 });
    expect(first.status).toBe('snapshot');
    const n = new TextEncoder().encode(first.html).length;
    expect(n).toBeGreaterThan(first.html.length);
    expect(f.run('capture', { maxBytes: n })).toMatchObject({ status: 'snapshot', html: first.html, utf8Bytes: n });
    const over = f.run('capture', { maxBytes: n - 1 });
    expect(over).toMatchObject({ status: 'oversize', utf8Bytes: n });
    expect(over).not.toHaveProperty('html');
  });

  it('does not lose a mutation between capture and wait, coalescing one delivered batch', async () => {
    const f = fixture('<div>shell</div>');
    const first = f.run('capture', { maxBytes: 100_000 });
    expect(first.status).toBe('pending');
    f.document.body.insertAdjacentHTML('beforeend', '<article><p>正文证据</p></article>');
    await Promise.resolve();
    await Promise.resolve();
    const next = f.run('capture', { maxBytes: 100_000 });
    expect(next.status).toBe('snapshot');
    expect(next.revision).toBe(first.revision + 1);
    f.document.querySelector('article')!.append('甲', '乙', '丙');
    await Promise.resolve();
    expect(f.run('capture', { maxBytes: 100_000 }).revision).toBe(next.revision + 1);
  });

  it('retains changes arriving during capture for the next wait', async () => {
    const f = fixture('<article><p>before</p></article>');
    const root = f.document.querySelector('article')!;
    const clone = root.cloneNode.bind(root);
    root.cloneNode = (deep) => { const captured = clone(deep); root.append('after'); return captured; };
    const capture = f.run('capture', { maxBytes: 100_000 });
    expect(capture.html).toContain('before');
    expect(root.textContent).toContain('after');
    expect(capture.html).not.toContain('after');
    await Promise.resolve();
    expect(f.run('capture', { maxBytes: 100_000 }).revision).toBeGreaterThan(capture.revision);
  });

  it('ends pending waits and invalidates captures when disposed', async () => {
    const f = fixture('<article>body</article>');
    const capture = f.run('capture', { maxBytes: 100_000 });
    expect(capture.status).toBe('snapshot');
    f.run('dispose');
    expect(f.run('capture', { maxBytes: 100_000 })).toMatchObject({ status: 'invalidated' });
  });
});

function bridgeFixture() {
  const f = fixture('<article><p>正文证据</p></article>');
  type Listener = (method: string, params: Record<string, any>, sessionId?: string) => void;
  const listeners = new Set<Listener>();
  const invalidators = new Set<(reason: string) => void>();
  let location = { currentUrl: 'https://example.org/article', documentEpoch: 4, routeRevision: 7, navigationSequence: 12, mainStatusCode: 200 };
  let contextId = 71;
  let binding = '';
  const commands: Array<{ method: string; params: Record<string, any> }> = [];
  const emit: Listener = (method, params, sessionId) => { for (const listener of listeners) listener(method, params, sessionId); };
  const port: ResearchDocumentPort = {
    location: () => ({ ...location }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeInvalidation: listener => { invalidators.add(listener); return () => { invalidators.delete(listener); }; },
    sendCommand: async (method, params = {}) => {
      commands.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: contextId };
      if (method === 'Runtime.addBinding') {
        binding = String(params.name);
        Object.assign(f.dom.window, { [binding]: (payload: string) => emit('Runtime.bindingCalled', { name: binding, payload, executionContextId: contextId }) });
        return {};
      }
      if (method === 'Runtime.evaluate') return { result: { value: f.dom.window.eval(String(params.expression)) } };
      return {};
    },
  };
  const signal = new AbortController();
  const open = () => observeResearchDocument(port, signal.signal);
  return { ...f, open, port, signal, commands, listeners, emit, invalidators,
    location: () => location, setLocation: (value: Partial<typeof location>) => { location = { ...location, ...value }; },
    binding: () => binding, setContext: (id: number) => { contextId = id; } };
}

describe('researchDocument trusted lease', () => {
  it.each(['documentEpoch', 'routeRevision', 'navigationSequence', 'currentUrl', 'pageUrl'] as const)(
    'rejects changed %s after a successful same-identity capture', async field => {
      const f = bridgeFixture();
      const lease = await f.open();
      const good = await lease.capture(100_000);
      expect(good).toMatchObject({ status: 'snapshot', document: { identity: { documentEpoch: 4, routeRevision: 7, navigationSequence: 12 }, mainStatusCode: 200 } });
      if (field === 'pageUrl') f.dom.window.history.pushState({}, '', '/other');
      else if (field === 'currentUrl') f.setLocation({ currentUrl: 'https://example.org/other' });
      else f.setLocation({ [field]: f.location()[field] + 1 });
      expect(await lease.capture(100_000)).toMatchObject({ status: 'invalidated' });
      await lease.dispose();
    });

  it('invalidates a result if main-process identity changes while capture is in flight', async () => {
    const f = bridgeFixture(), lease = await f.open();
    expect((await lease.capture(100_000)).status).toBe('snapshot');
    const send = f.port.sendCommand;
    f.port.sendCommand = async (method, params) => {
      const response = await send(method, params);
      if (method === 'Runtime.evaluate') f.setLocation({ documentEpoch: 5 });
      return response;
    };
    expect(await lease.capture(100_000)).toMatchObject({ status: 'invalidated' });
    await lease.dispose();
  });

  it('retains mutation events arriving between capture and wait without issuing polling evaluations', async () => {
    const f = bridgeFixture(), lease = await f.open();
    const first = await lease.capture(100_000);
    f.document.querySelector('article')!.append('new evidence');
    await Promise.resolve();
    const before = f.commands.length;
    await lease.waitForChange(first.revision);
    expect(f.commands.length).toBe(before);
    const next = await lease.capture(100_000);
    expect(next).toMatchObject({ status: 'snapshot' });
    expect(next.revision).toBeGreaterThan(first.revision);
    await lease.dispose();
  });

  it.each(['main-world', 'subframe', 'stale-context', 'wrong-binding', 'wrong-token', 'session', 'old-revision'])(
    'does not accept forged %s events after a genuine event control', async kind => {
      const f = bridgeFixture(), lease = await f.open();
      const first = await lease.capture(100_000);
      f.document.querySelector('article')!.append('real event');
      await lease.waitForChange(first.revision);
      const next = await lease.capture(100_000);
      const observe = f.commands.find(c => c.method === 'Runtime.evaluate')!;
      const token = /"token":"([^"]+)"/.exec(String(observe.params.expression))![1];
      let woke = false;
      const wait = lease.waitForChange(next.revision).then(() => { woke = true; });
      f.emit('Runtime.bindingCalled', {
        name: kind === 'wrong-binding' ? 'other' : f.binding(),
        executionContextId: ['main-world', 'subframe', 'stale-context'].includes(kind) ? 72 : 71,
        payload: JSON.stringify({ token: kind === 'wrong-token' ? 'other' : token,
          revision: kind === 'old-revision' ? next.revision : next.revision + 1, url: f.location().currentUrl }),
      }, kind === 'session' ? 'child-session' : undefined);
      await Promise.resolve(); await Promise.resolve();
      expect(woke).toBe(false);
      f.document.querySelector('article')!.append('second real event');
      await wait;
      expect(woke).toBe(true);
      await lease.dispose();
    });

  it.each(['abort', 'dispose', 'destroyed', 'crashed', 'context', 'contexts-cleared', 'frame', 'navigation'])(
    'ends waits on %s and preserves unrelated debugger listeners', async kind => {
      const f = bridgeFixture(), unrelated: string[] = [];
      const detach = f.port.subscribe(method => { unrelated.push(method); });
      const lease = await f.open();
      const first = await lease.capture(100_000);
      expect(first.status).toBe('snapshot');
      const waiting = lease.waitForChange(first.revision);
      if (kind === 'abort') f.signal.abort();
      else if (kind === 'dispose') await lease.dispose();
      else if (kind === 'context') f.emit('Runtime.executionContextDestroyed', { executionContextId: 71 });
      else if (kind === 'contexts-cleared') f.emit('Runtime.executionContextsCleared', {});
      else if (kind === 'frame') f.emit('Page.frameDetached', { frameId: 'main' });
      else if (kind === 'navigation') f.emit('Page.frameNavigated', { frame: { id: 'main' } });
      else for (const fn of [...f.invalidators]) fn(kind);
      await waiting;
      expect(await lease.capture(100_000)).toMatchObject({ status: 'invalidated' });
      await lease.dispose();
      f.emit('Network.responseReceived', {});
      expect(unrelated).toContain('Network.responseReceived');
      expect(f.listeners.size).toBe(1);
      expect(f.commands.some(c => c.method === 'Runtime.addBinding')).toBe(true);
      expect(f.commands.some(c => c.method === 'Runtime.disable' || c.method === 'Debugger.detach')).toBe(false);
      detach();
    });
});

describe('researchDocument setup lifetime', () => {
  it('cleans up a binding acknowledged after cancellation during setup', async () => {
    const f = bridgeFixture();
    const send = f.port.sendCommand;
    let release!: () => void, reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    f.port.sendCommand = async (method, params) => {
      const value = await send(method, params);
      if (method === 'Runtime.addBinding') { reached(); await new Promise<void>(resolve => { release = resolve; }); }
      return value;
    };
    const opening = f.open();
    const rejected = expect(opening).rejects.toThrow();
    await entered;
    f.signal.abort(); release();
    await rejected;
    expect(f.commands.some(command => command.method === 'Runtime.addBinding')).toBe(true);
    expect(f.commands.some(command => command.method === 'Runtime.removeBinding')).toBe(true);
    expect(f.listeners.size).toBe(0);
  });

  it('disconnects a same-document observer after the URL changes', async () => {
    const f = bridgeFixture(), lease = await f.open();
    expect((await lease.capture(100_000)).status).toBe('snapshot');
    expect(f.dom.window.__kydogResearchDocument).toBeDefined();
    f.dom.window.history.pushState({}, '', '/other');
    f.setLocation({ currentUrl: 'https://example.org/other', routeRevision: 8 });
    expect((await lease.capture(100_000)).status).toBe('invalidated');
    await lease.dispose();
    const state = f.dom.window.__kydogResearchDocument;
    expect(state).toBeUndefined();
  });
});

describe('researchDocument observer scope', () => {
  it('ignores unrelated sidebar edits after observing a real article edit', async () => {
    const f = fixture('<main><article>body</article><aside>sidebar</aside></main>');
    const initial = f.run('capture', { maxBytes: 100_000 });
    f.document.querySelector('article')!.append('evidence');
    await Promise.resolve();
    const changed = f.run('capture', { maxBytes: 100_000 });
    expect(changed.revision).toBeGreaterThan(initial.revision);
    f.document.querySelector('aside')!.append('advertisement');
    await Promise.resolve();
    expect(f.run('capture', { maxBytes: 100_000 }).revision).toBe(changed.revision);
    f.document.querySelector('article')!.replaceWith(f.document.createElement('article'));
    await Promise.resolve();
    expect(f.run('capture', { maxBytes: 100_000 }).revision).toBeGreaterThan(changed.revision);
  });
});

describe('researchDocument failed setup cleanup', () => {
  it.each(['binding', 'observer'] as const)('cleans issued %s resources even when their command result is lost', async stage => {
    const f = bridgeFixture();
    const good = await f.open();
    expect((await good.capture(100_000)).status).toBe('snapshot');
    await good.dispose();
    const start = f.commands.length;
    const send = f.port.sendCommand;
    f.port.sendCommand = async (method, params) => {
      const value = await send(method, params);
      if (stage === 'binding' && method === 'Runtime.addBinding'
        || stage === 'observer' && method === 'Runtime.evaluate' && String(params?.expression).includes('"op":"observe"')) {
        throw new Error('command_result_lost');
      }
      return value;
    };
    await expect(f.open()).rejects.toThrow('command_result_lost');
    expect(f.commands.slice(start).some(c => c.method === 'Runtime.removeBinding')).toBe(true);
    expect(f.dom.window.__kydogResearchDocument).toBeUndefined();
  });
});
