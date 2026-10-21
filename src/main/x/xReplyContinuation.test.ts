import {fixture,post,readHtml} from '../../test-support/xResearchFixture';
import {readX} from './xResearchRead';
import {serializeXResearchResult} from './xResearchOutput';
import {expect,it} from 'vitest';
import {replyContinuationFixture} from '../../test-support/xReplyContinuationFixture';

it('fresh actual source permits three attempts on the identical physical reply button and stops at the shared budget',async()=>{
 const f=replyContinuationFixture();try{
  const row=(await f.run()).targets[0];
  expect(f.count()).toEqual({writes:3,dispatches:3,collections:4});
  expect(f.records.map(r=>r.nodeId)).toEqual([f.records[0].nodeId,f.records[0].nodeId,f.records[0].nodeId]);
  expect(new Set(f.records.map(r=>r.generation)).size).toBe(1);
  expect(f.document.querySelector('#replies')).toBe(f.button);expect(f.root.parentElement).toBe(f.conversation);
  expect(row.replies.observations.map(p=>[p.postId,p.sourceUrl])).toEqual([['701','https://x.com/reply1/status/701'],['702','https://x.com/reply2/status/702'],['703','https://x.com/reply3/status/703']]);
  expect(row).toMatchObject({budgetUsage:{expandActions:3},stopReason:'budget_reached',replies:{scope:{kind:'network',extent:'unknown'}}});
 }finally{f.close();}
});
it('same private reply permission cannot dispatch twice, including when the first attempt failed',async()=>{
 const f=replyContinuationFixture();try{await f.port.withPage('tab',undefined,async page=>{
  const first=await page.collect(f.request),control=first.controls[0];
  const action={kind:'click' as const,index:control.binding.index,snapshotId:control.binding.snapshotId};
  await page.act(action,first.snapshot);expect(f.count().writes).toBe(1);
  await expect(page.act(action,first.snapshot)).rejects.toMatchObject({code:'browser.bad_action'});expect(f.count().dispatches).toBe(1);
  const next=await page.collect(f.request),binding=next.controls[0].binding,click={kind:'click' as const,index:binding.index,snapshotId:binding.snapshotId};
  f.button.textContent='Reply';await expect(page.act(click,next.snapshot)).rejects.toMatchObject({code:'browser.target_unusable'});
  f.button.textContent='Show replies';await expect(page.act(click,next.snapshot)).rejects.toMatchObject({code:'browser.bad_action'});
  expect(f.count()).toMatchObject({writes:1,dispatches:2});
 });}finally{f.close();}
});
it('retains exact first/last source inventories, private admission, global indices and shared caps without claiming progress',async()=>{
 const positive=replyContinuationFixture({body:true});try{
  const row=(await positive.run({maxExpandActionsPerPost:4})).targets[0];
  const d=row.diagnostics!.replyExpansions!;
  expect(d).toMatchObject({totalAttempts:4,omittedAttempts:2,first:{actionIndex:1,outcome:'succeeded',caps:{replies:20,scrolls:0,expansions:4},usageBefore:{expansions:0},usageAfter:{expansions:1},admission:{state:'consumed',purpose:'replies_expand'},before:{state:'captured',inventory:{state:'captured',items:[],total:0,returned:0,omitted:0}},after:{state:'captured',inventory:{state:'captured',items:[{postId:'701',sourceUrl:'https://x.com/reply1/status/701'}]}}},last:{actionIndex:4,usageBefore:{expansions:3},usageAfter:{expansions:4}}});
  expect(d.last!.after).toMatchObject({state:'captured',inventory:{total:4,returned:4,omitted:0}});
  expect(d.first!.admission).toMatchObject({binding:d.first!.binding});
  expect(d.last!.binding.nodeId).toBe(d.first!.binding.nodeId);
  for(const [cap,writes] of [[0,0],[1,1],[3,3]]){
   const f=replyContinuationFixture({zero:true});try{
    const empty=(await f.run({maxExpandActionsPerPost:cap})).targets[0];
    expect(f.count().writes).toBe(writes);expect(empty.replies.observations).toEqual([]);
    expect(empty).toMatchObject({budgetUsage:{expandActions:writes},stopReason:'budget_reached',replies:{scope:{kind:'network',extent:'unknown'}}});
    if(writes)expect(empty.diagnostics!.replyExpansions!.last!.after).toMatchObject({state:'captured',inventory:{state:'captured',items:[]}});
    else expect(empty.diagnostics!.replyExpansions).toBeUndefined();
   }finally{f.close();}
  }
 }finally{positive.close();}
});
it('fresh namespace invalidates old snapshots and caller mutation never replaces private reply permission or original binding',async()=>{
 const f=replyContinuationFixture();try{await f.port.withPage('tab',undefined,async page=>{
  const positive=await page.collect(f.request),b=positive.controls[0].binding;
  await page.act({kind:'click',index:b.index,snapshotId:b.snapshotId},positive.snapshot);expect(f.count().writes).toBe(1);
  const old=await page.collect(f.request),oldBinding={...old.controls[0].binding};
  const fresh=await page.collect(f.request),binding={...fresh.controls[0].binding};
  await expect(page.act({kind:'click',index:oldBinding.index,snapshotId:oldBinding.snapshotId},old.snapshot)).rejects.toMatchObject({code:'browser.target_unusable'});
  const node=fresh.snapshot.nodes.find(n=>n.index===binding.index)!;
  node.collectedPermission!.token='invented';node.collectedPermission!.purpose='article_entry';fresh.controls[0].binding.nodeId=987;
  let receipt:unknown,reentrant:Promise<unknown>|undefined;
  await page.act({kind:'click',index:binding.index,snapshotId:binding.snapshotId},fresh.snapshot,{onReplyAdmission:r=>{receipt=structuredClone(r);r.binding.nodeId=654;reentrant=page.act({kind:'click',index:binding.index,snapshotId:binding.snapshotId},fresh.snapshot).catch(error=>error);throw Error('observer failure');}});
  expect(await reentrant).toMatchObject({code:'browser.bad_action'});
  expect(receipt).toEqual({state:'consumed',purpose:'replies_expand',binding});expect(f.count().writes).toBe(2);
  await expect(page.act({kind:'click',index:binding.index,snapshotId:binding.snapshotId},fresh.snapshot)).rejects.toMatchObject({code:'browser.bad_action'});expect(f.count().dispatches).toBe(3);
 });}finally{f.close();}
});
it('root, route, permission, collection and cancellation losses stop with explicit unavailable/not-observed captures',async()=>{
 const good=replyContinuationFixture();try{expect((await good.run()).targets[0].diagnostics!.replyExpansions!.last!.after.state).toBe('captured');expect(good.count().writes).toBe(3);}finally{good.close();}
 for(const mode of ['root','route','search_route','permission','collect','cancel','failure'] as const){
  const f=replyContinuationFixture();try{
   if(mode==='permission')f.hooks.beforeDispatch=()=>{if(f.count().dispatches===2)f.button.textContent='Reply';};
   if(mode==='failure')f.hooks.beforeDispatch=()=>{if(f.count().dispatches===2)throw Error('native failed');};
   if(mode==='collect')f.hooks.beforeCollect=()=>{if(f.count().collections===2)throw Error('collection failed');};
   f.hooks.afterWrite=()=>{
    if(mode==='root')f.root.remove();
    if(mode==='search_route'){f.facts.currentUrl='https://x.com/search?q=public&f=live';f.facts.routeRevision++;f.dom.reconfigure({url:f.facts.currentUrl});}
    if(mode==='route'){f.facts.currentUrl='https://x.com/alice/status/999';f.facts.routeRevision++;f.dom.reconfigure({url:f.facts.currentUrl});}
    if(mode==='cancel')f.abort.abort();
   };
   const result=await f.run(),row=result.targets[0],last=row.diagnostics!.replyExpansions!.last!;
   expect(f.count().writes,mode).toBe(1);expect(row.replies.scope.extent).toBe('unknown');
   if(mode==='root')expect(last.after).toMatchObject({state:'captured',sourceAvailable:false,inventory:{state:'unavailable'}});
   else expect(last.after.state).toBe(['collect','route','search_route'].includes(mode)?'unavailable':'not_observed');
   if(mode==='permission'||mode==='failure')expect(last).toMatchObject({outcome:'failed',usageBefore:{expansions:1},usageAfter:{expansions:1},admission:{state:'consumed'}});
   expect(()=>serializeXResearchResult({...result})).not.toThrow();
   if(mode==='cancel')expect(last).toMatchObject({outcome:'cancelled',admission:{state:'consumed'}});
  }finally{f.close();}
 }
});
it('cancellation after consumption never restores the permission and prevents further native dispatch',async()=>{
 const f=replyContinuationFixture();try{
  await f.port.withPage('tab',undefined,async page=>{const frame=await page.collect(f.request),b=frame.controls[0].binding;await page.act({kind:'click',index:b.index,snapshotId:b.snapshotId},frame.snapshot);});
  expect(f.count().writes).toBe(1);
  let replay:Promise<unknown>|undefined;
  await expect(f.port.withPage('tab',f.abort.signal,async page=>{
   const frame=await page.collect(f.request),b=frame.controls[0].binding,click={kind:'click' as const,index:b.index,snapshotId:b.snapshotId};
   f.hooks.afterWrite=()=>f.abort.abort();
   try{await page.act(click,frame.snapshot);}catch{replay=page.act(click,frame.snapshot);await expect(replay).rejects.toMatchObject({code:'browser.cancelled'});throw Error('cancelled work');}
  })).rejects.toMatchObject({code:'browser.cancelled'});
  expect(f.count().dispatches).toBe(2);
 }finally{f.close();}
});

