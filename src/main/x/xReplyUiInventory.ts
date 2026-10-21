import { z } from 'zod';

const count=z.number().int().min(0).max(5000);
const ordinal=z.number().int().min(1).max(5000);
const nodeSchema=z.object({
  sourceOrdinal:ordinal,parentSourceOrdinal:ordinal.nullable(),tag:z.string().min(1).max(32),declaredRole:z.string().max(128).nullable(),
  kind:z.enum(['heading','status','alert','button']),regionRelation:z.literal('inside'),postRelation:z.literal('outside_post_boundaries'),
  visibility:z.literal('shownReason_pass'),textSource:z.literal('xPage_innerText_or_textContent_trimmed'),text:z.string().max(512),
  textTruncation:z.object({returned:z.number().int().min(0).max(512),totalKnown:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),truncated:z.boolean()}).strict(),
}).strict().refine(n=>n.text.length===n.textTruncation.returned && n.textTruncation.returned===Math.min(512,n.textTruncation.totalKnown)
  && n.textTruncation.truncated===(n.textTruncation.totalKnown>512) && (n.parentSourceOrdinal===null || n.parentSourceOrdinal<n.sourceOrdinal)
  && n.kind===(/^h[1-6]$/.test(n.tag)?'heading':n.tag==='button'?'button':n.declaredRole));
const checkedSchema=z.object({
  state:z.literal('checked'),domain:z.literal('conversation_light_dom_semantic_nodes'),regionNodeId:z.number().int().positive(),
  traversal:z.object({visited:ordinal,truncated:z.boolean(),limit:z.literal('visited_nodes').nullable(),limitValue:z.literal(5000),eligibleTotalKnown:count.nullable()}).strict(),
  candidateCapacity:z.object({limitValue:z.literal(32),policy:z.literal('first_eligible_nodes'),truncated:z.boolean()}).strict(),
  candidateObserved:count,eligibleObserved:count,returned:z.number().int().min(0).max(32),omittedHidden:count,omittedByCandidateLimit:count,
  // Pruned roots are a separate domain; descendants were deliberately not visited.
  omittedByPrivacy:count,omittedUnsupportedSubtree:count,
  omittedUnsafeSubtree:z.object({excludedDescendant:count,subtreeNotFullyInspected:count,metadataLimit:count}).strict(),
  nodes:z.array(nodeSchema).max(32),
}).strict().refine(c=>{
  const t=c.traversal,u=c.omittedUnsafeSubtree;
  return c.returned===c.nodes.length && c.candidateObserved===c.eligibleObserved+c.omittedHidden
    && c.eligibleObserved===c.returned+c.omittedByCandidateLimit+u.excludedDescendant+u.subtreeNotFullyInspected+u.metadataLimit
    && c.omittedByCandidateLimit===Math.max(0,c.eligibleObserved-32)
    && c.candidateCapacity.truncated===(c.omittedByCandidateLimit>0)
    && c.candidateObserved+c.omittedByPrivacy+c.omittedUnsupportedSubtree<=t.visited
    && (t.truncated ? t.visited===5000 && t.limit==='visited_nodes' && t.eligibleTotalKnown===null
      : t.limit===null && t.eligibleTotalKnown===c.eligibleObserved && u.subtreeNotFullyInspected===0)
    && c.nodes.every((n,i)=>n.sourceOrdinal<=t.visited && (!i || n.sourceOrdinal>c.nodes[i-1].sourceOrdinal));
});
export const replyUiInventorySchema=z.object({
  version:z.literal(1),source:z.literal('xPage_existing_collection'),
  unsupported:z.tuple([z.literal('plain_text'),z.literal('external_aria_names'),z.literal('unloaded_ui'),z.literal('iframe'),z.literal('shadow_dom'),z.literal('unsupported_roles')]),
  capture:z.union([checkedSchema,z.object({state:z.literal('region_missing')}).strict(),z.object({state:z.literal('unavailable'),reason:z.literal('source_capture_failed')}).strict()]),
}).strict();
export type XReplyUiInventory=z.infer<typeof replyUiInventorySchema>;
/** Diagnostics have no authority. Validate their binding without creating it. */
export function replyUiInventoryMatchesRegion(inventory:XReplyUiInventory,regionNodeId:number|null):boolean {
  return inventory.capture.state==='checked' ? inventory.capture.regionNodeId===regionNodeId
    : inventory.capture.state!=='region_missing' || regionNodeId===null;
}

/** Shared parser fields retain source frame binding in canonical session records. */
export const replyUiFrameFields={
  sourceEndDetector:z.literal('not_implemented').optional(),replyUiInventory:replyUiInventorySchema.optional(),
  regionNodeId:z.number().int().positive().nullable().optional(),snapshotId:z.string().min(1).max(128).optional(),
  document:z.object({epoch:z.number().int().nonnegative(),routeRevision:z.number().int().nonnegative(),navigationSequence:z.number().int().nonnegative(),generation:z.string().min(1).max(128)}).strict().optional(),
};
type FrameBinding=z.infer<z.ZodObject<typeof replyUiFrameFields>>;
export function replyUiFrameBindingValid(frame:FrameBinding):boolean {
  return !frame.replyUiInventory || (frame.sourceEndDetector==='not_implemented' && frame.snapshotId!==undefined && frame.document!==undefined
    && frame.regionNodeId!==undefined && replyUiInventoryMatchesRegion(frame.replyUiInventory,frame.regionNodeId));
}
export const replyUiFrameSchema=z.object(replyUiFrameFields).refine(replyUiFrameBindingValid);
