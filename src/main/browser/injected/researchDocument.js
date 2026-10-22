(function researchDocument(request) {
  // This entire function runs only in a lease-specific isolated main-frame world.
  const key = '__kydogResearchDocument';
  const previous = globalThis[key];
  if (request.op === 'dispose') {
    if (previous && previous.token === request.token) {
      previous.observer.disconnect();
      delete globalThis[key];
    }
    return { status: 'invalidated', reason: 'disposed', revision: previous?.revision ?? 0 };
  }
  if (request.op === 'observe') {
    if (previous) previous.observer.disconnect();
    const hostname = location.hostname;
    const isHost = name => hostname === name || hostname.endsWith('.' + name);
    const selectors = isHost('csdn.net') ? ['#content_views']
      : isHost('infoq.cn') || isHost('infoq.com') ? ['.article-detaile .article-preview'] : ['article', 'main'];
    const select = () => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return { element, rule: selector, editable: element.isContentEditable === true };
      }
      return { element: null, rule: '', editable: false };
    };
    const verification = () => Boolean(request.verificationSelector && document.querySelector(request.verificationSelector));
    const state = { verificationWidget: verification(), token: request.token, url: location.href, revision: 0, root: select(), observer: null, drain: null };
    const observe = () => {
      state.observer.disconnect();
      const root = state.root.element;
      // Barrier presence is a separate exact fact, not article readiness. Observe
      // only markup that can change the known selector match, and filter unrelated
      // changes below; root text readiness still uses the root observer.
      if (request.verificationSelector) state.observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['id', 'class', 'name', 'src', 'contenteditable'] });
      if (!root) {
        state.observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['id', 'class', 'contenteditable', ...(request.verificationSelector ? ['name', 'src'] : [])] });
      } else {
        state.observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
        // The ancestor chain detects replacement/removal and selector changes;
        // mutations in unrelated sidebars do not trigger article checks.
        for (let parent = root.parentNode; parent; parent = parent.parentNode) {
          if (parent === document && request.verificationSelector) continue;
          state.observer.observe(parent, { childList: true, attributes: true, attributeFilter: ['id', 'class', 'contenteditable'] });
        }
      }
    };
    const changed = records => {
      if (!records.length) return;
      const next = select(), old = state.root.element;
      const nextVerification = verification(), barrierChanged = nextVerification !== state.verificationWidget;
      const replaced = next.element !== old || next.rule !== state.root.rule || next.editable !== state.root.editable;
      if (!replaced && !barrierChanged && !records.some(record => old && (record.target === old || old.contains(record.target)))) return;
      state.root = next; state.verificationWidget = nextVerification;
      state.revision++;
      if (replaced) observe();
      if (request.bindingName && typeof globalThis[request.bindingName] === 'function') {
        globalThis[request.bindingName](JSON.stringify({ token: state.token, revision: state.revision, url: location.href }));
      }
    };
    state.observer = new MutationObserver(changed);
    state.drain = () => changed(state.observer.takeRecords());
    globalThis[key] = state;
    observe();
    return { status: 'observing', url: state.url, revision: state.revision };
  }
  const state = globalThis[key];
  if (!state || state.token !== request.token) return { status: 'invalidated', reason: 'disposed', revision: 0 };
  state.drain();
  const revision = state.revision, url = location.href;
  if (state.url !== url || request.url !== url) return { status: 'invalidated', reason: 'document_url_changed', revision };
  if (request.op !== 'capture') return { status: 'invalidated', reason: 'unsupported_operation', revision };
  const verificationWidget = Boolean(request.verificationSelector && document.querySelector(request.verificationSelector));
  const root = state.root.element;
  if (!root) return { status: 'pending', reason: 'article_root_missing', revision, url, verificationWidget };
  const excluded = 'script,style,link,meta,form,input,textarea,select,button,nav,aside,iframe,frame,object,embed,canvas,[role="navigation"],[role="complementary"]';
  // Inspect the live root: cloning detaches it from an editable ancestor. Native
  // editability also preserves explicit contenteditable=false readonly islands.
  if (root.matches(excluded) || request.verificationSelector && root.matches(request.verificationSelector) || root.isContentEditable === true) return { status: 'pending', reason: 'article_root_excluded', revision, url, verificationWidget };
  const clone = root.cloneNode(true);
  clone.querySelectorAll('*').forEach(node => {
    if (node.matches(excluded) || request.verificationSelector && node.matches(request.verificationSelector) || node.isContentEditable === true) node.remove();
  });
  // Never return active markup or form attributes copied onto arbitrary nodes.
  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || ['style', 'srcdoc', 'value', 'formaction'].includes(attribute.name)) element.removeAttribute(attribute.name);
    }
  }
  const container = document.implementation.createHTMLDocument('');
  container.title = document.title;
  container.body.appendChild(container.importNode(clone, true));
  const html = '<!DOCTYPE html>' + container.documentElement.outerHTML;
  const utf8Bytes = new TextEncoder().encode(html).length;
  if (utf8Bytes > request.maxBytes) return { status: 'oversize', revision, url, verificationWidget, utf8Bytes };
  return { status: 'snapshot', revision, url, verificationWidget, rootRule: state.root.rule, utf8Bytes, html };
})
