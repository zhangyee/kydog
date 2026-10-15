/* global X_REQUEST, X_WALKER, X_PERMISSION, X_ROOT */
// Fixed rendered-X observation. Selectors observed in IAB on 2026-10-12.
// Invoked only in the existing isolated world. Page text is never executable.
(() => {
  const request = X_REQUEST;
  const collectReplies = request.stage!=='post' || request.collectReplies!==false;
  const all = (root, selector) => root ? Array.from(root.querySelectorAll(selector)) : [];
  const text = el => el ? (el.innerText || el.textContent || '').trim() : '';
  const shownReason = el => {
    if (!el || el.getBoundingClientRect().width <= 0 || el.getBoundingClientRect().height <= 0) return 'dimensions';
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (p.hidden) return 'hidden';
      if (p.getAttribute('aria-hidden') === 'true') return 'aria_hidden';
      if (s.display === 'none') return 'display_none';
      if (s.visibility === 'hidden') return 'visibility_hidden';
      if (s.visibility === 'collapse') return 'collapse';
    }
    return 'pass';
  };
  const shown = el => shownReason(el)==='pass';
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
    const candidatePostId=unique.length===1?unique[0]:null;
    const identityIssue=!author || !candidatePostId?'unnamed':fact?null:'author_mismatch';
    return {author,postId:fact?.postId ?? null,permalink:fact?.permalink ?? null,candidatePostId,identityIssue};
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
  const posts = [], controls = [], entries = [], postRoots = [];
  const candidates = new Set();
  let eligibleControls = 0;
  const control = (el,kind,postId,scopes,sourceRelation='unknown') => {
    if (!shown(el) || el.form || el.closest('form') || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    eligibleControls++;
    if (controls.length >= 100) return null;
    candidates.add(el); const c = {el,kind,postId,scopes,sourceRelation}; controls.push(c); return c;
  };
  const roots = all(region,tweetSelector).filter(el=>shown(el) && !el.parentElement.closest(tweetSelector));
  const scopeOf = root => root ? [{el:root,semantic:false,members:'[data-testid="User-Name"] a[href], a[href] time'},...own(root,'[data-testid="User-Name"] a[href], a[href]').filter(el=>el.closest('[data-testid="User-Name"]') || el.querySelector('time')).map(el=>({el,semantic:true}))] : [];
  const focal = roots.find(root=>factOf(root).postId===request.postId);
  const documentPost = identity(location.href);
  const matchingRoots = request.stage === 'post' && documentPost?.postId === request.postId
    ? roots.filter(root=>{
      const fact=factOf(root);
      return fact.postId===request.postId && fact.author?.handle===documentPost.handle
        && url(fact.permalink)?.origin===current.origin;
    }) : [];
  const longBodyRoot = matchingRoots.length===1 ? matchingRoots[0] : null;
  let totalPosts = 0, containerKey = 0, targetBodyCandidates = 0;
  for (const root of roots) {
    const rootFact = factOf(root);
    // Keep exact target candidates (including identity rejections) and their own
    // quotes/Article entries; never read unrelated top-level bodies when disabled.
    if (!collectReplies && rootFact.candidatePostId!==request.postId) continue;
    const parentContainerKey = containerKey;
    let articleEntryCount=0;
    const boxes = [root,...all(root,'div[role="link"][tabindex="0"]').filter(b=>shown(b) && own(b,'[data-testid="User-Name"]').length)];
    for (const box of boxes) {
      const sourceContainerKey = containerKey++;
      const texts = own(box,'[data-testid="tweetText"]');
      const fact = factOf(box);
      if (texts.length) {
        totalPosts++;
        if (request.stage==='post' && fact.postId===request.postId) targetBodyCandidates++;
        if (posts.length < 100) {
          const full = texts.map(text).join('\n');
          const limit=box===longBodyRoot?64000:4000;
          postRoots.push(box);
          posts.push({...fact,containerKey:sourceContainerKey,articleEntryCount:0,scope:box===root?'post':'quote',text:full.slice(0,limit),truncation:{returned:Math.min(full.length,limit),totalKnown:full.length,truncated:full.length>limit}});
        }
      }
      for (const b of own(box,'button[role="button"][type="button"][data-testid="tweet-text-show-more-link"]')) control(b,'body_expand',fact.postId,[...scopeOf(root),...scopeOf(box)]);
      const cover = own(box,'[data-testid="article-cover-image"]');
      if (box!==root && cover.length && rootFact.postId) {
        articleEntryCount++;
        const c = control(box,'article_entry',rootFact.postId,[...scopeOf(root),...scopeOf(box)]);
        if (c) entries.push({el:box,parentContainerKey,author:authorOf(box),parentPostId:rootFact.postId,parentUrl:rootFact.permalink,targetUrl:box.getAttribute('href') ? url(box.getAttribute('href'))?.href ?? box.getAttribute('href') : null,label:text(box).slice(0,512)});
      }
    }
    const parent=posts.find(p=>p.containerKey===parentContainerKey);
    if(parent) parent.articleEntryCount=articleEntryCount;
  }
  if (totalPosts>100 || targetBodyCandidates!==1) for (const p of posts) if (p.text.length>4000) {
    p.text=p.text.slice(0,4000);
    p.truncation={returned:4000,totalKnown:p.truncation.totalKnown,truncated:true};
  }
  for (const b of (collectReplies ? all(conversation,'[data-testid="cellInnerDiv"] button[role="button"][type="button"]') : []).filter(b=>!b.closest(tweetSelector) && text(b)==='Show replies')) {
    const focalCell=focal?.closest('[data-testid="cellInnerDiv"]') ?? null;
    const buttonCell=b.closest('[data-testid="cellInnerDiv"]');
    const sourceRelation=focal?.contains(b)?'focal_contains_control':b.contains(focal)?'control_contains_focal'
      :focalCell && buttonCell ? focalCell===buttonCell?'same_cell':'different_cell' : 'unknown';
    control(b,'replies_expand',null,scopeOf(focal),sourceRelation);
  }
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
      // Captured readView group links identify the native Article, independently
      // of arbitrary links in rich text. Preserve conflicts before ID decoding.
      const identityLinks = all(read,'div[role="group"] a[role="link"][href]').filter(a=>shown(a)
        && a.closest('article[data-testid="twitterArticleReadView"]')===read
        && owner(a)===outer && !a.closest('[data-testid="twitterArticleRichTextView"]'));
      const ownIdentityLinks = {totalKnown:identityLinks.length,hrefs:identityLinks.slice(0,2).map(a=>{
        const href=a.getAttribute('href');return href.length<=8192?href:null;
      })};
      article = {ownIdentityLinks,author:authorOf(outer),title:text(read.querySelector('[data-testid="twitter-article-title"]')).slice(0,1000),blocks:values,
        links:all(read,'a[href]').filter(shown).slice(0,100).map(a=>({url:url(a.getAttribute('href'))?.href ?? '',text:text(a).slice(0,512)})),
        truncated:blocks.length>256 || blocks.reduce((n,b)=>n+text(b).length,0)>64000};
    }
  }
  // Lexical scope is private to this fixed expression; no page globals or public cache.
  // The walker inserted at X_WALKER consumes this lexical candidate set.
  // eslint-disable-next-line no-unused-vars
  const kydogSnapshotScope = candidates;
  const snapshot = X_WALKER;
  const diagnosticId = el => {
    const world=window.__kydogWorld;
    if (!el || !world?.ids) return null;
    let id=world.ids.get(el);
    if (!id) {id=world.next++;world.ids.set(el,id);}
    return id;
  };
  const diagnosticNodes={regionNodeId:diagnosticId(conversation),rootNodeId:diagnosticId(longBodyRoot)};
  // Optional diagnostics from this exact collection. Only light DOM is traversed;
  // shadow/iframe content and arbitrary literal-label confidentiality are not proven.
  const captureReplyUi = () => {
    const base={version:1,source:'xPage_existing_collection',unsupported:['plain_text','external_aria_names','unloaded_ui','iframe','shadow_dom','unsupported_roles']};
    if (!conversation) return {...base,capture:{state:'region_missing'}};
    try {
      const c={state:'checked',domain:'conversation_light_dom_semantic_nodes',regionNodeId:diagnosticNodes.regionNodeId,
        traversal:{visited:0,truncated:false,limit:null,limitValue:5000,eligibleTotalKnown:null},
        candidateCapacity:{limitValue:32,policy:'first_eligible_nodes',truncated:false},
        candidateObserved:0,eligibleObserved:0,returned:0,omittedHidden:0,omittedByCandidateLimit:0,
        omittedByPrivacy:0,omittedUnsupportedSubtree:0,
        omittedUnsafeSubtree:{excludedDescendant:0,subtreeNotFullyInspected:0,metadataLimit:0},nodes:[]};
      const walker=document.createTreeWalker(conversation,0xffffffff),stack=[],active=[];
      const privacy=el=>el.matches(boundarySelector+',form,input,textarea,select') || !!el.form
        || (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable')!=='false');
      const finish=(frame,complete)=>{
        const n=frame.candidate;if(!n)return;
        active.pop();
        if(n.metadataLimit)c.omittedUnsafeSubtree.metadataLimit++;
        else if(n.excluded)c.omittedUnsafeSubtree.excludedDescendant++;
        else if(!complete)c.omittedUnsafeSubtree.subtreeNotFullyInspected++;
        else {
          const full=text(n.el);
          c.nodes.push({sourceOrdinal:frame.ordinal,parentSourceOrdinal:frame.parentOrdinal,tag:n.tag,declaredRole:n.role,kind:n.kind,
            regionRelation:'inside',postRelation:'outside_post_boundaries',visibility:'shownReason_pass',textSource:'xPage_innerText_or_textContent_trimmed',
            text:full.slice(0,512),textTruncation:{returned:Math.min(512,full.length),totalKnown:full.length,truncated:full.length>512}});
        }
      };
      let cursor=conversation;
      while(cursor){
        if(c.traversal.visited===5000){c.traversal.truncated=true;c.traversal.limit='visited_nodes';break;}
        const frame={ordinal:++c.traversal.visited,parentOrdinal:stack.length?stack[stack.length-1].ordinal:null,candidate:null};
        stack.push(frame);
        let prune=false;
        if(cursor.nodeType===1){
          const el=cursor,tag=el.localName,role=el.getAttribute('role');
          // The conversation itself may be nested in a boundary outside the walk.
          const privateRoot=privacy(el) || (el===conversation && !!el.parentElement?.closest(boundarySelector+',form,input,textarea,select,[contenteditable]:not([contenteditable="false"])'));
          const unsupported=['iframe','script','style','template'].includes(tag) || !!el.shadowRoot;
          if(privateRoot || unsupported){
            if(privateRoot)c.omittedByPrivacy++;else c.omittedUnsupportedSubtree++;
            for(const n of active)n.excluded=true;
            prune=true;
          } else {
            const kind=/^h[1-6]$/.test(tag)?'heading':tag==='button'?'button':['heading','status','alert','button'].includes(role)?role:null;
            if(kind){
              c.candidateObserved++;
              if(!shown(el))c.omittedHidden++;
              else {
                c.eligibleObserved++;
                if(c.eligibleObserved>32){c.omittedByCandidateLimit++;c.candidateCapacity.truncated=true;}
                else {frame.candidate={el,tag,role,kind,excluded:false,metadataLimit:tag.length>32 || (role!==null && role.length>128)};active.push(frame.candidate);}
              }
            }
          }
        }
        const child=prune?null:walker.firstChild();
        if(child){cursor=child;continue;}
        cursor=null;
        while(stack.length){
          finish(stack.pop(),true);
          if(!stack.length)break;
          const sibling=walker.nextSibling();
          if(sibling){cursor=sibling;break;}
          walker.parentNode();
        }
      }
      while(stack.length)finish(stack.pop(),false);
      c.nodes.sort((a,b)=>a.sourceOrdinal-b.sourceOrdinal);c.returned=c.nodes.length;
      if(!c.traversal.truncated)c.traversal.eligibleTotalKnown=c.eligibleObserved;
      return {...base,capture:c};
    } catch {return {...base,capture:{state:'unavailable',reason:'source_capture_failed'}};}
  };
  const replyUiInventory=request.stage==='post'?captureReplyUi():undefined;
  const permissionGuard = X_PERMISSION;
  permissionGuard({op:'begin_collected',owner:'x',namespace:request.permissionNamespace});
  const nodeFor = el => snapshot.nodes.find(n=>window.__kydogWorld.ids.get(el)===n.nodeId);
  for (const c of controls) {
    const node=nodeFor(c.el);
    if (!node) continue;
    const permission={owner:'x',token:request.permissionNamespace+':'+node.nodeId,purpose:c.kind};
    const saved=permissionGuard({op:'remember_collected',namespace:request.permissionNamespace,permission,el:c.el,nodeId:node.nodeId,scopes:c.scopes});
    if (saved.ok) node.collectedPermission=permission;
  }
  const rootDiagnostics = X_ROOT;
  const sourceCandidates=posts.filter(p=>p.scope==='post' && p.postId===request.postId);
  const candidate=sourceCandidates.length===1 && totalPosts===posts.length && totalPosts<=100
    ? {...sourceCandidates[0],root:postRoots[posts.indexOf(sourceCandidates[0])],handle:sourceCandidates[0].author?.handle} : null;
  let sourceRoot=null;
  try {sourceRoot=rootDiagnostics(request.sourceRoot??{},request.stage==='post'?{all,owner,shownReason,factOf,identity,url,allowed,roots,postRoots,conversation,primary,snapshot,tweetSelector,boundarySelector,candidate}:null);} catch { /* Missing source facts never change the ordinary observation. */ }
  return {...(replyUiInventory?{replyUiInventory}:{}),sourceRoot,rawUrl:location.href,region:!!region,diagnosticNodes,selectedProduct:selected.length===1?selected[0]:null,state,posts,article,
    controls:controls.flatMap(({el,kind,postId,sourceRelation})=>{const n=nodeFor(el);return n?[{kind,postId,nodeId:n.nodeId,index:n.index,sourceRelation}]:[];}),
    entries:entries.flatMap(({el,...e})=>{const n=nodeFor(el);return n?[{...e,nodeId:n.nodeId,index:n.index}]:[];}),
    controlTruncation:{returned:snapshot.nodes.length,totalKnown:eligibleControls,truncated:snapshot.nodes.length<eligibleControls},
    truncation:{returned:posts.length,totalKnown:totalPosts,truncated:totalPosts>100},snapshot};
})()
