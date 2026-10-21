import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_RESEARCH_BUDGET, ResearchBudgetMeter } from './budget';
import { createResearchModelAdapter, extractSource, ModelPermitPool, type ModelAdapter, type ModelRequest } from './extractClaims';
import type { Discovery, Passage, ResearchAngle } from '../../shared/webResearch';

const angles: ResearchAngle[] = [
  { id: 'a', label: '协议变化', query: 'v2 protocol', rationale: '确认新版本' },
  { id: 'b', label: '迁移', query: 'v2 migration' },
];
const discoveries: Discovery[] = [
  { attemptId: 'ddg', angleId: 'a', engineId: 'duckduckgo', query: 'v2 protocol',
    resultUrl: 'https://docs.example/v2', searchPageUrl: 'https://duckduckgo.com/?q=v2', snippet: '新协议' },
  { attemptId: 'bing', angleId: 'b', engineId: 'bing', query: 'v2 migration',
    resultUrl: 'https://docs.example/v2', searchPageUrl: 'https://bing.com/search?q=v2', snippet: '迁移指南' },
];
const passages: Passage[] = [{ sourceId: 's1', passageId: 's1:p1', ordinal: 1, heading: 'V2', text: '新版要求 HTTPS。' }];
const modelSnapshot = { providerId: 'anthropic', modelId: 'claude-x', runtimeRevision: 7 };
const signal = () => new AbortController().signal;
const meter = (maxModelCalls = 10) => new ResearchBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET,
  maxModelCalls, maxOutputTokensPerCall: 700, modelConcurrency: 2 });
const reply = (text: string, stopReason = 'stop') => ({ text, stopReason });
const claimReply = JSON.stringify({ status: 'claims', claims: [{ statement: '新版要求 HTTPS',
  relevantAngleIds: ['a'], evidence: [{ passageId: 's1:p1', quote: '新版要求 HTTPS', relation: 'supports' }] }] });

it('opens waiting model work when the task raises model concurrency', async () => {
  const pool = new ModelPermitPool(1);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  const first = pool.run(signal(), async () => { firstStarted(); await firstGate; });
  await firstReady;
  const secondWork = vi.fn(async () => {});
  const second = pool.run(signal(), secondWork);
  expect(secondWork).not.toHaveBeenCalled();
  pool.raiseLimit(2);
  await second;
  expect(secondWork).toHaveBeenCalledOnce();
  releaseFirst();
  await first;
});

