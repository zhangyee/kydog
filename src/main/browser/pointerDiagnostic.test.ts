import { expect, it } from 'vitest';
import { KydogError } from '../../shared/errors';
import { pointerFailureDiagnostic, retainPointerFailure } from './pointerDiagnostic';
const binding = { tabId: 'tab-source', snapshotId: 'snapshot-source', generation: 'generation-source', nodeId: 17 };
const point = { x: 73, y: 89 };
const source = () => ({ ok: false, reason: 'intercepted', pointerFailure: {
  point: { ...point }, targetTag: 'BUTTON', hitTag: 'ASIDE', targetConnected: true, targetContainsHit: false,
  hitSameAsCaptured: false, rejectGeometry: { targetRect: { x: 9, y: 27, width: 43, height: 57 },
    scroll: { x: 2, y: 524 }, viewport: { width: 1280, height: 800 } },
} });
const error = () => new KydogError('browser.click_intercepted', 'private-label https://private.example/');

it('validates reject-time source facts, strips surplus fields and authenticates only producer-created errors', () => {
  const raw = source();
  Object.assign(raw.pointerFailure, { secret: 'private-token', label: 'private-label' });
  const original = error(), saved = retainPointerFailure(original, binding, 'pointer_validate', raw, point);
  expect(pointerFailureDiagnostic(saved)).toEqual({ ...binding, stage: 'pointer_validate', reason: 'intercepted',
    nativeFrameObserved: true, point, rejection: source().pointerFailure });
  raw.pointerFailure.point.x = 999;
  expect(pointerFailureDiagnostic(saved)?.point).toEqual({ x: 73, y: 89 });
  expect(pointerFailureDiagnostic(saved)?.rejection?.point).toEqual({ x: 73, y: 89 });
  for (const fake of [original, Object.assign(error(), { diagnostic: pointerFailureDiagnostic(saved) }),
    Object.assign(Object.create(Object.getPrototypeOf(saved)), { diagnostic: pointerFailureDiagnostic(saved) })]) {
    expect(pointerFailureDiagnostic(fake)).toBeUndefined();
  }
  for (const mutate of [
    (r: ReturnType<typeof source>) => { r.pointerFailure.point.x = 74; },
    (r: ReturnType<typeof source>) => { r.pointerFailure.point.y = NaN; },
    (r: ReturnType<typeof source>) => { r.pointerFailure.targetContainsHit = true; },
    (r: ReturnType<typeof source>) => { Object.assign(r.pointerFailure, { hitSameAsCaptured: 'true' }); },
    (r: ReturnType<typeof source>) => { r.pointerFailure.targetTag = 'private class name'; },
    (r: ReturnType<typeof source>) => { r.pointerFailure.rejectGeometry.targetRect.height = -1; },
    (r: ReturnType<typeof source>) => { r.pointerFailure.rejectGeometry.viewport.width = Infinity; },
    (r: ReturnType<typeof source>) => { r.reason = 'pointer_target_changed'; },
  ]) {
    const invalid = source(); mutate(invalid);
    const refused = error();
    expect(retainPointerFailure(refused, binding, 'pointer_validate', invalid, point)).toBe(refused);
    expect(pointerFailureDiagnostic(refused)).toBeUndefined();
  }
});

it('capture and null hits preserve their different source facts without inventing a native frame', () => {
  const raw = source();
  const capture = { ...raw, pointerFailure: { ...raw.pointerFailure, hitSameAsCaptured: null, hitTag: null } };
  const saved = retainPointerFailure(error(), binding, 'pointer_capture', capture, point);
  expect(pointerFailureDiagnostic(saved)).toMatchObject({ stage: 'pointer_capture', nativeFrameObserved: false,
    rejection: { hitTag: null, hitSameAsCaptured: null } });
  const bad = error();
  expect(retainPointerFailure(bad, binding, 'pointer_validate', capture, point)).toBe(bad);
  expect(pointerFailureDiagnostic(bad)).toBeUndefined();
  for (const same of [false, true]) {
    const invalid = { ...capture, pointerFailure: { ...capture.pointerFailure, hitSameAsCaptured: same } };
    const refused = error();
    expect(retainPointerFailure(refused, binding, 'pointer_capture', invalid, point)).toBe(refused);
    expect(pointerFailureDiagnostic(refused)).toBeUndefined();
  }
});


