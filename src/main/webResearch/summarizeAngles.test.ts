import { describe, expect, it } from 'vitest';
import { summarizeAngles } from './summarizeAngles';
import type { SourceExtraction } from './extractClaims';

describe('summarizeAngles', () => {
  it('returns compact claims, opposite evidence, and gaps without passage bodies', () => {
    const sources: SourceExtraction[] = [{
      sourceId: 's1', status: 'claims', reason: undefined, examinedPassageIds: ['s1:p1'], gaps: ['发布日期不明'],
      claims: [{ claimId: 's1:c0', sourceId: 's1', statement: '仅支持 HTTPS', relevantAngleIds: ['security'],
        evidenceIds: ['s1:c0:e0', 's1:c0:e1'], verification: 'grounded' }],
      evidence: [
        { evidenceId: 's1:c0:e0', claimId: 's1:c0', sourceId: 's1', passageId: 's1:p1',
          quote: '仅支持 HTTPS', relation: 'supports', verification: 'grounded' },
        { evidenceId: 's1:c0:e1', claimId: 's1:c0', sourceId: 's1', passageId: 's1:p2',
          quote: '仍支持 HTTP', relation: 'contradicts', verification: 'grounded' },
      ],
    }];
    const result = summarizeAngles([{ id: 'security', label: '安全', query: 'protocol' }], sources);
    expect(result).toEqual([{
      angleId: 'security', label: '安全',
      claims: [{ claimId: 's1:c0', sourceId: 's1', statement: '仅支持 HTTPS', verification: 'grounded',
        supportingEvidenceIds: ['s1:c0:e0'], contradictingEvidenceIds: ['s1:c0:e1'] }],
      gaps: ['发布日期不明'], sourceStatuses: [{ sourceId: 's1', status: 'claims' }],
    }]);
    expect(JSON.stringify(result)).not.toContain('仍支持 HTTP');
    expect(JSON.stringify(result)).toContain('s1:c0:e1');
  });
});
