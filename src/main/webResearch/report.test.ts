import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET, type WebResearchTaskRecord,
  type WebResearchTaskSource } from '../../shared/webResearchTask';
import { completeReport, validateReportCitations } from './report';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  root = await mkdtemp(path.join(tmpdir(), 'kydog-report-'));
  const sourceId = randomUUID();
  const evidenceId = 'ev-1';
  const task: WebResearchTaskRecord = { researchRunId: randomUUID(), threadId: randomUUID(),
    createdByRunId: randomUUID(), projectRoot: root, originalQuestion: '架构变化',
    createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
    revision: 1, status: 'running', angles: [], attempts: [], observationIds: [], discoveryCount: 1,
    budget: { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET }, usage: { candidates: 1, fetchesDispatched: 1,
      receivedBytes: 20, modelCalls: 1 } };
  const source: WebResearchTaskSource = { sourceId, requestedUrl: 'https://example.org/redirect',
    finalUrl: 'https://example.org/final', status: 'completed', createdAt: task.createdAt,
    updatedAt: task.updatedAt, discoveries: [], contentHash: 'hash', completeness: 'complete',
    passages: [{ sourceId, passageId: 'p-1', ordinal: 1, text: 'Parallel threads coordinate work.' }],
    extraction: { sourceId, status: 'claims', claims: [{ claimId: 'c-1', sourceId,
      statement: 'Parallel threads coordinate work.', relevantAngleIds: [], evidenceIds: [evidenceId],
      verification: 'grounded' }], evidence: [{ evidenceId, claimId: 'c-1', sourceId,
      passageId: 'p-1', quote: 'Parallel threads', relation: 'supports', verification: 'grounded' }],
      examinedPassageIds: ['p-1'], gaps: [] } };
  return { task, source, evidenceId };
}

describe('completeReport', () => {
  it('rejects a missing evidence ID and wrong final URL without creating a report', async () => {
    const { task, source } = await fixture();
    expect(await completeReport(task, [source],
      '[来源](https://example.org/final)〔证据:missing〕')).toMatchObject({ completed: false,
      validationErrors: [{ code: 'evidence_missing', line: 1, evidenceIds: ['missing'] }] });
    expect(await completeReport(task, [source],
      '[来源](https://example.org/redirect)〔证据:ev-1〕')).toMatchObject({ completed: false,
      validationErrors: [{ code: 'citation_url_mismatch', line: 1, evidenceIds: ['ev-1'] }] });
    const multiple = await completeReport(task, [source],
      '[来源](https://example.org/final)〔证据:missing〕\n坏标记〔证据:ev-1\n');
    expect(multiple).toMatchObject({ completed: false, validationErrors: [
      { code: 'evidence_missing', line: 1 }, { code: 'malformed_citation', line: 2 },
    ] });
    expect(await readdir(root!)).toEqual([]);
  });

  it('accepts comma-separated evidence IDs from one source and rejects a mixed-source list', async () => {
    const { source, evidenceId } = await fixture();
    source.extraction!.evidence.push({ ...source.extraction!.evidence[0], evidenceId: 'ev-2' });
    const valid = validateReportCitations([source],
      `[来源](https://example.org/final)〔证据:${evidenceId}, ev-2〕`);
    expect(valid).toEqual({ ok: true, publishedMarkdown: '[来源](https://example.org/final)' });
    const other = structuredClone(source);
    other.sourceId = randomUUID();
    other.finalUrl = 'https://other.example/final';
    other.extraction!.evidence[0].evidenceId = 'other-1';
    const invalid = validateReportCitations([source, other],
      '[来源](https://example.org/final)〔证据:ev-1,other-1〕');
    expect(invalid).toMatchObject({ ok: false, errors: expect.arrayContaining([
      expect.objectContaining({ code: 'mixed_source_citation', line: 1,
        evidenceIds: ['ev-1', 'other-1'] }),
      expect.objectContaining({ code: 'citation_url_mismatch', line: 1, evidenceIds: ['other-1'] }),
    ]) });
  });

  it('keeps grounded saved evidence publishable when its source later failed', async () => {
    const { source } = await fixture();
    source.status = 'failed';
    expect(validateReportCitations([source],
      '[来源](https://example.org/final)〔证据:ev-1〕')).toMatchObject({ ok: true });
  });

  it('writes a unique Markdown file and never overwrites the first report', async () => {
    const { task, source } = await fixture();
    source.extraction!.evidence.push({ ...source.extraction!.evidence[0], evidenceId: 'ev-2' });
    const markdown = '# 架构变化\n\n并行线程。[来源一](https://example.org/final)〔证据:ev-1〕' +
      '；同一段落还有另一项证据。[来源二](https://example.org/final)〔证据:ev-2〕\n';
    const firstResult = await completeReport(task, [source], markdown, 'architecture');
    const secondResult = await completeReport(task, [source], markdown, 'architecture');
    expect(firstResult.completed).toBe(true);
    expect(secondResult.completed).toBe(true);
    if (!firstResult.completed || !secondResult.completed) throw new Error('expected reports');
    const first = firstResult.reportPath;
    const second = secondResult.reportPath;
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(root);
    expect(path.basename(first)).toMatch(/^web-research-architecture-\d{4}-\d{2}-\d{2}\.md$/);
    const published = '# 架构变化\n\n并行线程。[来源一](https://example.org/final)' +
      '；同一段落还有另一项证据。[来源二](https://example.org/final)\n';
    expect(await readFile(first, 'utf8')).toBe(published);
    expect(await readFile(second, 'utf8')).toBe(published);
  });

  it('normalizes an agent-supplied report prefix and date instead of duplicating them', async () => {
    const { task, source } = await fixture();
    const result = await completeReport(task, [source],
      '[来源](https://example.org/final)〔证据:ev-1〕',
      'web-research-architecture-2026-09-30.md');
    expect(result.completed).toBe(true);
    if (!result.completed) throw new Error('expected report');
    expect(path.basename(result.reportPath)).toBe(
      `web-research-architecture-${new Date().toISOString().slice(0, 10)}.md`);
  });
});
