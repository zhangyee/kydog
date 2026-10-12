import INTERACT_SOURCE from './injected/interact.js?raw';
import POINTER_GUARD_SOURCE from './injected/pointerGuard.js?raw';

export type PointerTarget = ({ selector: string } | { nodeId: number }) & { document?: { generation: string; url: string } };
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
    const measured = (${INTERACT_SOURCE})(req);
    if (!measured.ok || measured.disabled === true || (req.pointer.kind === 'type' &&
      (measured.isPassword === true || measured.editable === false || measured.segmented === true))) return measured;
    const pointerGuard = (${POINTER_GUARD_SOURCE})({ op:'capture', target:req.target,
      token:req.pointer.token, expiresAt:req.pointer.expiresAt, notAfter:req.notAfter, x:measured.x, y:measured.y });
    return { ...measured, pointerGuard };
  })(${JSON.stringify({ op: 'measure', target, pointer, notAfter })})`;
}
export function pointerGuardExpression(op: 'validate' | 'dispose', pointer: PointerBinding, notAfter: number): string {
  return `(${POINTER_GUARD_SOURCE})(${JSON.stringify({ op, token: pointer.token, notAfter })})`;
}
