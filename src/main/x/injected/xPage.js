/* global X_REQUEST, X_WALKER */
// Fixed rendered-X observation. Selectors observed in IAB on 2026-10-12.
// Invoked only in the existing isolated world. Page text is never executable.
(() => {
  const request = X_REQUEST;
  const all = (root, selector) => root ? Array.from(root.querySelectorAll(selector)) : [];
  const text = el => el ? (el.innerText || el.textContent || '').trim() : '';
  const shown = el => {
    if (!el || el.getBoundingClientRect().width <= 0 || el.getBoundingClientRect().height <= 0) return false;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (p.hidden || p.getAttribute('aria-hidden') === 'true' || s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    }
    return true;
  };
  const url = raw => { try { return new URL(raw, location.href); } catch { return null; } };
  const allowed = u => u && u.protocol === 'https:' && !u.username && !u.password && !u.port && ['x.com','twitter.com'].includes(u.hostname);
  const identity = raw => {
    const u = url(raw);
    if (!allowed(u)) return null;
    const match = /^\/([A-Za-z0-9_]+)\/status\/([0-9]+)(?:\/history)?\/?$/.exec(u.pathname);
    return match ? { handle:match[1], postId:match[2], permalink:u.href } : null;
  };
  const tweetSelector = 'article[data-testid="tweet"]';
  const boundarySelector = tweetSelector + ',div[role="link"][tabindex="0"]';
  // The href-less role=link ancestor is the observed quote/Article preview boundary.
  const owner = el => el.closest(boundarySelector);
  const own = (root, selector) => all(root,selector).filter(el => owner(el) === root && shown(el));
  const authorOf = root => {
    const names = own(root,'[data-testid="User-Name"]');
    if (names.length !== 1) return null;
    const links = all(names[0],'a[href]').filter(shown).map(a => ({a,u:url(a.getAttribute('href'))})).filter(v => allowed(v.u) && /^\/[A-Za-z0-9_]+$/.test(v.u.pathname));
    const handles = [...new Set(links.map(v=>v.u.pathname.slice(1)))];
    if (handles.length !== 1) return null;
    return {handle:handles[0],displayName:text(links[0].a).slice(0,256) || null,profileUrl:links[0].u.origin+links[0].u.pathname};
  };
  const factOf = root => {
    const author = authorOf(root);
    const stamps = own(root,'a[href]').filter(a => a.querySelector('time'));
    const ids = stamps.map(a=>identity(a.getAttribute('href'))).filter(Boolean);
    const unique = [...new Set(ids.map(i=>i.postId))];
    const fact = unique.length === 1 && ids.every(i=>i.handle === author?.handle) ? ids[0] : null;
    return {author,postId:fact?.postId ?? null,permalink:fact?.permalink ?? null};
  };
  const primary = document.querySelector('main [data-testid="primaryColumn"], [role="main"] [data-testid="primaryColumn"]');
  const conversation = primary?.querySelector('[aria-label="Timeline: Conversation"]') ?? null;
  const region = request.stage === 'search' ? primary : conversation;
  const selected = all(primary,'[role="tab"][aria-selected="true"]').filter(shown).map(text);
  let state = null;
  const current = url(location.href);
  if (allowed(current) && current.pathname === '/i/jf/onboarding/web') {
    for (const dialog of all(document,'[role="dialog"]').filter(shown)) {
      if (dialog.querySelector('input[name="username_or_email"][type="text"][autocomplete="username webauthn"]') && dialog.querySelector('input[name="password"][type="password"]'))
        state = {kind:'auth_required',text:'Observed onboarding dialog with username and password fields'};
    }
  }
  const empty = primary?.querySelector('[data-testid="emptyState"]');
  if (!state && request.stage === 'search' && shown(empty)) {
    const header = empty.querySelector('[data-testid="empty_state_header_text"]');
    const body = empty.querySelector('[data-testid="empty_state_body_text"]');
    if (shown(header) && shown(body) && text(header).startsWith('No results for ')) state = {kind:'explicit_empty',text:(text(header)+'\n'+text(body)).slice(0,4000)};
  }
  const posts = [], controls = [], entries = [];
  const candidates = new Set();
  let eligibleControls = 0;
  const control = (el,kind,postId) => {
    if (!shown(el) || el.form || el.closest('form') || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    eligibleControls++;
    if (controls.length >= 100) return null;
    candidates.add(el); const c = {el,kind,postId}; controls.push(c); return c;
  };
  const roots = all(region,tweetSelector).filter(el=>shown(el) && !el.parentElement.closest(tweetSelector));
  let totalPosts = 0;
  for (const root of roots) {
    const rootFact = factOf(root);
    const boxes = [root,...all(root,'div[role="link"][tabindex="0"]').filter(b=>shown(b) && own(b,'[data-testid="User-Name"]').length)];
    for (const box of boxes) {
      const texts = own(box,'[data-testid="tweetText"]');
      const fact = factOf(box);
      if (texts.length) {
        totalPosts++;
        if (posts.length < 100) {
          const full = texts.map(text).join('\n');
          posts.push({...fact,scope:box===root?'post':'quote',text:full.slice(0,4000),truncation:{returned:Math.min(full.length,4000),totalKnown:full.length,truncated:full.length>4000}});
        }
      }
      for (const b of own(box,'button[role="button"][type="button"][data-testid="tweet-text-show-more-link"]')) control(b,'body_expand',fact.postId);
      const cover = own(box,'[data-testid="article-cover-image"]');
      if (box!==root && cover.length && rootFact.postId) {
        const c = control(box,'article_entry',rootFact.postId);
        if (c) entries.push({el:box,parentPostId:rootFact.postId,parentUrl:rootFact.permalink,targetUrl:box.getAttribute('href') ? url(box.getAttribute('href'))?.href ?? null : null,label:text(box).slice(0,512)});
      }
    }
  }
  for (const b of all(conversation,'[data-testid="cellInnerDiv"] button[role="button"][type="button"]').filter(b=>!b.closest(tweetSelector) && text(b)==='Show replies')) control(b,'replies_expand',null);
  // Article body is independent of primaryColumn (immersive UI has none).
  let article = null;
  const reads = all(document,'main article[data-testid="twitterArticleReadView"], [role="main"] article[data-testid="twitterArticleReadView"]').filter(shown);
  if (reads.length === 1) {
    const read = reads[0], outer = read.parentElement.closest(tweetSelector);
    const rich = read.querySelector('[data-testid="twitterArticleRichTextView"] [data-testid="longformRichTextComponent"][contenteditable="false"]');
    if (outer && shown(rich)) {
      const blocks = all(rich,'[data-block="true"]').filter(shown);
      let remaining = 64000;
      const values = [];
      for (const block of blocks.slice(0,256)) { const s=text(block); values.push(s.slice(0,remaining)); remaining-=Math.min(remaining,s.length); }
      article = {author:authorOf(outer),title:text(read.querySelector('[data-testid="twitter-article-title"]')).slice(0,1000),blocks:values,
        links:all(read,'a[href]').filter(shown).slice(0,100).map(a=>({url:url(a.getAttribute('href'))?.href ?? '',text:text(a).slice(0,512)})),
        truncated:blocks.length>256 || blocks.reduce((n,b)=>n+text(b).length,0)>64000};
    }
  }
  // Lexical scope is private to this fixed expression; no page globals or public cache.
  // The walker inserted at X_WALKER consumes this lexical candidate set.
  // eslint-disable-next-line no-unused-vars
  const kydogSnapshotScope = candidates;
  const snapshot = X_WALKER;
  const nodeFor = el => snapshot.nodes.find(n=>window.__kydogWorld.ids.get(el)===n.nodeId);
  return {rawUrl:location.href,region:!!region,selectedProduct:selected.length===1?selected[0]:null,state,posts,article,
    controls:controls.flatMap(({el,...c})=>{const n=nodeFor(el);return n?[{...c,nodeId:n.nodeId,index:n.index}]:[];}),
    entries:entries.flatMap(({el,...e})=>{const n=nodeFor(el);return n?[{...e,nodeId:n.nodeId,index:n.index}]:[];}),
    controlTruncation:{returned:snapshot.nodes.length,totalKnown:eligibleControls,truncated:snapshot.nodes.length<eligibleControls},
    truncation:{returned:posts.length,totalKnown:totalPosts,truncated:totalPosts>100},snapshot};
})()
