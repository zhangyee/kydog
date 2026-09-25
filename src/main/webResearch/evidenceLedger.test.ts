import { describe, expect, it } from 'vitest';
import { buildClaimEvidence, validateEvidence } from './evidenceLedger';

describe('evidence ledger', () => {
  const passages = new Map([['s1:p2', '新版要求 HTTPS。']]);

  it('only grounds a quote found exactly in its saved passage', () => {
    expect(validateEvidence({ quote: '新版要求 HTTPS', passageId: 's1:p2' }, passages)).toBe(true);
    expect(validateEvidence({ quote: '支持离线同步', passageId: 's1:p2' }, passages)).toBe(false);
    expect(validateEvidence({ quote: '新版要求 HTTPS', passageId: 'missing' }, passages)).toBe(false);
    expect(validateEvidence({ quote: '', passageId: 's1:p2' }, passages)).toBe(false);
  });

  it('keeps fabricated evidence visible but unverified', () => {
    const grounded = buildClaimEvidence('s1', 0, {
      statement: '新版要求 HTTPS', relevantAngleIds: ['a'],
      evidence: [{ passageId: 's1:p2', quote: '新版要求 HTTPS', relation: 'supports' }],
    }, passages);
    expect(grounded.claim.verification).toBe('grounded');
    expect(grounded.evidence[0]).toMatchObject({ passageId: 's1:p2', verification: 'grounded' });
    const invented = buildClaimEvidence('s1', 1, {
      statement: '离线同步', relevantAngleIds: ['a'],
      evidence: [{ passageId: 's1:p2', quote: '支持离线同步', relation: 'supports' }],
    }, passages);
    expect(invented.claim.verification).toBe('unverified');
    expect(invented.evidence[0]).toMatchObject({ quote: '支持离线同步', verification: 'unverified' });
  });
});
