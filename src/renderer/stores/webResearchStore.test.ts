import { beforeEach, describe, expect, it } from 'vitest';
import { applyRunEvent } from '../runEvents';
import { useWebResearchStore } from './webResearchStore';
import { DEFAULT_RESEARCH_BUDGET } from '../../shared/webResearch';

const threadId = 'thread-1';
const runId = 'agent-run-1';
const researchRunId = 'research-run-1';
const messageId = 'message-1';
const toolCallId = 'tool-1';
const base = { threadId, runId, messageId, toolCallId, researchRunId,
  taskId: 'source-1', stage: 'fetch' as const, budget: { ...DEFAULT_RESEARCH_BUDGET },
  usage: { candidates: 1, fetchesDispatched: 1, receivedBytes: 0, modelCalls: 0 } };
const progress = (status: 'queued' | 'fetching' | 'extracting' | 'completed' | 'failed' | 'cancelled' | 'interrupted') =>
  ({ topic: 'run.research_progress' as const, payload: { ...base, status } });

describe('webResearchStore event projection', () => {
  beforeEach(() => useWebResearchStore.setState({ runs: {} }));

  it('tracks task status and exact budget usage before the tool result arrives', () => {
    applyRunEvent({ topic: 'run.started', payload: { threadId, runId } });
    applyRunEvent(progress('queued'));
    applyRunEvent(progress('fetching'));
    const snapshot = useWebResearchStore.getState().runs[researchRunId];
    expect(snapshot.taskById['source-1'].status).toBe('fetching');
    expect(snapshot.usage.fetchesDispatched).toBe(1);
    expect(snapshot.toolCallId).toBe(toolCallId);
    applyRunEvent(progress('completed'));
    expect(useWebResearchStore.getState().runs[researchRunId].completed).toBe(1);
  });

  it('clears this run on resync and reconstructs completion from journal replay', () => {
    applyRunEvent(progress('completed'));
    expect(useWebResearchStore.getState().runs[researchRunId].completed).toBe(1);
    applyRunEvent({ topic: 'run.resync', payload: { threadId, runId } });
    expect(useWebResearchStore.getState().runs[researchRunId]).toBeUndefined();
    applyRunEvent(progress('queued'));
    applyRunEvent(progress('completed'));
    expect(useWebResearchStore.getState().runs[researchRunId].completed).toBe(1);
    expect(useWebResearchStore.getState().runs[researchRunId].usage.fetchesDispatched).toBe(1);
  });

  it('keeps a terminal cancellation when a stale in-flight event arrives later', () => {
    applyRunEvent(progress('fetching'));
    applyRunEvent(progress('cancelled'));
    expect(useWebResearchStore.getState().runs[researchRunId].taskById['source-1'].status).toBe('cancelled');
    applyRunEvent(progress('fetching'));
    expect(useWebResearchStore.getState().runs[researchRunId].taskById['source-1'].status).toBe('cancelled');
  });

  it('shows a new collection attempt instead of pinning the prior terminal state', () => {
    applyRunEvent(progress('completed'));
    expect(useWebResearchStore.getState().runs[researchRunId].taskById['source-1'].status).toBe('completed');
    const next = { ...progress('queued'), payload: { ...base, runId: 'agent-run-2',
      toolCallId: 'tool-2', status: 'queued' as const } };
    applyRunEvent({ topic: 'run.started', payload: { threadId, runId: 'agent-run-2' } });
    applyRunEvent(next);
    expect(useWebResearchStore.getState().runs[researchRunId].taskById['source-1'].status).toBe('queued');
  });
});
