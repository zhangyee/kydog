import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_RESEARCH_BUDGET } from './budget';
import { RunStore, type ResearchRunRecord, type SavedSource } from './runStore';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function setup() {
  root = await mkdtemp(path.join(tmpdir(), 'kydog-research-store-'));
  return new RunStore(root);
}
const makeRun = (threadId: string): ResearchRunRecord => ({
  researchRunId: randomUUID(), threadId, createdByRunId: randomUUID(), continuationRunIds: [],
  originalQuestion: '新版协议？', createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), angles: [{ id: 'a', label: '协议', query: 'v2 protocol' }],
  enabledEngines: ['bing'], attempts: [], candidates: [], budget: { ...DEFAULT_RESEARCH_BUDGET },
  usage: { candidates: 0, fetchesDispatched: 0, receivedBytes: 0, modelCalls: 0 }, sources: [],
});
const makeSource = (sourceId: string): SavedSource => ({
  sourceId, requestedUrl: 'https://docs.example/v2', finalUrl: 'https://docs.example/v2',
  status: 'completed', contentHash: 'abc', completeness: 'complete', discoveries: [],
  passages: [{ sourceId, passageId: `${sourceId}:p1`, ordinal: 1, text: 'private body marker' }],
  extraction: { sourceId, status: 'irrelevant', claims: [], evidence: [], examinedPassageIds: [`${sourceId}:p1`], gaps: [] },
  receivedBytes: 19,
});

describe('RunStore', () => {
  it('writes source body separately and keeps the run index small for 100 sources', async () => {
    const store = await setup();
    const threadId = randomUUID();
    const run = makeRun(threadId);
    await store.createRun(run);
    for (let i = 0; i < 100; i++) await store.saveSource(run, makeSource(randomUUID()));
    const runDir = path.join(root!, threadId, run.researchRunId);
    const index = await readFile(path.join(runDir, 'run.json'), 'utf8');
    expect(index).toContain('completed');
    expect(index).not.toContain('private body marker');
    const files = await readdir(path.join(runDir, 'sources'));
    expect(files).toHaveLength(100);
    if (process.platform !== 'win32') {
      expect((await stat(runDir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(runDir, 'run.json'))).mode & 0o777).toBe(0o600);
    }
    const saved = await store.loadRun(threadId, run.researchRunId);
    expect(saved.sources).toHaveLength(100);
    expect(saved.sources[0].status).toBe('completed');
  });

  it('rejects another thread and deletes only the owning thread directory', async () => {
    const store = await setup();
    const first = makeRun(randomUUID());
    const second = makeRun(randomUUID());
    await store.createRun(first);
    await store.createRun(second);
    expect((await store.loadRun(first.threadId, first.researchRunId)).threadId).toBe(first.threadId);
    await expect(store.loadRun(second.threadId, first.researchRunId))
      .rejects.toMatchObject({ code: 'research.not_found' });
    await store.removeRunsForThread(first.threadId);
    await expect(store.loadRun(first.threadId, first.researchRunId))
      .rejects.toMatchObject({ code: 'research.not_found' });
    expect((await store.loadRun(second.threadId, second.researchRunId)).threadId).toBe(second.threadId);
  });

  it('recovers a nonterminal source and removes an unindexed orphan file after restart', async () => {
    const store = await setup();
    const run = makeRun(randomUUID());
    await store.createRun(run);
    const sourceId = randomUUID();
    run.sources.push({ sourceId, requestedUrl: 'https://docs.example/start', status: 'fetching', discoveries: [] });
    await store.saveRun(run);
    const orphan = path.join(root!, run.threadId, run.researchRunId, 'sources', `${randomUUID()}.json`);
    await writeFile(orphan, '{}');
    const recovered = await (new RunStore(root!)).loadRun(run.threadId, run.researchRunId);
    expect(recovered.sources[0].status).toBe('interrupted');
    expect(await readdir(path.dirname(orphan))).toEqual([]);
  });

  it('retains every source when many completions write the same index concurrently', async () => {
    const store = await setup();
    const run = makeRun(randomUUID());
    await store.createRun(run);
    const sources = Array.from({ length: 24 }, () => makeSource(randomUUID()));
    await Promise.all(sources.map((source) => store.saveSource(run, source)));
    const saved = await (new RunStore(root!)).loadRun(run.threadId, run.researchRunId);
    expect(new Set(saved.sources.map((source) => source.sourceId))).toEqual(
      new Set(sources.map((source) => source.sourceId)));
    expect((await readdir(path.join(root!, run.threadId, run.researchRunId, 'sources')))).toHaveLength(24);
  });
});
