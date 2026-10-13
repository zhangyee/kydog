import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import SOURCE from './injected/pointerGuard.js?raw';
import { KydogError } from '../../shared/errors';
import { pointerFailureDiagnostic, retainPointerFailure } from './pointerDiagnostic';
import { collectedPointerEligibilityExpression, guardedInteractExpression, measuredPointerExpression, pointerGuardExpression } from './measuredPointerSource';

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


it.each(['focus', 'collapsed', 'partial'] as const)('typing guard requires the same selected destination at the last boundary: %s', change => {
  const dom = new JSDOM('<input id="target" value="original"><input id="other" value="other value">', { url: 'https://example.org/', runScripts: 'outside-only' });
  const { window } = dom, el = window.document.querySelector('#target') as HTMLInputElement;
  Object.assign(window.document, { elementFromPoint: () => el });
  Object.assign(window, { __kydogWorld: { gen: 'doc', ids: new WeakMap([[el, 7]]), pw: new WeakSet() } });
  const run = (op: string) => window.eval(`(${SOURCE})(${JSON.stringify({ op, kind: 'type', token: 'typing', target: { nodeId: 7 }, x: 10, y: 10, expiresAt: Date.now() + 3000, notAfter: Date.now() + 3000 })})`);
  try {
    expect(run('capture')).toEqual({ ok: true }); el.focus(); el.select();
    expect(run('validate_typing')).toEqual({ ok: true });
    if (change === 'focus') (window.document.querySelector('#other') as HTMLInputElement).focus();
    if (change === 'collapsed') el.setSelectionRange(3, 3);
    if (change === 'partial') el.setSelectionRange(0, 3);
    expect(run('validate_typing')).toMatchObject({ ok: false, reason: 'typing_destination_changed' });
  } finally { window.close(); }
});


it.each(['email', 'number'] as const)('nonempty %s with unavailable selection offsets is unproven rather than assumed selected', type => {
  const dom = new JSDOM('<input id="target" value="original">', { url: 'https://example.org/', runScripts: 'outside-only' });
  const { window } = dom, el = window.document.querySelector('#target') as HTMLInputElement;
  Object.assign(window.document, { elementFromPoint: () => el });
  Object.assign(window, { __kydogWorld: { gen: 'doc', ids: new WeakMap([[el, 7]]), pw: new WeakSet() } });
  const run = (op: string) => window.eval(`(${SOURCE})(${JSON.stringify({ op, kind: 'type', token: 'typing', target: { nodeId: 7 }, x: 10, y: 10, expiresAt: Date.now() + 3000, notAfter: Date.now() + 3000 })})`);
  try {
    expect(run('capture')).toEqual({ ok: true }); el.focus(); el.select();
    expect(run('validate_typing')).toEqual({ ok: true });
    el.type = type; el.value = type === 'number' ? '1234' : 'old@example.org';
    expect(el.value).toBe(type === 'number' ? '1234' : 'old@example.org');
    expect(run('capture')).toEqual({ ok: true }); el.focus(); el.select();
    expect(el.selectionStart).toBe(null);
    expect(run('validate_typing')).toMatchObject({ ok: false, reason: 'typing_selection_unproven' });
    el.value = '';
    expect(run('validate_typing')).toEqual({ ok: true });
  } finally { window.close(); }
});

it('contenteditable typing requires the actual full target Range after a same-case successful selection', () => {
  const dom = new JSDOM('<div id="target" tabindex="0" contenteditable="true">rich <b>text</b></div>', { url: 'https://example.org/', runScripts: 'outside-only' });
  const { window } = dom, el = window.document.querySelector('#target') as HTMLElement;
  Object.defineProperty(el, 'isContentEditable', { value: true });
  Object.assign(window.document, { elementFromPoint: () => el });
  Object.assign(window, { __kydogWorld: { gen: 'doc', ids: new WeakMap([[el, 7]]), pw: new WeakSet() } });
  const run = (op: string) => window.eval(`(${SOURCE})(${JSON.stringify({ op, kind: 'type', token: 'typing', target: { nodeId: 7 }, x: 10, y: 10, expiresAt: Date.now() + 3000, notAfter: Date.now() + 3000 })})`);
  try {
    expect(run('capture')).toEqual({ ok: true }); el.focus();
    const selection = window.getSelection()!, full = window.document.createRange(); full.selectNodeContents(el);
    selection.removeAllRanges(); selection.addRange(full);
    expect(run('validate_typing')).toEqual({ ok: true });
    const partial = window.document.createRange(); partial.selectNodeContents(el.querySelector('b')!);
    selection.removeAllRanges(); selection.addRange(partial);
    expect(run('validate_typing')).toMatchObject({ ok: false, reason: 'typing_destination_changed' });
  } finally { window.close(); }
});

