import { KydogError } from '../../shared/errors';

export type PointerFailureStage = 'measure' | 'pointer_capture' | 'pointer_validate';
type Point = Readonly<{ x: number; y: number }>;
type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
export interface PointerFailureBinding {
  tabId: string;
  snapshotId: string | null;
  generation: string | null;
  nodeId: number | null;
}
type DiagnosticStyle = Readonly<{ display: string | null; visibility: string | null;
  pointerEvents: string | null; contentVisibility: string | null }>;
export interface PointerMeasureContext {
  relation: Readonly<{ hitConnected: boolean | null; hitContainsTarget: boolean | null }>;
  targetStyle: DiagnosticStyle | null;
  hitStyle: DiagnosticStyle | null;
  targetAutoVisibility: Readonly<{ apiAvailable: boolean; optionObserved: boolean | null; value: boolean | null; readError: boolean }>;
  contentVisibilityAncestors: Readonly<{ chain: 'parentNode-host'; complete: boolean;
    entries: readonly Readonly<{ depth: number; contentVisibility: 'auto' | 'hidden'; isOriginalHit: boolean }>[] }> | null;
}
export interface PointerHitRejection {
  /** Optional post-refusal observations, never a readiness or permission verdict. */
  measureContext?: Readonly<PointerMeasureContext> | null;
  point: Point;
  targetTag: string;
  hitTag: string | null;
  targetConnected: boolean;
  targetContainsHit: false;
  hitSameAsCaptured: boolean | null;
  rejectGeometry: {
    targetRect: Rect;
    /** Supplied only by initial measure; null records an actual null hit. */
    hitRect?: Rect | null;
    scroll: Point;
    viewport: Readonly<{ width: number; height: number }>;
  };
}
export interface PointerFailureDiagnostic extends PointerFailureBinding {
  stage: PointerFailureStage;
  reason: 'intercepted';
  nativeFrameObserved: boolean;
  point: Point;
  /** Null means structured source facts were unavailable, not that the hit was null. */
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
function rect(v: unknown): Rect | null {
  return object(v) && finite(v.x) && finite(v.y) && finite(v.width) && finite(v.height)
    && v.width >= 0 && v.height >= 0
    ? Object.freeze({ x: v.x, y: v.y, width: v.width, height: v.height }) : null;
}
const styleEnums = {
  display: ['none','contents','block','inline','run-in','flow-root','list-item','inline-block','flex','inline-flex','grid','inline-grid','table','inline-table','table-row-group','table-header-group','table-footer-group','table-row','table-cell','table-column-group','table-column','table-caption','ruby','ruby-base','ruby-text','ruby-base-container','ruby-text-container','block flow','inline flow','block flow-root','inline flow-root','block flex','inline flex','block grid','inline grid','block table','inline table','block ruby','inline ruby','block flow list-item','inline flow list-item','block flow-root list-item','inline flow-root list-item'],
  visibility: ['visible','hidden','collapse'],
  pointerEvents: ['auto','none','visiblePainted','visibleFill','visibleStroke','visible','painted','fill','stroke','all','bounding-box'],
  contentVisibility: ['visible','auto','hidden'],
};
const nullableBoolean = (v: unknown): v is boolean | null => v === null || typeof v === 'boolean';
function diagnosticStyle(v: unknown): DiagnosticStyle | null | undefined {
  if (v === null) return null;
  if (!object(v)) return undefined;
  const result: Record<string, string | null> = {};
  for (const key of Object.keys(styleEnums) as (keyof typeof styleEnums)[]) {
    const value = v[key];
    if (value !== null && (typeof value !== 'string' || !styleEnums[key].includes(value))) return undefined;
    result[key] = value;
  }
  return Object.freeze(result) as DiagnosticStyle;
}
function measureContext(v: unknown): Readonly<PointerMeasureContext> | null {
  // Optional malformed/throwing extensions cannot invalidate the old receipt.
  // Save each input once; accessors cannot substitute unchecked values on copy.
  try {
    if (!object(v)) return null;
    const { relation, targetAutoVisibility, targetStyle: rawTargetStyle,
      hitStyle: rawHitStyle, contentVisibilityAncestors: rawAncestors } = v;
    if (!object(relation) || !object(targetAutoVisibility)) return null;
    const { hitConnected, hitContainsTarget } = relation;
    const { apiAvailable, optionObserved, value, readError } = targetAutoVisibility;
    const targetStyle = diagnosticStyle(rawTargetStyle), hitStyle = diagnosticStyle(rawHitStyle);
    if (!nullableBoolean(hitConnected) || !nullableBoolean(hitContainsTarget)
      || targetStyle === undefined || hitStyle === undefined || typeof apiAvailable !== 'boolean'
      || typeof readError !== 'boolean' || !nullableBoolean(optionObserved) || !nullableBoolean(value)
      || (!apiAvailable && (optionObserved !== null || value !== null))
      || ((optionObserved !== true || readError) && value !== null)) return null;
    let ancestors: PointerMeasureContext['contentVisibilityAncestors'] = null;
    if (rawAncestors !== null) {
      if (!object(rawAncestors)) return null;
      const { chain, complete, entries: rawEntries } = rawAncestors;
      if (chain !== 'parentNode-host' || typeof complete !== 'boolean' || !Array.isArray(rawEntries)) return null;
      const entries: Array<Readonly<{ depth: number; contentVisibility: 'auto' | 'hidden'; isOriginalHit: boolean }>> = [];
      let previous = 0;
      for (const entry of rawEntries) {
        if (!object(entry)) return null;
        const { depth, contentVisibility, isOriginalHit } = entry;
        if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth <= previous
          || (contentVisibility !== 'auto' && contentVisibility !== 'hidden') || typeof isOriginalHit !== 'boolean') return null;
        previous = depth;
        entries.push(Object.freeze({ depth, contentVisibility, isOriginalHit }));
      }
      ancestors = Object.freeze({ chain, complete, entries: Object.freeze(entries) });
    }
    return Object.freeze({ relation: Object.freeze({ hitConnected, hitContainsTarget }),
      targetStyle, hitStyle, targetAutoVisibility: Object.freeze({ apiAvailable,
        optionObserved, value, readError }), contentVisibilityAncestors: ancestors });
  } catch { return null; }
}
function measureContextFromRejection(v: Record<string, unknown>): Readonly<PointerMeasureContext> | null {
  try { return measureContext(v.measureContext); } catch { return null; }
}
function rejection(v: unknown, stage: PointerFailureStage, at: Point): PointerHitRejection | null {
  if (!object(v)) return null;
  const p = point(v.point), g = v.rejectGeometry, same = v.hitSameAsCaptured;
  if (same !== null && typeof same !== 'boolean') return null;
  if (!p || p.x !== at.x || p.y !== at.y || !tag(v.targetTag) || (v.hitTag !== null && !tag(v.hitTag))
    || typeof v.targetConnected !== 'boolean' || v.targetContainsHit !== false
    // The same captured hit may have moved outside the target; retain either boolean.
    || (stage === 'pointer_validate' ? same === null : same !== null)
    || !object(g) || !object(g.targetRect) || !object(g.viewport)) return null;
  const r = g.targetRect, viewport = g.viewport, scroll = point(g.scroll);
  if (!scroll || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)
    || r.width < 0 || r.height < 0 || !finite(viewport.width) || !finite(viewport.height)
    || viewport.width < 0 || viewport.height < 0) return null;
  const hitRect = stage === 'measure' ? rect(g.hitRect) : null;
  if (stage === 'measure' && (v.hitTag === null ? g.hitRect !== null : !hitRect)) return null;
  return Object.freeze({ point: p, targetTag: v.targetTag, hitTag: v.hitTag,
    targetConnected: v.targetConnected, targetContainsHit: false, hitSameAsCaptured: same,
    ...(stage === 'measure' && 'measureContext' in v ? { measureContext: measureContextFromRejection(v) } : {}),
    rejectGeometry: Object.freeze({ targetRect: Object.freeze({ x: r.x, y: r.y, width: r.width, height: r.height }),
      ...(stage === 'measure' ? { hitRect } : {}),
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
  const hit = rejection(raw.pointerFailure, stage, at);
  if (!hit && (stage !== 'measure' || raw.pointerFailure !== undefined)) return error;
  const diagnostic = Object.freeze({ tabId: binding.tabId, snapshotId: binding.snapshotId,
    generation: binding.generation, nodeId: binding.nodeId, stage, reason: 'intercepted' as const,
    nativeFrameObserved: stage === 'pointer_validate', point: at, rejection: hit });
  return new BrowserPointerDiagnosticError(error, diagnostic);
}
/** A lookalike property, prototype, or error message cannot authenticate a receipt. */
export function pointerFailureDiagnostic(error: unknown): Readonly<PointerFailureDiagnostic> | undefined {
  return object(error) ? authenticated.get(error) : undefined;
}