describe('extractSource', () => {
  it('sends the original question, every discovery, and only this source passage to an isolated call', async () => {
    const complete = vi.fn(async (_request: ModelRequest) => reply(claimReply));
    const adapter: ModelAdapter = { currentRevision: () => 7, complete };
    const result = await extractSource({ sourceId: 's1', question: 'v2 的安全协议是什么？', angles, discoveries,
      passages, completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter });
    expect(result.status).toBe('claims');
    expect(result.claims[0].verification).toBe('grounded');
    expect(result.evidence[0].passageId).toBe('s1:p1');
    const sent = complete.mock.calls[0][0];
    expect(sent.userText).toContain('v2 的安全协议是什么？');
    expect(sent.userText).toContain('duckduckgo');
    expect(sent.userText).toContain('bing');
    expect(sent.userText).toContain('协议变化');
    expect(sent.userText).toContain('迁移');
    expect(sent.userText).toContain('新版要求 HTTPS。');
    expect(sent.maxTokens).toBe(700);
    expect(sent.signal).toBeDefined();
    expect(JSON.stringify(result)).not.toContain('新版要求 HTTPS。');
  });

  it('never calls a truncated source irrelevant, even when the model says irrelevant', async () => {
    const adapter: ModelAdapter = { currentRevision: () => 7,
      complete: async () => reply('{"status":"irrelevant","claims":[]}') };
    const common = { sourceId: 's1', question: 'Q', angles, discoveries, passages, modelSnapshot,
      signal: signal(), permits: new ModelPermitPool(2), adapter };
    const complete = await extractSource({ ...common, completeness: 'complete', budget: meter() });
    expect(complete.status).toBe('irrelevant');
    const truncated = await extractSource({ ...common, completeness: 'truncated', budget: meter() });
    expect(truncated.status).toBe('incomplete');
  });

  it('marks a text-only access barrier as needing browser review without claiming irrelevance', async () => {
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries,
      passages: [{ ...passages[0], text: 'Security verification. Complete the check to continue.' }],
      completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter: { currentRevision: () => 7,
        complete: async () => reply('{"status":"needs_browser","claims":[],"barriers":['
          + '{"passageId":"s1:p1","quote":"Security verification"}]}') } });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('needs_browser');
    expect(result.claims).toHaveLength(0);
    expect(result.barriers).toEqual([{ passageId: 's1:p1', quote: 'Security verification' }]);
  });

  it('keeps earlier grounded claims when a later block reports needs_browser', async () => {
    const both = [{ ...passages[0], text: '新版要求 HTTPS。' },
      { ...passages[0], passageId: 's1:p2', ordinal: 2,
        text: 'Security verification. Complete the check to continue.' }];
    const complete = vi.fn(async ({ userText }: ModelRequest) => {
      const block = (JSON.parse(userText) as { passages: Array<{ passageId: string }> }).passages;
      return block[0].passageId === 's1:p1' ? reply(claimReply) : reply(JSON.stringify({
        status: 'needs_browser', claims: [], barriers: [{ passageId: 's1:p2',
          quote: 'Security verification', detail: 'client challenge' }], gaps: ['正文不可见'],
      }));
    });
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries,
      passages: both, completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter: { currentRevision: () => 7, complete },
      maxCharsPerBlock: 60 });
    expect(result.status).toBe('claims');
    expect(result.claims).toHaveLength(1);
    expect(result.barriers).toEqual([{ passageId: 's1:p2', quote: 'Security verification',
      detail: 'client challenge' }]);
    expect(result.examinedPassageIds).toEqual(['s1:p1', 's1:p2']);
  });

  it('retries an ungrounded needs_browser barrier then reports invalid_model_output', async () => {
    const complete = vi.fn(async () => reply(JSON.stringify({ status: 'needs_browser', claims: [],
      barriers: [{ passageId: 's1:p1', quote: 'invented challenge' }] })));
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries, passages,
      completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter: { currentRevision: () => 7, complete } });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid_model_output', barriers: [] });
    expect(result.gaps[0]).toContain('未处理分块');
  });

  it('preserves earlier claims and records the unprocessed range after a later model error', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(reply(claimReply))
      .mockResolvedValueOnce(reply('', 'error'));
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries,
      passages: [...passages, { ...passages[0], passageId: 's1:p2', ordinal: 2, text: '第二个分块' }],
      completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter: { currentRevision: () => 7, complete },
      maxCharsPerBlock: 10 });
    expect(result).toMatchObject({ status: 'failed', reason: 'model_error' });
    expect(result.claims).toHaveLength(1);
    expect(result.examinedPassageIds).toEqual(['s1:p1']);
    expect(result.gaps[0]).toContain('2-2');
  });

  it.each([
    ['length', 'failed'], ['aborted', 'failed'], ['toolUse', 'failed'],
  ])('handles stopReason %s as %s', async (stopReason, expected) => {
    const adapter: ModelAdapter = { currentRevision: () => 7, complete: async () => reply(claimReply, stopReason) };
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries, passages,
      completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter });
    expect(result.status).toBe(expected);
    expect(result.claims).toHaveLength(0);
  });

  it('retries a length-truncated response with both halves of one passage', async () => {
    const budget = meter();
    const adapter: ModelAdapter = { currentRevision: () => 7, complete: async ({ userText }) => {
      const block = (JSON.parse(userText) as { passages: Array<{ passageId: string; text: string }> }).passages;
      const text = block.map((part) => part.text).join('');
      if (text.length > 4) return reply('', 'length');
      return reply(JSON.stringify({ status: 'claims', claims: [{ statement: text,
        relevantAngleIds: ['a'], evidence: [{ passageId: 's1:p1', quote: text, relation: 'supports' }] }] }));
    } };
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries,
      passages: [{ ...passages[0], text: '甲乙丙丁戊己庚辛' }], completeness: 'complete', modelSnapshot,
      budget, signal: signal(), permits: new ModelPermitPool(2), adapter, maxCharsPerBlock: 8 });
    expect(result.status).toBe('claims');
    expect(result.claims.map((claim) => claim.statement)).toEqual(['甲乙丙丁', '戊己庚辛']);
    expect(result.evidence.map((item) => item.verification)).toEqual(['grounded', 'grounded']);
    expect(result.examinedPassageIds).toEqual(['s1:p1']);
    expect(budget.usage.modelCalls).toBe(3);
  });

  it('retries a length-truncated block and still processes later blocks', async () => {
    const adapter: ModelAdapter = { currentRevision: () => 7, complete: async ({ userText }) => {
      const block = (JSON.parse(userText) as { passages: Array<{ passageId: string; text: string }> }).passages;
      if (block.length > 1) return reply('', 'length');
      return reply(JSON.stringify({ status: 'claims', claims: [{ statement: block[0].text,
        relevantAngleIds: ['a'], evidence: [{ passageId: block[0].passageId,
          quote: block[0].text, relation: 'supports' }] }] }));
    } };
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries,
      passages: [{ ...passages[0], text: '甲乙丙丁' },
        { ...passages[0], passageId: 's1:p2', ordinal: 2, text: '戊己庚辛' },
        { ...passages[0], passageId: 's1:p3', ordinal: 3, text: '壬癸子丑' }],
      completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter, maxCharsPerBlock: 8 });
    expect(result.status).toBe('claims');
    expect(result.claims.map((claim) => claim.statement)).toEqual(['甲乙丙丁', '戊己庚辛', '壬癸子丑']);
    expect(result.evidence.map((item) => item.verification)).toEqual(['grounded', 'grounded', 'grounded']);
    expect(result.examinedPassageIds).toEqual(['s1:p1', 's1:p2', 's1:p3']);
  });

  it('stops later blocks when the pinned runtime revision changes', async () => {
    let revision = 7;
    const complete = vi.fn(async () => { revision = 8; return reply('{"status":"irrelevant","claims":[]}'); });
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries,
      passages: [...passages, { sourceId: 's1', passageId: 's1:p2', ordinal: 2, text: '第二段' }],
      completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter: { currentRevision: () => revision, complete }, maxCharsPerBlock: 10 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('model_changed');
  });

  it('charges malformed reply retries against the call budget', async () => {
    const complete = vi.fn().mockResolvedValueOnce(reply('not JSON')).mockResolvedValueOnce(reply(claimReply));
    const budget = meter(1);
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries, passages,
      completeness: 'complete', modelSnapshot, budget, signal: signal(),
      permits: new ModelPermitPool(2), adapter: { currentRevision: () => 7, complete } });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(budget.usage.modelCalls).toBe(1);
    expect(result.status).toBe('failed');
  });

  it('marks an invented quote or omitted passage ID unverified without dropping the claim', async () => {
    const output = JSON.stringify({ status: 'claims', claims: [
      { statement: '离线同步', relevantAngleIds: ['a'],
        evidence: [{ passageId: 's1:p1', quote: '支持离线同步', relation: 'supports' }] },
      { statement: '版本默认加密', relevantAngleIds: ['a'],
        evidence: [{ quote: '新版要求 HTTPS', relation: 'supports' }] },
    ] });
    const result = await extractSource({ sourceId: 's1', question: 'Q', angles, discoveries, passages,
      completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter: { currentRevision: () => 7, complete: async () => reply(output) } });
    expect(result.status).toBe('claims');
    expect(result.claims.map((claim) => claim.verification)).toEqual(['unverified', 'unverified']);
    expect(result.evidence.map((item) => item.verification)).toEqual(['unverified', 'unverified']);
    expect(result.evidence[1].passageId).toBe('');
  });

  it('releases a model permit after failure', async () => {
    const permits = new ModelPermitPool(1);
    await expect(permits.run(signal(), async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    await expect(permits.run(signal(), async () => 'available')).resolves.toBe('available');
  });

  it('does not spend a model call or dispatch after cancellation while waiting for a permit', async () => {
    const permits = new ModelPermitPool(1);
    let release!: () => void;
    const holder = permits.run(signal(), () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve(); // let the holder acquire before the second call queues
    const controller = new AbortController();
    const budget = meter();
    const complete = vi.fn(async () => reply(claimReply));
    const pending = extractSource({ sourceId: 's1', question: 'Q', angles, discoveries, passages,
      completeness: 'complete', modelSnapshot, budget, signal: controller.signal, permits,
      adapter: { currentRevision: () => 7, complete } });
    controller.abort();
    release();
    await holder;
    const result = await pending;
    expect(result.status).toBe('incomplete');
    expect(budget.usage.modelCalls).toBe(0);
    expect(complete).toHaveBeenCalledTimes(0);
  });
});

describe('research model fixture', () => {
  const originalE2e = process.env.KYDOG_E2E;
  const originalFixture = process.env.KYDOG_WEB_RESEARCH_FIXTURE;
  let fixtureDir: string | undefined;
  afterEach(() => {
    if (originalE2e === undefined) delete process.env.KYDOG_E2E; else process.env.KYDOG_E2E = originalE2e;
    if (originalFixture === undefined) delete process.env.KYDOG_WEB_RESEARCH_FIXTURE;
    else process.env.KYDOG_WEB_RESEARCH_FIXTURE = originalFixture;
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('uses ordered replies only in e2e and errors when exhausted', async () => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), 'kydog-web-research-'));
    const fixturePath = path.join(fixtureDir, 'replies.json');
    writeFileSync(fixturePath, JSON.stringify([{ text: claimReply, stopReason: 'stop' }]));
    process.env.KYDOG_E2E = '1';
    process.env.KYDOG_WEB_RESEARCH_FIXTURE = fixturePath;
    const adapter = createResearchModelAdapter();
    const request = { modelSnapshot, systemPrompt: 'system', userText: 'user', maxTokens: 100, signal: signal() };
    expect((await adapter.complete(request)).text).toBe(claimReply);
    await expect(adapter.complete(request)).rejects.toThrow('fixture exhausted');
    await expect(extractSource({ sourceId: 's1', question: 'Q', angles, discoveries, passages,
      completeness: 'complete', modelSnapshot, budget: meter(), signal: signal(),
      permits: new ModelPermitPool(2), adapter: { currentRevision: () => 7, complete: adapter.complete } }))
      .rejects.toThrow('fixture exhausted');
  });

  it('resolves an explicit fixture passage selector to the passage ID sent to the model', async () => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), 'kydog-web-research-'));
    const fixturePath = path.join(fixtureDir, 'passage-reply.json');
    writeFileSync(fixturePath, JSON.stringify([{ text: '{"passageId":"{{passageId:HTTPS}}"}', stopReason: 'stop' }]));
    process.env.KYDOG_E2E = '1';
    process.env.KYDOG_WEB_RESEARCH_FIXTURE = fixturePath;
    const adapter = createResearchModelAdapter();
    const request = { modelSnapshot, systemPrompt: 'system',
      userText: JSON.stringify({ passages: [{ passageId: 's1:p1', text: '新版要求 HTTPS。' }] }),
      maxTokens: 100, signal: signal() };
    expect((await adapter.complete(request)).text).toBe('{"passageId":"s1:p1"}');
  });
});
