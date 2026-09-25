import type { ResearchAngle, SourceExtraction } from '../../shared/webResearch';

export type AngleSummary = {
  angleId: string;
  label: string;
  claims: Array<{
    claimId: string;
    sourceId: string;
    statement: string;
    verification: 'grounded' | 'unverified';
    supportingEvidenceIds: string[];
    contradictingEvidenceIds: string[];
  }>;
  gaps: string[];
  sourceStatuses: Array<{ sourceId: string; status: SourceExtraction['status'] }>;
};

/** Compact, passage-free projection suitable for the main agent tool result. */
export function summarizeAngles(angles: readonly ResearchAngle[], sources: readonly SourceExtraction[]): AngleSummary[] {
  return angles.map((angle) => {
    const related = sources.filter((source) => source.claims.some((claim) => claim.relevantAngleIds.includes(angle.id)) ||
      source.status !== 'claims');
    return {
      angleId: angle.id, label: angle.label,
      claims: sources.flatMap((source) => source.claims.filter((claim) => claim.relevantAngleIds.includes(angle.id))
        .map((claim) => ({
          claimId: claim.claimId, sourceId: claim.sourceId, statement: claim.statement,
          verification: claim.verification,
          supportingEvidenceIds: source.evidence.filter((e) => e.claimId === claim.claimId &&
            e.relation === 'supports' && e.verification === 'grounded').map((e) => e.evidenceId),
          contradictingEvidenceIds: source.evidence.filter((e) => e.claimId === claim.claimId &&
            e.relation === 'contradicts' && e.verification === 'grounded').map((e) => e.evidenceId),
        }))),
      gaps: [...new Set(related.flatMap((source) => source.gaps))],
      sourceStatuses: related.map((source) => ({ sourceId: source.sourceId, status: source.status })),
    };
  });
}
