import { describe, expect, it } from 'vitest';
import { DEFAULT_RESEARCH_BUDGET } from '../../shared/webResearch';
import { readEvidence } from './evidenceReader';
import type { ResearchRunRecord, SavedSource } from './runStore';

describe('readEvidence', () => {
  it('includes a grounded quote near the end of a long passage in the bounded excerpt', async () => {
    const sourceId = 'source-1';
    const evidenceId = 'evidence-1';
    const passageId = `${sourceId}:p1`;
    const source: SavedSource = {
      sourceId, requestedUrl: 'https://example.org/old', finalUrl: 'https://example.org/final',
      status: 'completed', discoveries: [], evidenceIds: [evidenceId],
      passages: [{ sourceId, passageId, ordinal: 1,
        text: `${'a'.repeat(2200)}TARGET QUOTE${'b'.repeat(2200)}` }],
      extraction: { sourceId, status: 'claims', claims: [], examinedPassageIds: [passageId], gaps: [],
        evidence: [{ evidenceId, claimId: 'claim-1', sourceId, passageId, quote: 'TARGET QUOTE',
          relation: 'supports', verification: 'grounded' }] },
    };
    const run: ResearchRunRecord = {
      researchRunId: 'research-1', threadId: 'thread-1', createdByRunId: 'agent-1',
      continuationRunIds: [], originalQuestion: 'Q', createdAt: '', updatedAt: '',
      angles: [], enabledEngines: [], attempts: [], candidates: [], budget: { ...DEFAULT_RESEARCH_BUDGET },
      usage: { candidates: 1, fetchesDispatched: 1, receivedBytes: 4412, modelCalls: 1 },
      sources: [{ sourceId, requestedUrl: source.requestedUrl, finalUrl: source.finalUrl,
        status: 'completed', discoveries: [], evidenceIds: [evidenceId] }],
    };
    const result = await readEvidence(run, evidenceId, async () => source);
    expect(result.excerpt).toContain('TARGET QUOTE');
    expect(result.excerpt.length).toBeLessThanOrEqual(1601);
    expect(result.excerptTruncated).toBe(true);
    expect(result.finalUrl).toBe(source.finalUrl);
  });
});
