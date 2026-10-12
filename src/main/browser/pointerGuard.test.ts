import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import SOURCE from './injected/pointerGuard.js?raw';
import { guardedInteractExpression, measuredPointerExpression } from './measuredPointerSource';

function fixture() {
  const dom = new JSDOM('<form id="owner"><button id="target" aria-labelledby="label"><span>Open discussion</span></button></form><div id="label">Open</div><form id="other"></form>', { url: 'https://example.org/', runScripts: 'outside-only' });
  const { window } = dom, el = window.document.querySelector('#target') as HTMLButtonElement;
  let hit: Element | null = el.firstElementChild;
  Object.assign(window.document, { elementFromPoint: () => hit });
  const world = { gen: 'document', ids: new WeakMap([[el, 7]]), pw: new WeakSet() };
  Object.assign(window, { __kydogWorld: world });
  const run = (op: string, extra = {}) => window.eval(`(${SOURCE})(${JSON.stringify({ op, token: 'token', target: { nodeId: 7 }, x: 30, y: 40, expiresAt: Date.now() + 10_000, notAfter: Date.now() + 3000, ...extra })})`);
  return { dom, window, el, world, run, setHit: (value: Element | null) => { hit = value; } };
}

describe('measured pointer permission sources', () => {
  it.each(['replace', 'cover', 'generation', 'route', 'disable', 'password', 'readonly', 'form-owner', 'form-action', 'form-replace', 'semantic', 'label-text', 'label-reference', 'href', 'descendant-href'] as const)(
    'a successful same-case control precedes rejection on %s', change => {
      const f = fixture();
      try {
        expect(f.run('capture')).toEqual({ ok: true });
        expect(f.run('validate')).toEqual({ ok: true });
        expect(f.run('capture')).toEqual({ ok: true });
        if (change === 'replace') f.el.replaceWith(f.el.cloneNode(true));
        if (change === 'cover') f.setHit(f.window.document.body);
        if (change === 'generation') f.world.gen = 'other';
        if (change === 'route') f.window.history.pushState({}, '', '/other');
        if (change === 'disable') f.el.disabled = true;
        if (change === 'password') f.world.pw.add(f.el);
        if (change === 'readonly') f.el.setAttribute('readonly', '');
        if (change === 'form-owner') f.el.setAttribute('form', 'other');
        if (change === 'form-action') f.el.form!.action = '/publish';
        if (change === 'form-replace') { const owner = f.el.form!; const next = owner.cloneNode(false); owner.replaceWith(next); next.appendChild(f.el); }
        if (change === 'semantic') f.el.setAttribute('aria-label', 'Publish');
        if (change === 'label-text') f.window.document.querySelector('#label')!.textContent = 'Publish';
        if (change === 'label-reference') { const label = f.window.document.querySelector('#label')!; label.replaceWith(label.cloneNode(true)); }
        if (change === 'href') f.el.setAttribute('href', '/other');
        if (change === 'descendant-href') f.el.firstElementChild!.setAttribute('href', '/publish');
        expect(f.run('validate')).toMatchObject({ ok: false });
      } finally { f.dom.window.close(); }
    });
  it('direct isolated document facts reject old generations before original measure can scroll', () => {
    const f = fixture();
    try {
      let scrolled = 0; f.el.scrollIntoView = () => { scrolled++; };
      const pointer = { token: 'doc', kind: 'click' as const, expiresAt: Date.now() + 3000 };
      const target = { nodeId: 7, document: { generation: 'document', url: 'https://example.org/' } };
      expect(f.window.eval(measuredPointerExpression(target, pointer, Date.now() + 3000))).toMatchObject({ ok: false, reason: 'not_visible' });
      expect(scrolled).toBe(1);
      f.world.gen = 'replacement';
      expect(f.window.eval(measuredPointerExpression(target, pointer, Date.now() + 3000))).toMatchObject({ ok: false, reason: 'stale_node' });
      expect(scrolled).toBe(1);
      f.world.gen = 'document';
      f.window.history.pushState({}, '', '/normalized');
      expect(f.window.eval(measuredPointerExpression(target, pointer, Date.now() + 3000))).toMatchObject({ ok: false, reason: 'stale_node' });
      expect(scrolled).toBe(1);
      expect(f.window.eval(guardedInteractExpression({ op: 'measure', target }, Date.now() + 3000))).toMatchObject({ ok: false, reason: 'stale_node' });
      expect(scrolled).toBe(1);
    } finally { f.dom.window.close(); }
  });
  it('dispose removes only its owned retained binding', () => {
    const f = fixture();
    try {
      expect(f.run('capture')).toEqual({ ok: true });
      expect(f.run('capture', { token: 'external' })).toEqual({ ok: true });
      expect(f.run('validate')).toEqual({ ok: true });
      expect(f.run('dispose')).toEqual({ ok: true });
      expect(f.run('validate')).toMatchObject({ ok: false });
      expect(f.run('validate', { token: 'external' })).toEqual({ ok: true });
    } finally { f.dom.window.close(); }
  });
  it('expired measure never scrolls or binds, and selector text stays a literal', () => {
    const f = fixture();
    try {
      let scrolled = 0;
      f.el.scrollIntoView = () => { scrolled++; };
      const live = measuredPointerExpression({ selector: '#target' }, { token: 'live', kind: 'click', expiresAt: Date.now() + 3000 }, Date.now() + 3000);
      expect(f.window.eval(live)).toMatchObject({ ok: false, reason: 'not_visible' });
      expect(scrolled).toBe(1); // jsdom has zero layout, but real measure reaches its scroll producer.
      scrolled = 0;
      const expression = measuredPointerExpression({ selector: '#target' }, { token: 'token', kind: 'click', expiresAt: Date.now() + 3000 }, Date.now() - 1);
      expect(f.window.eval(expression)).toMatchObject({ ok: false, reason: 'expired' });
      expect(scrolled).toBe(0);
      const injected = measuredPointerExpression({ selector: '#target"; window.injection = true; //' }, { token: 'token', kind: 'click', expiresAt: Date.now() + 3000 }, Date.now() + 3000);
      expect(f.window.eval(injected)).toMatchObject({ ok: false, reason: 'bad_selector' });
    } finally { f.dom.window.close(); }
  });
});
