import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import SOURCE from './injected/interact.js?raw';

// Production expression; only browser layout/event/frame delivery is substituted.
function fixture(nested = false, offset = 10.25) {
  const dom = new JSDOM('<main><div id="other"></div><div id="scroll"><span></span></div></main>', {url:'https://x.com/alice/status/123',runScripts:'outside-only'});
  const w = dom.window, d = w.document, box = d.querySelector('#scroll')!;
  const target = nested ? box : d.documentElement;
  Object.defineProperty(d, 'scrollingElement', {value:d.documentElement});
  for (const [key,value] of Object.entries({scrollHeight:2000,clientHeight:200})) Object.defineProperty(target,key,{value});
  target.scrollTop=offset;
  Object.assign(d,{elementFromPoint:()=>target});
  Object.assign(w,{innerHeight:200,getComputedStyle:()=>({overflowY:'auto'}),__kydogWorld:{gen:'g1',next:1,ids:new WeakMap()}});
  const listeners = new Map<EventTarget, Set<(event: Event) => void>>();
  for (const el of [d,target]) {
    const add=el.addEventListener.bind(el),remove=el.removeEventListener.bind(el);
    el.addEventListener=((name:string,fn:(event: Event) => void,...rest:unknown[])=>{if(name==='scroll'){const s=listeners.get(el)??new Set();s.add(fn);listeners.set(el,s);}else add(name,fn,...rest as []);}) as typeof el.addEventListener;
    el.removeEventListener=((name:string,fn:(event: Event) => void,...rest:unknown[])=>{if(name==='scroll')listeners.get(el)?.delete(fn);else remove(name,fn,...rest as []);}) as typeof el.removeEventListener;
  }
  const frames=new Map<number,(time:number)=>void>();let next=0;
  w.requestAnimationFrame=fn=>{frames.set(++next,fn);return next;};w.cancelAnimationFrame=id=>{frames.delete(id);};
  const run=(req:Record<string,unknown>)=>w.eval(`(${SOURCE})(${JSON.stringify(req)})`) as {ok:boolean;reason?:string;acknowledgement:{written:boolean;eventObserved:boolean;frameObserved:boolean;state:string}};
  const begin=(amount=200)=>run({op:'scroll',direction:'down',amount,acknowledgement:{token:'one',expiresAt:Date.now()+3000,document:{generation:'g1',url:w.location.href},relationNodes:{conversationNodeId:1,rootNodeId:2}}});
  const status=()=>run({op:'scroll_ack_status',token:'one'});
  const dispose=()=>run({op:'scroll_ack_dispose',token:'one'});
  const event=(eventTarget:EventTarget=nested?target:d,trusted=true)=>{for(const fn of listeners.get(nested?target:d)??[])fn({target:eventTarget,isTrusted:trusted} as unknown as Event);};
  const frame=()=>{const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(1);};
  const close=()=>{dispose();dom.window.close();};
  return {w,d,target,run,begin,status,dispose,event,frame,frames,listeners,close};
}
afterEach(()=>vi.useRealTimers());
describe('private scroll delivery acknowledgement',()=>{
  it.each([false,true])('requires exact trusted target event then frame (nested=%s)',nested=>{
    const f=fixture(nested);
    try {
      expect(f.begin()).toMatchObject({ok:true,acknowledgement:{written:true,before:10.25,after:210.25,state:'pending'}});
      expect(f.status().acknowledgement).toMatchObject({targetNodeId:1,targetContainsHit:true,conversationRelation:'equal',rootRelation:'unknown',scrollHeight:2000,clientHeight:200});
      f.event();f.frame();expect(f.status()).toMatchObject({ok:true,acknowledgement:{eventObserved:true,frameObserved:true,state:'frame_observed'}});
      f.dispose();f.begin();
      f.frame();expect(f.status().acknowledgement.state).toBe('pending');
      f.event(f.d.querySelector('#other')!);f.frame();expect(f.status().acknowledgement.state).toBe('pending');
      f.event(nested?f.target:f.d,false);f.frame();expect(f.status().acknowledgement.state).toBe('pending');
      f.event();expect(f.status().acknowledgement).toMatchObject({eventObserved:true,frameObserved:false,state:'pending'});
      f.frame();expect(f.status().acknowledgement.state).toBe('frame_observed');
    } finally {f.close();}
  });
  it('rejects changed physical target, raw offset or document without rebinding',()=>{
    const positive=fixture();positive.begin();positive.event();positive.frame();expect(positive.status().acknowledgement.state).toBe('frame_observed');positive.close();
    for(const mutation of ['offset','detached','generation','url'] as const){
      const f=fixture(true);
      try {f.begin();f.event();
        if(mutation==='offset')f.target.scrollTop+=0.125;
        if(mutation==='detached')f.target.replaceWith(f.target.cloneNode(true));
        if(mutation==='generation')(f.w as unknown as {__kydogWorld:{gen:string}}).__kydogWorld.gen='g2';
        if(mutation==='url')f.w.history.replaceState(null,'','/alice/status/124');
        f.frame();expect(f.status().acknowledgement).toMatchObject({written:true,frameObserved:false,state:'invalidated'});
        expect(f.frames.size).toBe(0);
      } finally {f.close();}
    }
  });
  it('preserves executed no-op and expiry receipts, and disposal removes owned callbacks',()=>{
    const f=fixture();
    try {
      f.begin();f.event();f.frame();expect(f.status().acknowledgement.state).toBe('frame_observed');f.dispose();
      expect(f.begin(0).acknowledgement).toMatchObject({written:true,before:210.25,after:210.25,state:'no_movement',eventObserved:false,frameObserved:false});f.dispose();
      f.begin();expect([...f.listeners.values()].reduce((n,s)=>n+s.size,0)).toBe(1);f.event();expect(f.frames.size).toBe(1);
      expect(f.dispose().acknowledgement).toMatchObject({written:true,state:'pending'});
      expect(f.frames.size).toBe(0);expect([...f.listeners.values()].reduce((n,s)=>n+s.size,0)).toBe(0);expect(f.status()).toMatchObject({ok:false,reason:'missing_scroll_ack'});
      f.begin();const expired=Date.now()+3001;vi.spyOn(f.w.Date,'now').mockReturnValue(expired);
      expect(f.status().acknowledgement).toMatchObject({written:true,before:410.25,after:610.25,state:'expired',frameObserved:false});
    } finally {f.close();}
  });
});