it('collection namespaces revoke only their owner and keep unrelated native bindings',()=>{
  const f=fixture();
  try {
    const remember=(owner:string,namespace:string)=>{
      expect(f.run('begin_collected',{owner,namespace})).toEqual({ok:true});
      const permission={owner,token:owner+namespace,purpose:'fixed'};
      const request={op:'remember_collected',namespace,permission,nodeId:7};
      expect(f.window.eval(`(${SOURCE})({...${JSON.stringify(request)},el:document.querySelector('#target'),scopes:[]})`)).toEqual({ok:true});
      return permission;
    };
    const first=remember('x','first'), external=remember('other','first');
    const validate=(permission:typeof first)=>f.run('validate_collected',{target:{nodeId:7,collectedPermission:permission}});
    expect(f.run('capture')).toEqual({ok:true});
    expect(validate(first)).toEqual({ok:true});expect(validate(external)).toEqual({ok:true});
    expect(f.run('begin_collected',{owner:'x',namespace:'empty'})).toEqual({ok:true});
    expect(validate(first)).toMatchObject({ok:false});
    expect(validate(external)).toEqual({ok:true});
    expect(f.run('validate')).toEqual({ok:true});
  }finally{f.dom.window.close();}
});


it('interception retains the exact rejected hit and point without a second hit test or raw page strings', () => {
  const f = fixture();
  try {
    expect(f.run('capture')).toEqual({ ok: true });
    expect(f.run('validate')).toEqual({ ok: true });
    const cover = f.window.document.createElement('aside');
    cover.textContent = 'private text'; cover.id = 'secret-id';
    f.window.document.body.append(cover);
    let calls = 0;
    Object.assign(f.window.document, { elementFromPoint: () => { calls++; return cover; } });
    Object.assign(f.el, { getBoundingClientRect: () => ({ x: 11, y: 12, width: 71, height: 93 }) });
    const rejected = f.run('validate');
    expect(rejected).toEqual({ ok: false, reason: 'intercepted', pointerFailure: {
      point: { x: 30, y: 40 }, targetTag: 'BUTTON', hitTag: 'ASIDE',
      targetConnected: true, targetContainsHit: false, hitSameAsCaptured: false,
      rejectGeometry: { targetRect: { x: 11, y: 12, width: 71, height: 93 },
        scroll: { x: 0, y: 0 }, viewport: { width: 1024, height: 768 } },
    } });
    expect(calls).toBe(1);
    expect(f.run('dispose')).toEqual({ ok: true });
  } finally { f.window.close(); }
});


it('selector capture and a null validate hit retain source facts; a failed diagnostic read preserves refusal', () => {
  const f = fixture();
  try {
    expect(f.run('capture', { target: { selector: '#target' } })).toEqual({ ok: true });
    expect(f.run('validate')).toEqual({ ok: true });
    f.setHit(null);
    expect(f.run('validate')).toMatchObject({ ok: false, reason: 'intercepted',
      pointerFailure: { point: { x: 30, y: 40 }, hitTag: null, hitSameAsCaptured: false } });
    expect(f.run('capture', { target: { selector: '#target' } })).toMatchObject({ ok: false, reason: 'intercepted',
      pointerFailure: { point: { x: 30, y: 40 }, hitTag: null, hitSameAsCaptured: null } });
    f.el.getBoundingClientRect = () => { throw new Error('diagnostic read failed'); };
    expect(f.run('validate')).toEqual({ ok: false, reason: 'intercepted' });
  } finally { f.window.close(); }
});


