// Retain exact DOM permission sources across a compositor ACK. Never scroll,
// rebind, wait for X readiness, or select a replacement point/element.
(req) => {
  const key = Symbol.for('kydog.pointerGuard');
  const discard = () => {
    const registry = globalThis[key], entry = registry && registry.get(req.token);
    if (entry) clearTimeout(entry.timer);
    if (registry) { registry.delete(req.token); if (!registry.size) delete globalThis[key]; }
    return entry;
  };
  if (req.op === 'dispose') { discard(); return { ok: true }; }
  const reject = (reason) => ({ ok: false, reason });
  if (Date.now() > req.notAfter) { discard(); return reject('expired'); }
  const world = window.__kydogWorld;
  const hitAt = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    for (;;) {
      const root = hit && hit.shadowRoot;
      const inner = root && typeof root.elementFromPoint === 'function' && root.elementFromPoint(x, y);
      if (!inner || inner === hit) return hit;
      hit = inner;
    }
  };
  const contains = (el, hit) => {
    for (let node = hit; node; node = node.parentNode || node.host) if (node === el) return true;
    return false;
  };
  const sources = (el) => {
    const states = [];
    const remember = (node) => {
      if (typeof node.getAttribute !== 'function') return;
      states.push({ node, state: JSON.stringify([
        node.disabled, node.readOnly, node.isContentEditable, world && world.pw && world.pw.has(node),
        ...['type', 'name', 'id', 'autocomplete', 'readonly', 'contenteditable', 'aria-disabled',
          'href', 'target', 'action', 'formaction', 'formtarget', 'formmethod', 'method', 'form',
          'enctype', 'accept-charset', 'novalidate'].map(a => node.getAttribute(a)),
        node.href, node.action, node.formAction, node.method, node.target, node.enctype, node.acceptCharset, node.noValidate,
      ]) });
    };
    for (let node = el; node; node = node.parentNode || node.host) remember(node);
    if (el.form && !states.some(value => value.node === el.form)) remember(el.form);
    return states;
  };
  const semantics = (el) => ({
    state: JSON.stringify([el.textContent, el.innerText,
      ...['role', 'aria-label', 'aria-labelledby', 'alt', 'placeholder', 'title', 'name'].map(a => el.getAttribute(a))]),
    labels: (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => {
      const node = document.getElementById(id);
      return { node, state: JSON.stringify(node && [node.textContent, node.innerText]) };
    }),
  });
  const hitSources = (hit) => {
    const states = sources(hit);
    for (let i = 0; i < states.length; i++) {
      const form = states[i].node.form;
      if (form) for (const value of sources(form))
        if (!states.some(previous => previous.node === value.node)) states.push(value);
    }
    return states;
  };
  const usable = (el) => {
    const style = getComputedStyle(el);
    return el.disabled !== true && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  if (req.op === 'capture') {
    const hit = hitAt(req.x, req.y);
    let el = null;
    if (typeof req.target.selector === 'string') el = document.querySelector(req.target.selector);
    else if (world && world.ids && typeof req.target.nodeId === 'number') {
      for (let node = hit; node; node = node.parentNode || node.host)
        if (world.ids.get(node) === req.target.nodeId) { el = node; break; }
    }
    if (!el || !el.isConnected) return reject('stale_node');
    if (!contains(el, hit)) return reject('intercepted');
    if (!usable(el)) return reject('pointer_target_changed');
    discard();
    const registry = globalThis[key] || (globalThis[key] = new Map());
    registry.set(req.token, { el, kind: req.kind, formOwner: el.form, generation: world && world.gen, url: location.href,
      point: { x: req.x, y: req.y }, hit, hitSources: hitSources(hit), sources: sources(el), semantics: semantics(el), expiresAt: req.expiresAt,
      timer: setTimeout(discard, Math.max(0, req.expiresAt - Date.now())) });
    return { ok: true };
  }
  const registry = globalThis[key], entry = registry && registry.get(req.token);
  if (!entry || !entry.el.isConnected) return reject('stale_node');
  if (Date.now() > entry.expiresAt) { discard(); return reject('expired'); }
  if (entry.generation !== (world && world.gen) || entry.url !== location.href) return reject('stale_node');
  const now = sources(entry.el), meaning = semantics(entry.el);
  if (!usable(entry.el) || entry.formOwner !== entry.el.form
    || now.length !== entry.sources.length || now.some((value, i) => value.node !== entry.sources[i].node || value.state !== entry.sources[i].state)
    || meaning.state !== entry.semantics.state || meaning.labels.length !== entry.semantics.labels.length
    || meaning.labels.some((value, i) => value.node !== entry.semantics.labels[i].node || value.state !== entry.semantics.labels[i].state))
    return reject('pointer_target_changed');
  const hit = hitAt(entry.point.x, entry.point.y);
  if (!contains(entry.el, hit)) return reject('intercepted');
  const intent = hitSources(hit);
  if (hit !== entry.hit || intent.length !== entry.hitSources.length
    || intent.some((value, i) => value.node !== entry.hitSources[i].node || value.state !== entry.hitSources[i].state))
    return reject('pointer_target_changed');
  if (req.op === 'validate_typing') {
    if (entry.kind !== 'type' || req.kind !== 'type') return reject('typing_destination_changed');
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    if (active !== entry.el || entry.el.readOnly === true) return reject('typing_destination_changed');
    if (typeof entry.el.value === 'string') {
      const len = entry.el.value.length;
      if (len !== 0) {
        // Null selection APIs are unknown. Never turn null or matching text
        // length elsewhere in the document into proof of this control's range.
        if (typeof entry.el.selectionStart !== 'number' || typeof entry.el.selectionEnd !== 'number')
          return reject('typing_selection_unproven');
        if (entry.el.selectionStart !== 0 || entry.el.selectionEnd !== len) return reject('typing_destination_changed');
      }
    } else if (entry.el.isContentEditable === true) {
      if (entry.el.childNodes.length !== 0) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return reject('typing_destination_changed');
        const range = selection.getRangeAt(0);
        if (range.startContainer !== entry.el || range.startOffset !== 0
          || range.endContainer !== entry.el || range.endOffset !== entry.el.childNodes.length)
          return reject('typing_destination_changed');
      }
    } else return reject('typing_destination_changed');
  }
  return { ok: true };
}
