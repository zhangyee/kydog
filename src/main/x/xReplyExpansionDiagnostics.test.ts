import {expect,it} from 'vitest';
import {replyContinuationFixture} from '../../test-support/xReplyContinuationFixture';
import {serializeXResearchResult,xResearchToolResult} from './xResearchOutput';
import {X_RESEARCH_MAX_OUTPUT_BYTES} from './xResearchTypes';
import {XResearchEvidence} from './xResearchEvidence';
import {replyCollection} from './xReplyExpansionDiagnostics';

async function result(){const f=replyContinuationFixture({body:true});try{return await f.run({maxExpandActionsPerPost:4});}finally{f.close();}}
it('allowlists private-free reply diagnostics in normal and projected model/details and rejects inconsistent records',async()=>{
 const r=await result(),d=r.targets[0].diagnostics!.replyExpansions!;
 Object.assign(d,{token:'private-token'});Object.assign(d.first!.admission,{token:'private-token'});
 Object.assign(d.first!.binding,{rawLabel:'private-token'});Object.assign(d.first!.before,{rawLabel:'private-token'});
 expect(JSON.stringify(r)).toContain('private-token');
 for(const objective of ['normal','x'.repeat(600000)]){
  const out=serializeXResearchResult({...r,objective});
  expect(JSON.parse(out.text).targets[0].diagnostics.replyExpansions).toEqual(out.result.targets[0].diagnostics!.replyExpansions);
  expect(out.result.targets[0].diagnostics!.replyExpansions!.first!.actionIndex).toBe(2);
  expect(JSON.stringify(xResearchToolResult(out))).not.toContain('private-token');
  expect(out.result.budgetUsage.outputBytes).toBe(Buffer.byteLength(JSON.stringify(xResearchToolResult(out)),'utf8'));
 }
 const changes:Array<(d:any)=>void>=[d=>d.omittedAttempts++,d=>d.first.admission.binding.nodeId++,d=>d.first.before.snapshotId='wrong',d=>d.first.before.inventory.returned++,d=>d.first.after.inventory.items[0].postId='999',d=>d.first.after.inventory.items[0].sourceUrl+='?token=secret',d=>d.first.before.sourceAvailable=false,d=>d.first.outcome='failed',d=>d.first.usageAfter.expansions++,d=>d.first.before.state='not_observed',d=>d.first.caps.expansions=0,d=>d.first.before.location.path='/private-token',d=>d.first.before.location.origin='https://private.example',d=>d.first.usageBefore.scrolls=1,d=>d.last.targetPostId='999',d=>d.last.caps.replies=99,d=>{d.totalAttempts=2;d.omittedAttempts=0;}];
 for(const change of changes){const bad=structuredClone(r);change(bad.targets[0].diagnostics!.replyExpansions);expect(()=>serializeXResearchResult(bad)).toThrow();}
 const legacy=structuredClone(r);delete legacy.targets[0].diagnostics!.replyExpansions;expect(serializeXResearchResult(legacy).result.targets[0].diagnostics!.replyExpansions).toBeUndefined();
});
it('whole optional reply section has a precise omission under full UTF8 envelope cap',async()=>{
 const r=await result();expect(serializeXResearchResult(r).result.targets[0].diagnostics!.replyExpansions).toBeDefined();
 const minimal=structuredClone(r);delete minimal.targets[0].diagnostics;
 let lo=100000,hi=400000;
 while(lo<hi){const mid=Math.ceil((lo+hi)/2);try{serializeXResearchResult({...minimal,objective:'界'.repeat(mid)});lo=mid;}catch{hi=mid-1;}}
 let capped:ReturnType<typeof serializeXResearchResult<typeof r>>|undefined;
 for(let margin=50;margin<2500;margin+=50){try{const out=serializeXResearchResult({...r,objective:'界'.repeat(lo-margin)});if(out.result.metadataOmissions?.includes('targets.0.diagnostics.replyExpansions')){capped=out;break;}}catch{/* marker space */}}
 expect(capped).toBeDefined();if(!capped)throw Error('no omission');
 expect(capped.result.targets[0].diagnostics?.replyExpansions).toBeUndefined();expect(JSON.parse(capped.text).metadataOmissions).toContain('targets.0.diagnostics.replyExpansions');
 expect(Buffer.byteLength(JSON.stringify(xResearchToolResult(capped)),'utf8')).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
 expect(capped.result.targets[0].budgetUsage.expandActions).toBe(4);
});
it('inventory is bounded to 100 exact own identities and diagnostics grant no citation or reply scope authority',async()=>{
 const f=replyContinuationFixture();try{await f.port.withPage('tab',undefined,async page=>{
  const source=await page.collect(f.request);const one={...source.root!,containerKind:'reply' as const,directParent:null};
  source.replies=Array.from({length:103},(_,i)=>({...one,postId:String(900+i),sourceUrl:`https://x.com/own/status/${900+i}`}));
  const captured=replyCollection(source);expect(captured).toMatchObject({state:'captured',inventory:{state:'captured',total:103,returned:100,omitted:3}});
  if(captured.state!=='captured'||captured.inventory.state!=='captured')throw Error('capture expected');
  expect(captured.inventory.items.at(-1)).toEqual({postId:'999',sourceUrl:'https://x.com/own/status/999'});
 });}finally{f.close();}
 const r=await result(),ledger=new XResearchEvidence('/tmp',()=> 'run');
 const after=r.targets[0].diagnostics!.replyExpansions!.last!.after;
 if(after.state!=='captured'||after.inventory.state!=='captured')throw Error('capture expected');
 after.inventory.items.push({postId:'999',sourceUrl:'https://x.com/phantom/status/999'});after.inventory.total++;after.inventory.returned++;
 ledger.observe(serializeXResearchResult(r).result);
 expect(()=>ledger.guard('/tmp/report.md','[root](https://x.com/alice/status/123)')).not.toThrow();
 expect(()=>ledger.guard('/tmp/report.md','[phantom](https://x.com/phantom/status/999)')).toThrow();
 expect(r.targets[0].replies.scope.completeness).toBe('unknown');
});

it('rejects impossible global action span without bounding global indices by reply count',async()=>{
 const r=await result(),d=r.targets[0].diagnostics!.replyExpansions!;
 expect(d.totalAttempts).toBe(3);d.first!.actionIndex=20;d.last!.actionIndex=22;
 expect(serializeXResearchResult(r).result.targets[0].diagnostics!.replyExpansions!.first!.actionIndex).toBe(20);
 d.last!.actionIndex=21;expect(()=>serializeXResearchResult(r)).toThrow();
});
