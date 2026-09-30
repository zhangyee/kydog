import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from './taskStore';
import { makeSearchObservation } from './searchObservation';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('TaskStore search observations', () => {
  it('normalizes observations saved before search execution facts existed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-task-store-'));
    roots.push(root);
    const threadId = randomUUID();
    const observationId = randomUUID();
    const dir = path.join(root, threadId, 'observations');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${observationId}.json`), JSON.stringify({
      observationId, threadId, tabId: 'tab', engineId: 'bing', attemptId: randomUUID(),
      query: 'architecture', searchPageUrl: 'https://www.bing.com/search?q=architecture',
      angleIds: ['a'], status: 'results', createdAt: new Date().toISOString(),
      rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
      rows: [{ rawHref: 'https://docs.example/guide', targetUrl: 'https://docs.example/guide' }],
    }));

    const observation = await new TaskStore(root).loadObservation(threadId, observationId);
    expect(observation).toMatchObject({
      executionPath: 'status_only', inputSubmitted: false, navigationConfirmed: false,
      resultsExtracted: false, executionFacts: {
        startUrl: 'https://www.bing.com/search?q=architecture',
        endUrl: 'https://www.bing.com/search?q=architecture', successfulWaits: [],
      },
    });
  });

  it('locks selected observations and rejects later target confirmation with the owning run id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-task-store-'));
    roots.push(root);
    const threadId = randomUUID();
    const observation = makeSearchObservation({
      threadId, tabId: 'tab', engineId: 'bing', query: 'architecture', angleIds: ['a'],
      searchPageUrl: 'https://www.bing.com/search?q=architecture', executionPath: 'search_url',
      inputSubmitted: true, navigationConfirmed: true, resultsExtracted: true,
      executionFacts: { startUrl: 'https://www.bing.com/search?q=architecture',
        endUrl: 'https://www.bing.com/search?q=architecture', successfulWaits: [] },
      rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
      rows: [{ title: 'Tracked', url: 'https://www.bing.com/ck/a?id=1' }],
    });
    const store = new TaskStore(root);
    await store.saveObservation(observation);
    const researchRunId = randomUUID();
    const locked = await store.lockObservationsForSubmit(threadId, researchRunId,
      [{ observationId: observation.observationId, resultIndexes: [0] }]);
    expect(locked[0].submittedToResearch?.researchRunId).toBe(researchRunId);
    await expect(store.confirmObservationTarget(threadId, observation.observationId, 0,
      'https://www.bing.com/ck/a?id=1', 'https://docs.example/final'))
      .rejects.toMatchObject({ code: 'research.observation_already_submitted' });
    await expect(store.confirmObservationTarget(threadId, observation.observationId, 0,
      'https://www.bing.com/ck/a?id=1', 'https://docs.example/final'))
      .rejects.toThrow(researchRunId);
    await expect(store.loadObservationTarget(threadId, observation.observationId, 0))
      .rejects.toMatchObject({ code: 'research.observation_already_submitted' });
  });

  it('locks a rowless status-only observation so its engine outcome can join the task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-task-store-'));
    roots.push(root);
    const threadId = randomUUID();
    const observation = makeSearchObservation({
      threadId, tabId: 'tab', engineId: 'google', query: 'architecture', angleIds: ['a'],
      searchPageUrl: 'https://www.google.com/sorry/index', executionPath: 'status_only',
      inputSubmitted: false, navigationConfirmed: false, resultsExtracted: false, status: 'blocked',
      executionFacts: { startUrl: 'https://www.google.com/sorry/index',
        endUrl: 'https://www.google.com/sorry/index', successfulWaits: [] },
      rowTruncation: { truncated: false, returned: 0, totalKnown: 0 }, rows: [],
    });
    const store = new TaskStore(root);
    await store.saveObservation(observation);
    const researchRunId = randomUUID();
    const locked = await store.lockObservationsForSubmit(threadId, researchRunId,
      [{ observationId: observation.observationId, resultIndexes: [] }]);
    expect(locked[0]).toMatchObject({
      status: 'blocked', submittedToResearch: { researchRunId },
    });
  });

  it('serializes a locked submit ahead of a competing confirmation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-task-store-'));
    roots.push(root);
    const threadId = randomUUID();
    const observation = makeSearchObservation({
      threadId, tabId: 'tab', engineId: 'bing', query: 'architecture', angleIds: ['a'],
      searchPageUrl: 'https://www.bing.com/search?q=architecture', executionPath: 'search_url',
      inputSubmitted: true, navigationConfirmed: true, resultsExtracted: true,
      executionFacts: { startUrl: 'https://www.bing.com/search?q=architecture',
        endUrl: 'https://www.bing.com/search?q=architecture', successfulWaits: [] },
      rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
      rows: [{ title: 'Tracked', url: 'https://www.bing.com/ck/a?id=1' }],
    });
    const store = new TaskStore(root);
    await store.saveObservation(observation);
    const originalLoad = store.loadObservation.bind(store);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    vi.spyOn(store, 'loadObservation').mockImplementation(async (...args) => {
      if (first) { first = false; entered(); await gate; }
      return originalLoad(...args);
    });
    const researchRunId = randomUUID();
    const locking = store.lockObservationsForSubmit(threadId, researchRunId,
      [{ observationId: observation.observationId, resultIndexes: [0] }]);
    await started;
    const confirming = store.confirmObservationTarget(threadId, observation.observationId, 0,
      'https://www.bing.com/ck/a?id=1', 'https://docs.example/final');
    release();
    await locking;
    await expect(confirming).rejects.toMatchObject({ code: 'research.observation_already_submitted' });
  });
});
