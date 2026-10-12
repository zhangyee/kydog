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