it('retains an authentic same-hit rejection when a decorative descendant moves outside the target', () => {
  const f = fixture();
  try {
    const decorative = f.window.document.createElement('span');
    f.el.append(decorative);
    f.setHit(decorative);
    f.el.getBoundingClientRect = () => ({ x: 6, y: 7, width: 61, height: 41 } as DOMRect);
    expect(f.el.contains(decorative)).toBe(true);
    expect(f.run('capture')).toEqual({ ok: true });
    expect(f.run('validate')).toEqual({ ok: true });
    f.window.document.body.append(decorative);
    expect(f.el.contains(decorative)).toBe(false);
    const rejected = f.run('validate');
    expect(rejected).toMatchObject({ ok: false, reason: 'intercepted', pointerFailure: {
      point: { x: 30, y: 40 }, targetTag: 'BUTTON', hitTag: 'SPAN',
      targetConnected: true, targetContainsHit: false, hitSameAsCaptured: true,
      rejectGeometry: { targetRect: { x: 6, y: 7, width: 61, height: 41 } },
    } });
    const retained = retainPointerFailure(new KydogError('browser.click_intercepted', 'intercepted'),
      { tabId: 'tab-source', snapshotId: 'snapshot-source', generation: 'document', nodeId: 7 },
      'pointer_validate', rejected, { x: 30, y: 40 });
    expect(retained.code).toBe('browser.click_intercepted');
    expect(pointerFailureDiagnostic(retained)).toMatchObject({ stage: 'pointer_validate', reason: 'intercepted',
      tabId: 'tab-source', snapshotId: 'snapshot-source', generation: 'document', nodeId: 7,
      point: { x: 30, y: 40 }, nativeFrameObserved: true,
      rejection: { targetContainsHit: false, hitSameAsCaptured: true, hitTag: 'SPAN' },
    });
  } finally { f.window.close(); }
});


it('initial measure retains the same rejected hit and original point through private validation', () => {
  const f = fixture();
  try {
    const cover = f.window.document.createElement('aside');
    cover.id = 'private-id'; cover.className = 'private-class'; cover.textContent = 'private text';
    f.window.document.body.append(cover);
    let hit: Element | null = f.el, hits = 0, scrolls = 0, targetReads = 0, hitReads = 0;
    Object.assign(f.window, { scrollX: 9, scrollY: 52 });
    Object.assign(f.window.document, { elementFromPoint: () => { hits++; return hit; } });
    f.el.scrollIntoView = () => { scrolls++; };
    f.el.getBoundingClientRect = () => (++targetReads === 1
      ? { x: 11, y: 12, left: 11, top: 12, width: 71, height: 94 }
      : { x: 111, y: 112, left: 111, top: 112, width: 171, height: 194 }) as DOMRect;
    cover.getBoundingClientRect = () => { hitReads++; return { x: 17, y: 19, width: 507, height: 611 } as DOMRect; };
    const measure = () => f.window.eval(guardedInteractExpression({ op: 'measure', target: { nodeId: 7 } }, Date.now() + 3000)) as Record<string, unknown>;
    expect(measure()).toMatchObject({ ok: true, x: 47, y: 59 });
    expect({ hits, scrolls, targetReads, hitReads }).toEqual({ hits: 1, scrolls: 1, targetReads: 1, hitReads: 0 });
    hits = scrolls = targetReads = hitReads = 0; hit = cover;
    const rejected = measure();
    const wanted = { point: { x: 47, y: 59 }, targetTag: 'BUTTON', hitTag: 'ASIDE', targetConnected: true,
      targetContainsHit: false, hitSameAsCaptured: null,
      measureContext: {
        relation: { hitConnected: true, hitContainsTarget: false },
        targetStyle: { display: 'inline-block', visibility: 'visible', pointerEvents: 'auto', contentVisibility: 'visible' },
        hitStyle: { display: 'block', visibility: 'visible', pointerEvents: 'auto', contentVisibility: 'visible' },
        targetAutoVisibility: { apiAvailable: false, optionObserved: null, value: null, readError: false },
        contentVisibilityAncestors: { chain: 'parentNode-host', complete: true, entries: [] },
      }, rejectGeometry: {
        targetRect: { x: 11, y: 12, width: 71, height: 94 }, hitRect: { x: 17, y: 19, width: 507, height: 611 },
        scroll: { x: 9, y: 52 }, viewport: { width: 1024, height: 768 },
      } };
    expect(rejected).toMatchObject({ ok: false, reason: 'intercepted', x: 47, y: 59 });
    expect(rejected.pointerFailure).toEqual(wanted);
    expect({ hits, scrolls, targetReads, hitReads }).toEqual({ hits: 1, scrolls: 1, targetReads: 1, hitReads: 1 });
    const retained = retainPointerFailure(new KydogError('browser.click_intercepted', 'refused'),
      { tabId: 'tab-source', snapshotId: 'snapshot-source', generation: 'document', nodeId: 7 }, 'measure', rejected);
    expect(pointerFailureDiagnostic(retained)).toMatchObject({ stage: 'measure', point: { x: 47, y: 59 },
      nativeFrameObserved: false, rejection: wanted });
    hits = scrolls = targetReads = hitReads = 0; hit = null;
    expect(measure().pointerFailure).toMatchObject({ hitTag: null, rejectGeometry: { hitRect: null } });
    expect({ hits, scrolls, targetReads, hitReads }).toEqual({ hits: 1, scrolls: 1, targetReads: 1, hitReads: 0 });
    hits = scrolls = targetReads = hitReads = 0; hit = cover;
    cover.getBoundingClientRect = () => { throw new Error('diagnostic geometry unavailable'); };
    const unavailable = measure();
    expect(unavailable).toMatchObject({ ok: false, reason: 'intercepted', x: 47, y: 59 });
    expect(unavailable.pointerFailure).toBeUndefined();
    expect({ hits, scrolls }).toEqual({ hits: 1, scrolls: 1 });
  } finally { f.window.close(); }
});


