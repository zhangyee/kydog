import { describe, expect, it } from 'vitest';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET, type WebResearchTaskSnapshot } from '../../shared/webResearchTask';
import { useWebResearchTaskStore } from './webResearchTaskStore';

const snapshot: WebResearchTaskSnapshot = { researchRunId: 'task-1', threadId: 'thread-1',
  originalQuestion: 'Q', revision: 2, status: 'running', createdAt: '', updatedAt: '',
  budget: { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET },
  usage: { candidates: 1, fetchesDispatched: 1, receivedBytes: 10, modelCalls: 1 },
  counts: { discoveries: 1, sources: 1, queued: 0, fetching: 0, extracting: 1,
    completed: 0, failed: 0, cancelled: 0, unprocessed: 0, processed: 0,
    evidenceReady: 0, irrelevant: 0, claims: 0, evidence: 0 },
  sites: [{ domain: 'docs.example', sourceCount: 1, processed: 0, iconAvailable: false }] };

describe('webResearchTaskStore', () => {
  it('ignores an older snapshot arriving after a live revision', () => {
    useWebResearchTaskStore.getState().upsert(snapshot);
    useWebResearchTaskStore.getState().upsert({ ...snapshot, revision: 1,
      status: 'paused', counts: { ...snapshot.counts, extracting: 0, queued: 1 } });
    expect(useWebResearchTaskStore.getState().snapshots['task-1']).toMatchObject({
      revision: 2, status: 'running', counts: { extracting: 1 },
    });
  });
});
