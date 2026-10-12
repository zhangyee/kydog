import INTERACT_SOURCE from './injected/interact.js?raw';
import POINTER_GUARD_SOURCE from './injected/pointerGuard.js?raw';

export interface CollectedPermission { owner: string; token: string; purpose: string }
export type PointerTarget = ({ selector: string } | { nodeId: number }) & { document?: { generation: string; url: string }; collectedPermission?: CollectedPermission };
type Target = PointerTarget;
export interface PointerBinding { token: string; kind: 'click' | 'type'; expiresAt: number }
const DOCUMENT_CHECK = `if (req.target?.document &&
  (window.__kydogWorld?.gen !== req.target.document.generation || location.href !== req.target.document.url))
  return { ok: false, reason: 'stale_node' };`;
/** The fixed interaction program checks direct document provenance before any
 * write, even while a main-process navigation event is still in transit. */
export function guardedInteractExpression(req: { op: string; target?: PointerTarget; [key: string]: unknown }, notAfter: number): string {
  return `((req) => { ${DOCUMENT_CHECK} return (${INTERACT_SOURCE})(req); })(${JSON.stringify({ ...req, notAfter })})`;
}
/** Measure and retain the exact permission sources in one isolated JS task. */
export function measuredPointerExpression(target: Target, pointer: PointerBinding, notAfter: number): string {
  return `((req) => {
    ${DOCUMENT_CHECK}
    if (req.target.collectedPermission) {
      const allowed = (${POINTER_GUARD_SOURCE})({op:'validate_collected',target:req.target,notAfter:req.notAfter});
      if (!allowed.ok) return allowed;
    }
    const measured = (${INTERACT_SOURCE})(req);
    if (!measured.ok || measured.disabled === true || (req.pointer.kind === 'type' &&
      (measured.isPassword === true || measured.editable === false || measured.segmented === true))) return measured;
    const pointerGuard = (${POINTER_GUARD_SOURCE})({ op:'capture', target:req.target,
      token:req.pointer.token, kind:req.pointer.kind, expiresAt:req.pointer.expiresAt, notAfter:req.notAfter, x:measured.x, y:measured.y });
    return { ...measured, pointerGuard };
  })(${JSON.stringify({ op: 'measure', target, pointer, notAfter })})`;
}
export function pointerGuardExpression(op: 'validate' | 'validate_typing' | 'dispose', pointer: PointerBinding, notAfter: number): string {
  return `(${POINTER_GUARD_SOURCE})(${JSON.stringify({ op, token: pointer.token, kind: pointer.kind, notAfter })})`;
}

/** Read the original collected control's native CSS predicate without measuring. */
export function collectedPointerEligibilityExpression(target: PointerTarget, notAfter: number): string {
  return `((req) => { ${DOCUMENT_CHECK} return (${POINTER_GUARD_SOURCE})(req); })(${JSON.stringify({ op: 'validate_collected', target, readPointerEligibility: true, notAfter })})`;
}