it('retains actual lowercase SVG hit tag names from the DOM', () => {
  const raw = source(); raw.pointerFailure.hitTag = 'path';
  expect(pointerFailureDiagnostic(retainPointerFailure(error(), binding, 'pointer_validate', raw, point)))
    .toMatchObject({ rejection: { hitTag: 'path', targetTag: 'BUTTON' } });
});

it('measure distinguishes unavailable facts from a null hit and rejects malformed supplied geometry', () => {
  const make = () => ({ ...source(), ...point, pointerFailure: { ...source().pointerFailure,
    hitSameAsCaptured: null, rejectGeometry: { ...source().pointerFailure.rejectGeometry,
      hitRect: { x: 1, y: 2, width: 99, height: 101 } } } });
  const raw = make();
  const saved = retainPointerFailure(error(), binding, 'measure', raw);
  expect(pointerFailureDiagnostic(saved)).toMatchObject({ stage: 'measure', nativeFrameObserved: false,
    point, rejection: raw.pointerFailure });
  raw.pointerFailure.rejectGeometry.hitRect.width = 900;
  expect(pointerFailureDiagnostic(saved)?.rejection?.rejectGeometry.hitRect?.width).toBe(99);
  const nullHit = make();
  Object.assign(nullHit.pointerFailure, { hitTag: null });
  Object.assign(nullHit.pointerFailure.rejectGeometry, { hitRect: null });
  expect(pointerFailureDiagnostic(retainPointerFailure(error(), binding, 'measure', nullHit)))
    .toMatchObject({ rejection: { hitTag: null, rejectGeometry: { hitRect: null } } });
  expect(pointerFailureDiagnostic(retainPointerFailure(error(), binding, 'measure', {
    ok: false, reason: 'intercepted', ...point,
  }))).toMatchObject({ point, rejection: null });
  for (const mutate of [
    (r: ReturnType<typeof make>) => { Object.assign(r.pointerFailure.rejectGeometry, { hitRect: undefined }); },
    (r: ReturnType<typeof make>) => { Object.assign(r.pointerFailure.rejectGeometry, { hitRect: null }); },
    (r: ReturnType<typeof make>) => { Object.assign(r.pointerFailure, { hitTag: null }); },
    (r: ReturnType<typeof make>) => { r.pointerFailure.rejectGeometry.hitRect.x = NaN; },
    (r: ReturnType<typeof make>) => { r.pointerFailure.rejectGeometry.hitRect.height = -1; },
    (r: ReturnType<typeof make>) => { Object.assign(r.pointerFailure, { hitSameAsCaptured: false }); },
    (r: ReturnType<typeof make>) => { Object.assign(r, { pointerFailure: null }); },
  ]) {
    const invalid = make(); mutate(invalid);
    const refused = error();
    expect(retainPointerFailure(refused, binding, 'measure', invalid)).toBe(refused);
    expect(pointerFailureDiagnostic(refused)).toBeUndefined();
  }
});