it('public snapshot coordinates cannot mint a private source permission and mock success cannot imply consumption',async()=>{
 const f=replyContinuationFixture();try{await f.port.withPage('tab',undefined,async page=>{
  const frame=await page.collect(f.request),b={...frame.controls[0].binding};
  await page.act({kind:'click',index:b.index,snapshotId:b.snapshotId},frame.snapshot);expect(f.count().writes).toBe(1);
  const next=await page.collect(f.request),binding={...next.controls[0].binding};
  await expect(page.act({kind:'click',index:binding.index,snapshotId:binding.snapshotId},{...next.snapshot})).rejects.toMatchObject({code:'browser.stale_snapshot'});
  next.snapshot.snapshotId='fabricated';
  await expect(page.act({kind:'click',index:binding.index,snapshotId:'fabricated'},next.snapshot)).rejects.toMatchObject({code:'browser.bad_action'});
  next.snapshot.snapshotId=binding.snapshotId;
  await page.act({kind:'click',index:binding.index,snapshotId:binding.snapshotId},next.snapshot);expect(f.count().writes).toBe(2);
 });}finally{f.close();}
 const fake=fixture([readHtml(post()+'<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>')]);
 const result=await readX({tabId:'tab',read:{objective:'non-owning observer',targets:[{url:'https://x.com/alice/status/123'}],includeArticle:false,includeReplies:true,maxRepliesPerPost:20,maxScrollsPerPost:0,maxExpandActionsPerPost:1}},fake.context);
 expect(result.targets[0].diagnostics!.replyExpansions!.first).toMatchObject({outcome:'succeeded',admission:{state:'unavailable'}});
 expect(serializeXResearchResult(result).result.targets[0].diagnostics!.replyExpansions!.first!.admission).toEqual({state:'unavailable'});
});
