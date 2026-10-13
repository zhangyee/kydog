// Private fixed source program. References never leave the isolated world.
(input, source) => {
  const key = '__kydogXRootState';
  if (input.release) {
    if (window[key]?.lease === input.lease) delete window[key];
    return {released:window[key]?.lease !== input.lease};
  }
  if (!input.lease) return null;
  if (!source || !input.binding) { if(window[key]?.lease===input.lease) delete window[key];return null; }
  const {all,owner,shownReason,factOf,identity,url,allowed,roots,postRoots,conversation,primary,snapshot,tweetSelector,boundarySelector}=source;
  let state=window[key];
  if (input.reset || !state || state.lease!==input.lease || state.binding!==input.binding || state.generation!==snapshot.generation)
    state=window[key]={lease:input.lease,binding:input.binding,generation:snapshot.generation,pending:null,anchor:null};
  const commit=input.commit, pending=state.pending;
  if (commit && state.anchor?.collectionKey!==commit.collectionKey) {
    if (pending && pending.collectionKey===commit.collectionKey && pending.containerKey===commit.containerKey && pending.generation===commit.generation)
      state.anchor={...pending,anchorSnapshotId:commit.anchorSnapshotId};
    // A missing or mismatched original capture cannot be reconstructed.
    else state.anchor=null;
  }
  const members=root=>{
    const names=all(root,'[data-testid="User-Name"]').filter(el=>owner(el)===root);
    const profiles=names.flatMap(n=>all(n,'a[href]')).filter(a=>owner(a)===root);
    const stamps=all(root,'a[href]').filter(a=>owner(a)===root && a.querySelector('time'));
    return {names,profiles,stamps};
  };
  const coords=m=>({profiles:m.profiles.map(a=>{const u=url(a.getAttribute('href'));return allowed(u)&&/^\/[A-Za-z0-9_]+$/.test(u.pathname)&&u.href.length<=8192?u.href:null;}),stamps:m.stamps.map(a=>{const i=identity(a.getAttribute('href'));return i&&i.permalink.length<=8192?i.permalink:null;})});
  const overflow=m=>Object.values(m).some(a=>a.length>32);
  const inspect=anchor=>{
    const root=anchor.root, current=members(root), old=anchor.members;
    const tooMany=overflow(current)||anchor.overflow;
    const missing=!current.names.length||!current.profiles.length||!current.stamps.length;
    const sameMembers=Object.keys(current).every(k=>current[k].length===old[k].length && current[k].every((el,i)=>el===old[k][i]));
    const currentCoordinates=coords(current), originalCoordinates=coords(old);
    const unchanged=JSON.stringify(currentCoordinates)===JSON.stringify(anchor.coordinates) && JSON.stringify(originalCoordinates)===JSON.stringify(anchor.coordinates);
    const conflicting=current.names.length!==1 || new Set(currentCoordinates.profiles).size!==1 || new Set(currentCoordinates.stamps).size!==1 || Object.values(currentCoordinates).some(a=>a.includes(null));
    const fact=factOf(root), sameFact=fact.postId===anchor.postId && fact.author?.handle===anchor.handle && fact.permalink===anchor.permalink;
    const conversations=all(primary,'[aria-label="Timeline: Conversation"]');
    return {anchorSnapshotId:anchor.anchorSnapshotId,availability:'captured',
      conversation:{candidates:conversations.length===0?'none':conversations.length===1?'unique':'multiple',sameObject:conversations.length===1?conversations[0]===anchor.conversation:null,
        connected:anchor.conversation.isConnected,sameDocument:anchor.conversation.ownerDocument===document,containsRoot:anchor.conversation.contains(root)},
      root:{connection:root.isConnected?'connected':'detached',sameDocument:root.ownerDocument===document,
        topLevel:root.matches(tweetSelector) && !root.parentElement?.closest(tweetSelector),ownBoundary:root.matches(tweetSelector) && !root.parentElement?.closest(boundarySelector),
        inRoots:roots.includes(root),inRawPosts:postRoots.includes(root),shown:shownReason(root)},
      identity:{members:tooMany?'ambiguous':missing?'missing':sameMembers?'same':'changed',coordinates:tooMany?'ambiguous':missing?'missing':conflicting?'ambiguous':unchanged?'same':'changed',
        owned:Object.values(old).flat().every(el=>owner(el)===root),rendered:tooMany?'ambiguous':!root.isConnected || root.ownerDocument!==document || !fact.postId?'missing':conflicting?'ambiguous':sameFact?'same':'changed',
        nameCount:Math.min(current.names.length,33),profileLinkCount:Math.min(current.profiles.length,33),timestampCount:Math.min(current.stamps.length,33)}};
  };
  // Inspect the admitted original before replacing this collection's pending slot.
  const anchorState=state.anchor?inspect(state.anchor):null;
  state.pending=null;
  const candidate=source.candidate;
  if (!state.anchor && candidate) {
    const m=members(candidate.root), limited=Object.fromEntries(Object.entries(m).map(([k,v])=>[k,v.slice(0,32)]));
    state.pending={collectionKey:input.collectionKey,binding:input.binding,generation:snapshot.generation,containerKey:candidate.containerKey,
      root:candidate.root,conversation,document,postId:candidate.postId,handle:candidate.handle,permalink:candidate.permalink,members:limited,overflow:overflow(m),coordinates:coords(limited),anchorSnapshotId:'pending'};
  }
  return {lease:input.lease,collectionKey:input.collectionKey,containerKey:state.pending?.containerKey??null,
    candidateState:state.pending?inspect(state.pending):null,anchorState};
}