it('validates optional context separately so malformed private extensions cannot erase the older receipt', () => {
  const context = { relation: { hitConnected: true, hitContainsTarget: false }, targetStyle: { display: 'inline flex', visibility: 'visible', pointerEvents: 'none', contentVisibility: 'visible' }, hitStyle: null,
    targetAutoVisibility: { apiAvailable: true, optionObserved: true, value: false, readError: false }, contentVisibilityAncestors: { chain: 'parentNode-host', complete: false, entries: [{ depth: 1, contentVisibility: 'auto', isOriginalHit: false }] } };
  const make = (extra: unknown) => ({ ...source(), ...point, pointerFailure: { ...source().pointerFailure, hitSameAsCaptured: null, measureContext: extra, rejectGeometry: { ...source().pointerFailure.rejectGeometry, hitRect: { x: 2, y: 7, width: 43, height: 33 } } } });
  const raw = make({ ...context, secret: 'private-secret', targetStyle: { ...context.targetStyle, cssText: 'private-css' } });
  const saved = pointerFailureDiagnostic(retainPointerFailure(error(), binding, 'measure', raw))!;
  expect(saved.rejection).toMatchObject({ measureContext: context });
  expect(Object.isFrozen(saved.rejection?.measureContext?.contentVisibilityAncestors?.entries[0])).toBe(true);
  expect(JSON.stringify(raw)).toContain('private-');
  expect(JSON.stringify(saved)).not.toContain('private-');
  const throwing = make(context);
  Object.defineProperty(throwing.pointerFailure, 'measureContext', { get() { throw new Error('private-read'); } });
  expect(pointerFailureDiagnostic(retainPointerFailure(error(), binding, 'measure', throwing))?.rejection).toMatchObject({ targetTag: 'BUTTON', measureContext: null });
  for (const bad of [{ ...context, targetStyle: { ...context.targetStyle, display: 'private-css' } }, { ...context, relation: { hitConnected: 'true', hitContainsTarget: false } }, { ...context, targetAutoVisibility: { apiAvailable: false, optionObserved: true, value: true, readError: false } }, { ...context, contentVisibilityAncestors: { chain: 'flat-tree', complete: true, entries: [] } }, { ...context, contentVisibilityAncestors: { chain: 'parentNode-host', complete: true, entries: [{ depth: NaN, contentVisibility: 'auto', isOriginalHit: false }] } }, 'private-malformed']) {
    const diagnostic = pointerFailureDiagnostic(retainPointerFailure(error(), binding, 'measure', make(bad)))!;
    expect(diagnostic.rejection).toMatchObject({ targetTag: 'BUTTON', hitTag: 'ASIDE', measureContext: null });
    expect(JSON.stringify(diagnostic)).not.toContain('private-');
  }
  expect(pointerFailureDiagnostic(retainPointerFailure(error(), binding, 'pointer_validate', { ...source(), pointerFailure: { ...source().pointerFailure, measureContext: context } }, point))?.rejection).toEqual(source().pointerFailure);
});


