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
          'enctype', 'accept-charset', 'novalidate', 'data-testid', 'role', 'aria-label'].map(a => node.getAttribute(a)),
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
  const retain = (el, semantic, members) => ({ el, formOwner: el.form, sources: sources(el),
    meaning: semantic ? semantics(el) : null, members,
    memberNodes: members ? Array.from(el.querySelectorAll(members)) : [] });
  const unchanged = saved => {
    if (!saved.el.isConnected || saved.formOwner !== saved.el.form) return false;
    const memberNodes = saved.members ? Array.from(saved.el.querySelectorAll(saved.members)) : [];
    if (memberNodes.length !== saved.memberNodes.length || memberNodes.some((node,i)=>node!==saved.memberNodes[i])) return false;
    const now = sources(saved.el);
    if (now.length !== saved.sources.length || now.some((v,i)=>v.node!==saved.sources[i].node || v.state!==saved.sources[i].state)) return false;
    if (saved.meaning) {
      const nowMeaning = semantics(saved.el);
      if (nowMeaning.state!==saved.meaning.state || nowMeaning.labels.length!==saved.meaning.labels.length
        || nowMeaning.labels.some((v,i)=>v.node!==saved.meaning.labels[i].node || v.state!==saved.meaning.labels[i].state)) return false;
    }
    return true;
  };
  // Fixed adapters retain the original permission while they collect. DOM refs
  // never cross worlds. A fresh collection invalidates the preceding namespace.
  if (req.op === 'begin_collected') {
    if (!world) return reject('stale_node');
    if (!world.collectedPermissions) world.collectedPermissions = new Map();
    world.collectedPermissions.set(req.owner, { namespace: req.namespace, entries: new Map() });
    return { ok: true };
  }
  if (req.op === 'remember_collected') {
    if (!world || !req.el?.isConnected || world.ids.get(req.el)!==req.nodeId) return reject('stale_node');
    const registry = world.collectedPermissions?.get(req.permission.owner);
    if (!registry || registry.namespace !== req.namespace) return reject('stale_node');
    registry.entries.set(req.permission.token,{nodeId:req.nodeId,purpose:req.permission.purpose,
      generation:world.gen,url:location.href,control:retain(req.el,true),scopes:req.scopes.map(s=>retain(s.el,s.semantic,s.members))});
    return {ok:true};
  }
  const collected = permission => permission && world?.collectedPermissions?.get(permission.owner)?.entries.get(permission.token);
  const permitted = (saved, permission, target) => !!saved && saved.purpose===permission.purpose
    && saved.nodeId===target.nodeId && saved.generation===world.gen && saved.url===location.href
    && unchanged(saved.control) && saved.scopes.every(unchanged);
  if (req.op === 'validate_collected') {
    const permission=req.target.collectedPermission;
    return permitted(collected(permission),permission,req.target) ? {ok:true} : reject('pointer_target_changed');
  }
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
    const permission=req.target.collectedPermission;
    const original=collected(permission);
    if (permission && !permitted(original,permission,req.target)) return reject('pointer_target_changed');
    discard();
    const registry = globalThis[key] || (globalThis[key] = new Map());
    registry.set(req.token, { collected:original, permission, originalTarget:req.target, el, kind: req.kind, formOwner: el.form, generation: world && world.gen, url: location.href,
      point: { x: req.x, y: req.y }, hit, hitSources: hitSources(hit), sources: sources(el), semantics: semantics(el), expiresAt: req.expiresAt,
      timer: setTimeout(discard, Math.max(0, req.expiresAt - Date.now())) });
    return { ok: true };
  }
  const registry = globalThis[key], entry = registry && registry.get(req.token);
  if (!entry || !entry.el.isConnected) return reject('stale_node');
  if (Date.now() > entry.expiresAt) { discard(); return reject('expired'); }
  if (entry.generation !== (world && world.gen) || entry.url !== location.href) return reject('stale_node');
  if (entry.permission && (collected(entry.permission)!==entry.collected || !permitted(entry.collected,entry.permission,entry.originalTarget))) return reject('pointer_target_changed');
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