it('collected eligibility reads the original permitted control and generic validation remains readonly',()=>{
 const f=fixture();try{
 const permission={owner:'x',token:'original',purpose:'body'};
 f.run('begin_collected',{owner:'x',namespace:'n'});
 f.window.eval(`(${SOURCE})({...${JSON.stringify({op:'remember_collected',namespace:'n',permission,nodeId:7,notAfter:Date.now()+3000})},el:document.querySelector('#target'),scopes:[{el:document.querySelector('#owner'),semantic:false}]})`);
 const target={nodeId:7,collectedPermission:permission};let reads=0;const original=f.window.getComputedStyle.bind(f.window);
 f.window.getComputedStyle=el=>{expect(el).toBe(f.el);reads++;return original(el);};
 expect(f.run('validate_collected',{target,readPointerEligibility:true})).toEqual({ok:true,pointerEligibility:'auto'});expect(reads).toBe(1);
 expect(f.run('validate_collected',{target})).toEqual({ok:true});expect(reads).toBe(1);
 f.el.style.pointerEvents='none';expect(f.run('validate_collected',{target,readPointerEligibility:true})).toEqual({ok:true,pointerEligibility:'none'});
 f.el.style.pointerEvents='painted';expect(f.run('validate_collected',{target,readPointerEligibility:true})).toEqual({ok:true,pointerEligibility:'unknown'});
 f.window.getComputedStyle=()=>{throw Error('unreadable');};expect(f.run('validate_collected',{target,readPointerEligibility:true})).toEqual({ok:true,pointerEligibility:'unknown'});
 f.window.getComputedStyle=()=>{reads++;throw Error('invalid permission must not read');};f.el.form!.action='/repurposed';
 expect(f.run('validate_collected',{target,readPointerEligibility:true})).toEqual({ok:false,reason:'pointer_target_changed'});expect(reads).toBe(3);
 }finally{f.window.close();}
});

it('fixed eligibility expression checks raw generation and location before even reading computed state',()=>{
 const f=fixture();try{
 const permission={owner:'x',token:'original',purpose:'body'};f.run('begin_collected',{owner:'x',namespace:'n'});
 f.window.eval(`(${SOURCE})({...${JSON.stringify({op:'remember_collected',namespace:'n',permission,nodeId:7,notAfter:Date.now()+3000})},el:document.querySelector('#target'),scopes:[]})`);
 const target={nodeId:7,collectedPermission:permission,document:{generation:'document',url:'https://example.org/'}};
 let reads=0;const original=f.window.getComputedStyle.bind(f.window);f.window.getComputedStyle=el=>{reads++;return original(el);};
 const run=()=>f.window.eval(collectedPointerEligibilityExpression(target,Date.now()+3000));
 expect(run()).toEqual({ok:true,pointerEligibility:'auto'});expect(reads).toBe(1);
 f.world.gen='new';expect(run()).toEqual({ok:false,reason:'stale_node'});expect(reads).toBe(1);
 f.world.gen='document';f.window.history.pushState({},'', '/different');expect(run()).toEqual({ok:false,reason:'stale_node'});expect(reads).toBe(1);
 }finally{f.window.close();}
});