it('retains only the first validated optional values across changing object and scalar accessors', () => {
  const context = () => ({ relation: { hitConnected: true, hitContainsTarget: false }, targetStyle: { display: 'block', visibility: 'visible', pointerEvents: 'none', contentVisibility: 'visible' }, hitStyle: null,
    targetAutoVisibility: { apiAvailable: true, optionObserved: true, value: false, readError: false }, contentVisibilityAncestors: { chain: 'parentNode-host', complete: false, entries: [{ depth: 3, contentVisibility: 'hidden', isOriginalHit: true }] } });
  const make = (extra: unknown) => ({ ...source(), ...point, pointerFailure: { ...source().pointerFailure, hitSameAsCaptured: null, measureContext: extra, rejectGeometry: { ...source().pointerFailure.rejectGeometry, hitRect: { x: 2, y: 7, width: 43, height: 33 } } } });
  const save = (extra: unknown) => pointerFailureDiagnostic(retainPointerFailure(error(), binding, 'measure', make(extra)))!;
  for (const path of [
    ['relation'], ['relation', 'hitConnected'], ['relation', 'hitContainsTarget'], ['targetStyle'], ['hitStyle'],
    ['targetStyle', 'display'], ['targetStyle', 'visibility'], ['targetStyle', 'pointerEvents'], ['targetStyle', 'contentVisibility'],
    ['targetAutoVisibility'], ['targetAutoVisibility', 'apiAvailable'], ['targetAutoVisibility', 'optionObserved'], ['targetAutoVisibility', 'value'], ['targetAutoVisibility', 'readError'],
    ['contentVisibilityAncestors'], ['contentVisibilityAncestors', 'chain'], ['contentVisibilityAncestors', 'complete'], ['contentVisibilityAncestors', 'entries'],
    ['contentVisibilityAncestors', 'entries', '0', 'depth'], ['contentVisibilityAncestors', 'entries', '0', 'contentVisibility'], ['contentVisibilityAncestors', 'entries', '0', 'isOriginalHit'],
  ]) {
    const valid = save(context());
    expect(valid.rejection).toMatchObject({ targetTag: 'BUTTON', measureContext: context() });
    const raw = context(), parent = path.slice(0, -1).reduce((v, key) => v[key] as Record<string, unknown>, raw as unknown as Record<string, unknown>), key = path.at(-1)!;
    const first = parent[key]; let reads = 0;
    Object.defineProperty(parent, key, { configurable: true, get() { return ++reads === 1 ? first : 'private-secret'; } });
    const diagnostic = save(raw);
    expect(diagnostic.rejection?.measureContext, path.join('.')).toEqual(context());
    expect(reads, path.join('.')).toBe(1);
    expect(parent[key]).toBe('private-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('private-secret');
    Object.defineProperty(parent, key, { configurable: true, get() { throw new Error('private-secret'); } });
    const unavailable = save(raw);
    expect(unavailable.rejection).toMatchObject({ targetTag: 'BUTTON', hitTag: 'ASIDE', measureContext: null });
    expect(unavailable.rejection?.rejectGeometry).toEqual(valid.rejection?.rejectGeometry);
    expect(JSON.stringify(unavailable)).not.toContain('private-secret');
    reads = 0;
    Object.defineProperty(parent, key, { get() { return ++reads === 1 ? 'private-secret' : first; } });
    const malformed = save(raw);
    expect(malformed.rejection).toMatchObject({ targetTag: 'BUTTON', measureContext: null });
    expect(malformed.rejection?.rejectGeometry).toEqual(valid.rejection?.rejectGeometry);
    expect(reads, path.join('.')).toBe(1);
    expect(parent[key]).toEqual(first);
    expect(JSON.stringify(malformed)).not.toContain('private-secret');
  }
  const unknown = { relation: { hitConnected: null, hitContainsTarget: null }, targetStyle: null, hitStyle: null,
    targetAutoVisibility: { apiAvailable: false, optionObserved: null, value: null, readError: false }, contentVisibilityAncestors: null };
  expect(save(unknown).rejection?.measureContext).toEqual(unknown);
});

it('preserves authenticated phase observations separately from measure and strips private extensions',()=>{
 const refusalContext={phase:'pointer_validate',hitRect:{x:21,y:34,width:56,height:78},relation:{hitConnected:true,hitContainsTarget:true},targetStyle:{display:'block',visibility:'visible',pointerEvents:'none',contentVisibility:'visible'},hitStyle:null};
 const postFrame={phase:'post_frame',state:'none',samplePhase:'before_first_hit',relationPhase:'first_hit',hitConnected:true,hitContainsTarget:true};
 const eligibility={phase:'collected_eligibility',firstState:'auto',noneObserved:false,finalState:'auto',outcome:'eligible'};
 const raw={...source(),pointerFailure:{...source().pointerFailure,refusalContext:{...refusalContext,secret:'private-secret'}}};
 const saved=pointerFailureDiagnostic(retainPointerFailure(error(),binding,'pointer_validate',raw,point,{eligibility,postFrame}));
 expect(saved).toMatchObject({eligibility,postFrame,rejection:{refusalContext}});
 expect(JSON.stringify(raw)).toContain('private-secret');expect(JSON.stringify(saved)).not.toContain('private-secret');
 const malformed={...raw,pointerFailure:{...raw.pointerFailure,refusalContext:{...refusalContext,phase:'measure'}}};
 expect(pointerFailureDiagnostic(retainPointerFailure(error(),binding,'pointer_validate',malformed,point))?.rejection).toMatchObject({targetTag:'BUTTON',refusalContext:null});
});
