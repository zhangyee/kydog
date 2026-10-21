import type { Evidence, ExtractedClaim } from '../../shared/webResearch';

export type EvidenceReference = Pick<Evidence, 'passageId' | 'quote'>;
export type RawClaim = {
  statement: string;
  relevantAngleIds: string[];
  evidence: Array<EvidenceReference & { relation: Evidence['relation'] }>;
};

/** A search snippet never enters this map; only persisted fetched passages do. */
export function validateEvidence(reference: EvidenceReference, passageMap: ReadonlyMap<string, string>): boolean {
  return reference.quote.length > 0 && (passageMap.get(reference.passageId)?.includes(reference.quote) ?? false);
}

export function buildClaimEvidence(
  sourceId: string, claimIndex: number, raw: RawClaim, passageMap: ReadonlyMap<string, string>,
): { claim: ExtractedClaim; evidence: Evidence[] } {
  const claimId = `${sourceId}:c${claimIndex}`;
  const evidence = raw.evidence.map((ref, index): Evidence => ({
    evidenceId: `${claimId}:e${index}`, claimId, sourceId, passageId: ref.passageId,
    quote: ref.quote, relation: ref.relation,
    verification: validateEvidence(ref, passageMap) ? 'grounded' : 'unverified',
  }));
  return { claim: { claimId, sourceId, statement: raw.statement,
    relevantAngleIds: raw.relevantAngleIds, evidenceIds: evidence.map((item) => item.evidenceId),
    verification: evidence.some((item) => item.verification === 'grounded') ? 'grounded' : 'unverified' },
    evidence };
}