it('post-frame sample precedes the first hit and copies its enum once while preserving authentic refusal', () => {
  const f = fixture();
  try {
    const permission = { owner: 'x', token: 'original', purpose: 'body' };
    expect(f.run('begin_collected', { owner: 'x', namespace: 'n' })).toEqual({ ok: true });
    expect(f.window.eval(`(${SOURCE})({...${JSON.stringify({ op: 'remember_collected', namespace: 'n', permission, nodeId: 7 })},el:document.querySelector('#target'),scopes:[]})`)).toEqual({ ok: true });
    expect(f.run('capture', { kind: 'click', target: { nodeId: 7, collectedPermission: permission } })).toEqual({ ok: true });
    const pointer = { token: 'token', kind: 'click' as const, expiresAt: Date.now() + 3000 };
    const validate = () => f.window.eval(pointerGuardExpression('validate', pointer, Date.now() + 3000, true));
    const style = f.window.getComputedStyle.bind(f.window);
    let samples = 0, hits = 0;
    const order: string[] = [];
    f.window.getComputedStyle = el => {
      const native = style(el);
      Object.defineProperty(native, 'pointerEvents', { get: () => { samples++; order.push('sample'); return samples === 1 ? f.el.style.pointerEvents || 'auto' : 'painted'; } });
      return native;
    };
    Object.assign(f.window.document, { elementFromPoint: () => { hits++; order.push('hit'); return f.el.firstElementChild; } });
    expect(validate()).toEqual({ ok: true, postFramePointerEligibility: 'auto', postFrameHitConnected: true, postFrameHitContainsTarget: false });
    expect({ samples, hits, order }).toEqual({ samples: 1, hits: 1, order: ['sample', 'hit'] });
    samples = hits = 0; order.length = 0;
    f.el.style.pointerEvents = 'none';
    Object.assign(f.window.document, { elementFromPoint: () => { hits++; order.push('hit'); f.el.style.pointerEvents = 'auto'; return f.window.document.body; } });
    expect(validate()).toMatchObject({ ok: false, reason: 'intercepted', postFramePointerEligibility: 'none', postFrameHitConnected: true, postFrameHitContainsTarget: true, pointerFailure: { hitSameAsCaptured: false } });
    expect({ samples, hits, order }).toEqual({ samples: 1, hits: 1, order: ['sample', 'hit'] });
    samples = hits = 0; order.length = 0;
    Object.assign(f.window.document, { elementFromPoint: () => { hits++; order.push('hit'); f.el.style.pointerEvents = 'none'; return f.window.document.body; } });
    expect(validate()).toMatchObject({ ok: false, reason: 'intercepted', postFramePointerEligibility: 'auto', postFrameHitConnected: true, postFrameHitContainsTarget: true });
    expect({ samples, hits, order }).toEqual({ samples: 1, hits: 1, order: ['sample', 'hit'] });
    samples = hits = 0; order.length = 0; f.el.style.pointerEvents = 'painted';
    expect(validate()).toMatchObject({ ok: false, reason: 'intercepted', postFramePointerEligibility: 'unknown' });
    expect({ samples, hits, order }).toEqual({ samples: 1, hits: 1, order: ['sample', 'hit'] });
    f.window.getComputedStyle = el => {
      const native = style(el);
      Object.defineProperty(native, 'pointerEvents', { get: () => { throw Error('unreadable CSS scalar'); } });
      return native;
    };
    const outside = f.window.document.body;
    Object.defineProperty(outside, 'isConnected', { configurable: true, get: () => { throw Error('unreadable connected scalar'); } });
    outside.contains = () => { throw Error('unreadable containment scalar'); };
    Object.assign(f.window.document, { elementFromPoint: () => outside });
    expect(validate()).toMatchObject({ ok: false, reason: 'intercepted', postFramePointerEligibility: 'unknown', postFrameHitConnected: null, postFrameHitContainsTarget: null });
    Object.assign(f.window.document, { elementFromPoint: () => null });
    expect(validate()).toMatchObject({ ok: false, reason: 'intercepted', postFrameHitConnected: null, postFrameHitContainsTarget: null });
    Object.assign(f.window.document, { elementFromPoint: () => f.window.document.body });
    samples = 0;
    expect((f.run('validate') as { postFramePointerEligibility?: unknown }).postFramePointerEligibility).toBeUndefined();
    expect(f.run('validate')).toMatchObject({ ok: false, reason: 'intercepted' });
    expect(f.run('validate_typing', { readPostFramePointerEligibility: true })).toMatchObject({ ok: false, reason: 'intercepted' });
    expect(samples).toBe(0);
  } finally { f.window.close(); }
});
