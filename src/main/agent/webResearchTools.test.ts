import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_RESEARCH_BUDGET } from '../webResearch/budget';
import { createWebResearchTools } from './webResearchTools';
import type { CollectInput } from '../../shared/webResearch';
import type { ResearchRunRecord, SavedSource } from '../webResearch/runStore';

const threadId = randomUUID();
const researchRunId = randomUUID();
const params: CollectInput = {
  originalQuestion: '新版文档要求 HTTPS 吗？', angles: [{ id: 'a', label: '安全', query: 'v2 HTTPS' }],
  enabledEngines: ['bing'], attempts: [], discoveries: [], budget: { ...DEFAULT_RESEARCH_BUDGET }, refresh: false,
};
const result = { researchRunId, angles: [], sources: [], attempts: [], budget: { ...DEFAULT_RESEARCH_BUDGET },
  usage: { candidates: 0, fetchesDispatched: 0, receivedBytes: 0, modelCalls: 0 }, gaps: [] };

describe('web research tools', () => {
  it('binds collect to the session thread and current run, without accepting a caller thread ID', async () => {
    const collect = vi.fn(async () => result);
    const tools = createWebResearchTools({ threadId, currentRunId: () => 'run-1', onProgress: () => {},
      collect, loadRun: vi.fn() });
    expect(tools.map((tool) => tool.name)).toEqual(['web_research_collect', 'web_research_evidence']);
    const response = await tools[0].execute('call-1', params, new AbortController().signal);
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ originalQuestion: params.originalQuestion }),
      expect.objectContaining({ threadId, runId: 'run-1', toolCallId: 'call-1' }), expect.any(Function));
    expect(JSON.stringify(response)).toContain(researchRunId);
    await expect(tools[0].execute('call-2', { ...params, threadId: randomUUID() }, new AbortController().signal))
      .rejects.toThrow();
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid budgets before collection and forbids cross-thread evidence reads', async () => {
    const collect = vi.fn(async () => result);
    const loadRun = vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'research.not_found' }); });
    const tools = createWebResearchTools({ threadId, currentRunId: () => 'run-1', onProgress: () => {},
      collect, loadRun });
    await expect(tools[0].execute('call-1', { ...params, budget: { maxFetches: -1 } },
      new AbortController().signal)).rejects.toThrow();
    expect(collect).toHaveBeenCalledTimes(0);
    await expect(tools[1].execute('call-2', { researchRunId, evidenceIds: ['source:c0:e0'] },
      new AbortController().signal)).rejects.toMatchObject({ code: 'research.not_found' });
    expect(loadRun).toHaveBeenCalledWith(threadId, researchRunId);
  });

  it('returns only owner-scoped saved evidence and a bounded source excerpt', async () => {
    const sourceId = randomUUID();
    const evidenceId = `${sourceId}:c0:e0`;
    const passageId = `${sourceId}:p1`;
    const source: SavedSource = { sourceId, requestedUrl: 'https://docs.example/start',
      finalUrl: 'https://docs.example/final', status: 'completed', discoveries: [],
      evidenceIds: [evidenceId], passages: [{ sourceId, passageId, ordinal: 1,
        text: `要求 HTTPS。${'x'.repeat(2000)}` }],
      extraction: { sourceId, status: 'claims', claims: [], examinedPassageIds: [passageId], gaps: [],
        evidence: [{ evidenceId, sourceId, claimId: `${sourceId}:c0`, passageId,
          quote: '要求 HTTPS', relation: 'supports', verification: 'grounded' }] } };
    const run: ResearchRunRecord = { researchRunId, threadId, originalQuestion: 'Q',
      createdAt: '', updatedAt: '', angles: [], enabledEngines: [], attempts: [], candidates: [],
      budget: { ...DEFAULT_RESEARCH_BUDGET }, usage: result.usage,
      sources: [{ sourceId, requestedUrl: source.requestedUrl, finalUrl: source.finalUrl,
        status: 'completed', discoveries: [], evidenceIds: [evidenceId] }] };
    const loadRun = vi.fn(async () => run);
    const loadSource = vi.fn(async () => source);
    const tools = createWebResearchTools({ threadId, currentRunId: () => 'run-1', onProgress: () => {},
      collect: async () => result, loadRun, loadSource });
    const response = await tools[1].execute('call-1', { researchRunId, evidenceIds: [evidenceId] });
    const payload = JSON.parse(response.content[0].text);
    expect(payload.evidence[0]).toMatchObject({ evidenceId, passageId,
      finalUrl: 'https://docs.example/final', quote: '要求 HTTPS', excerptTruncated: true });
    expect(payload.evidence[0].excerpt).toContain('要求 HTTPS');
    expect(payload.evidence[0].excerpt.length).toBeLessThan(2000);
    expect(loadRun).toHaveBeenCalledWith(threadId, researchRunId);
    await expect(tools[1].execute('call-2', { researchRunId, evidenceIds: ['missing'] }))
      .rejects.toMatchObject({ code: 'research.not_found' });
  });
});
