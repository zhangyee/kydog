import { KydogError } from '../../shared/errors';

export type PointerFailureStage = 'measure' | 'pointer_capture' | 'pointer_validate';
type Point = Readonly<{ x: number; y: number }>;
export interface PointerFailureBinding {
  tabId: string;
  snapshotId: string | null;
  generation: string | null;
  nodeId: number | null;
}
export interface PointerHitRejection {
  point: Point;
  targetTag: string;
  hitTag: string | null;
  targetConnected: boolean;
  targetContainsHit: false;
  hitSameAsCaptured: boolean | null;
  rejectGeometry: {
    targetRect: Readonly<{ x: number; y: number; width: number; height: number }>;
    scroll: Point;
    viewport: Readonly<{ width: number; height: number }>;
  };
}
export interface PointerFailureDiagnostic extends PointerFailureBinding {
  stage: PointerFailureStage;
  reason: 'intercepted';
  nativeFrameObserved: boolean;
  point: Point;
  /** Initial measure supplies no structured hit receipt. Null means unavailable. */
  rejection: PointerHitRejection | null;
}
const authenticated = new WeakMap<object, Readonly<PointerFailureDiagnostic>>();
class BrowserPointerDiagnosticError extends KydogError {
  constructor(error: KydogError, readonly diagnostic: Readonly<PointerFailureDiagnostic>) {
    super(error.code, error.message, error);
    authenticated.set(this, diagnostic);
    Object.defineProperty(this, 'diagnostic', { value: diagnostic, writable: false });
  }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const identity = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(v);
const tag = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(v);
function point(v: unknown): Point | null {
  return object(v) && finite(v.x) && finite(v.y) ? Object.freeze({ x: v.x, y: v.y }) : null;
}
function rejection(v: unknown, stage: PointerFailureStage, at: Point): PointerHitRejection | null {
  if (!object(v)) return null;
  const p = point(v.point), g = v.rejectGeometry, same = v.hitSameAsCaptured;
  if (same !== null && typeof same !== 'boolean') return null;
  if (!p || p.x !== at.x || p.y !== at.y || !tag(v.targetTag) || (v.hitTag !== null && !tag(v.hitTag))
    || typeof v.targetConnected !== 'boolean' || v.targetContainsHit !== false
    // The same captured hit may have moved outside the target; retain either boolean.
    || (stage === 'pointer_capture' ? same !== null : same === null)
    || !object(g) || !object(g.targetRect) || !object(g.viewport)) return null;
  const r = g.targetRect, viewport = g.viewport, scroll = point(g.scroll);
  if (!scroll || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)
    || r.width < 0 || r.height < 0 || !finite(viewport.width) || !finite(viewport.height)
    || viewport.width < 0 || viewport.height < 0) return null;
  return Object.freeze({ point: p, targetTag: v.targetTag, hitTag: v.hitTag,
    targetConnected: v.targetConnected, targetContainsHit: false, hitSameAsCaptured: same,
    rejectGeometry: Object.freeze({ targetRect: Object.freeze({ x: r.x, y: r.y, width: r.width, height: r.height }),
      scroll, viewport: Object.freeze({ width: viewport.width, height: viewport.height }) }),
  });
}
/** Called only at existing trusted main dispatch boundaries. Invalid diagnostics
 * leave the original refusal untouched; never replace or relax its verdict. */
export function retainPointerFailure(error: KydogError, binding: PointerFailureBinding,
  stage: PointerFailureStage, raw: unknown, measuredPoint?: Point): KydogError {
  if (error.code !== 'browser.click_intercepted' || !object(raw) || raw.ok !== false || raw.reason !== 'intercepted'
    || !['measure', 'pointer_capture', 'pointer_validate'].includes(stage)
    || !identity(binding.tabId) || (binding.snapshotId !== null && !identity(binding.snapshotId))
    || (binding.generation !== null && !identity(binding.generation))
    || (binding.nodeId !== null && (!Number.isSafeInteger(binding.nodeId) || binding.nodeId < 0))) return error;
  const at = point(stage === 'measure' ? raw : measuredPoint);
  if (!at) return error;
  const hit = stage === 'measure' ? null : rejection(raw.pointerFailure, stage, at);
  if (stage !== 'measure' && !hit) return error;
  const diagnostic = Object.freeze({ tabId: binding.tabId, snapshotId: binding.snapshotId,
    generation: binding.generation, nodeId: binding.nodeId, stage, reason: 'intercepted' as const,
    nativeFrameObserved: stage === 'pointer_validate', point: at, rejection: hit });
  return new BrowserPointerDiagnosticError(error, diagnostic);
}
/** A lookalike property, prototype, or error message cannot authenticate a receipt. */
export function pointerFailureDiagnostic(error: unknown): Readonly<PointerFailureDiagnostic> | undefined {
  return object(error) ? authenticated.get(error) : undefined;
}
