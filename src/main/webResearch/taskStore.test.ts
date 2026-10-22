import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from './taskStore';
import { makeSearchObservation } from './searchObservation';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET, type WebResearchTaskRecord,
  type WebResearchTaskSource } from '../../shared/webResearchTask';

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

describe('TaskStore browser facts compatibility', () => {
  it('round-trips browser attempts separately from HTTP facts and accepts an older source', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-task-store-'));
    roots.push(root);
    const store = new TaskStore(root);
    const task: WebResearchTaskRecord = {
      researchRunId: randomUUID(), threadId: randomUUID(), createdByRunId: randomUUID(), projectRoot: root,
      originalQuestion: 'Question?', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z',
      revision: 1, status: 'running', angles: [], attempts: [], observationIds: [], discoveryCount: 1,
      budget: { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET }, browserDomBytes: 234,
      usage: { candidates: 1, fetchesDispatched: 2, receivedBytes: 13, modelCalls: 0 },
    };
    await store.createTask(task);
    const legacy: WebResearchTaskSource = {
      sourceId: randomUUID(), requestedUrl: 'https://blog.csdn.net/author/article',
      finalUrl: 'https://blog.csdn.net/author/article', createdAt: task.createdAt, updatedAt: task.updatedAt,
      status: 'failed', reason: 'HTTP 521', statusCode: 521, contentType: 'text/html', receivedBytes: 13,
      discoveries: [], passages: [],
    };
    const modern: WebResearchTaskSource = { ...legacy, sourceId: randomUUID(), status: 'waiting_user',
      browserDomBytes: 234, retrieval: { method: 'browser', attemptId: 'attempt-1' },
      browser: { trigger: 'csdn_http_521', automaticAttemptUsed: true, attempts: [{
        attemptId: 'attempt-1', sequence: 1, initiatedBy: 'automatic', phase: 'waiting_user',
        startedAt: task.createdAt, finishedAt: task.updatedAt, requestedUrl: legacy.requestedUrl,
        finalUrl: 'https://blog.csdn.net/author/article?verified=1', navigationMode: 'navigate',
        navigationReserved: true, mainStatusCode: 200, reason: 'browser_read_timeout', domBytes: 234,
        document: { url: 'https://blog.csdn.net/author/article?verified=1', rootRule: '#content_views',
          identity: { documentEpoch: 2, routeRevision: 3, navigationSequence: 4 }, utf8Bytes: 234, mainStatusCode: 200 },
      }] } };
    await store.saveSource(task, modern);
    await store.saveSource(task, legacy);
    const loadedModern = await store.loadSource(task, modern.sourceId);
    expect(loadedModern).toEqual(modern);
    const loadedLegacy = await store.loadSource(task, legacy.sourceId);
    expect(loadedLegacy).toEqual(legacy);
    expect(loadedModern.browser?.attempts[0].mainStatusCode).toBe(200);
    expect(loadedLegacy.browser).toBeUndefined();
    expect(loadedModern).toMatchObject({
      statusCode: 521, receivedBytes: 13, browserDomBytes: 234,
    });
    expect(await store.loadTask(task.threadId, task.researchRunId)).toMatchObject({
      browserDomBytes: 234, usage: { receivedBytes: 13 },
    });
  });
});
