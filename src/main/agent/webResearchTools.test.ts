import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWebResearchTools } from './webResearchTools';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET, type WebResearchTaskSnapshot } from '../../shared/webResearchTask';

const threadId = randomUUID();
const researchRunId = randomUUID();
const snapshot: WebResearchTaskSnapshot = { researchRunId, threadId, originalQuestion: 'Q', revision: 1,
  status: 'running', createdAt: '', updatedAt: '', budget: { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET },
  usage: { candidates: 1, fetchesDispatched: 0, receivedBytes: 0, modelCalls: 0 },
  counts: { discoveries: 1, sources: 1, queued: 1, fetching: 0, extracting: 0, completed: 0,
    failed: 0, cancelled: 0, unprocessed: 0, processed: 0, evidenceReady: 0,
    irrelevant: 0, claims: 0, evidence: 0 }, sites: [] };

function harness() {
  const service = {
    submit: vi.fn(async () => ({ researchRunId, created: true, accepted: 1, duplicates: 0,
      unresolved: 0, rejected: 0, observationResults: [], snapshot })),
    inspect: vi.fn(async () => ({ snapshot, items: [], nextCursor: undefined })),
    whenIdle: vi.fn(async () => {}),
    get: vi.fn(async () => snapshot),
    complete: vi.fn(async () => ({ completed: true as const, reportPath: '/project/report.md',
      snapshot: { ...snapshot, status: 'completed' as const, reportPath: '/project/report.md' } })),
    control: vi.fn(async () => snapshot),
  };
  const tools = createWebResearchTools({ threadId, projectRoot: '/project',
    currentRunId: () => 'run-1', service });
  return { service, tools, tool: tools[0] };
}

describe('web_research_task', () => {
  it('sends an object-rooted parameter schema to OpenAI-compatible providers', () => {
    const { tool } = harness();
    const schema = JSON.parse(JSON.stringify(tool.parameters)) as { type?: string; required?: string[] };
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('action');
  });

  it('exposes one tool and binds submit to the session thread/project', async () => {
    const { service, tools, tool } = harness();
    expect(tools.map((item) => item.name)).toEqual(['web_research_task']);
    const response = await tool.execute('call-1', { action: 'submit', originalQuestion: 'Q',
      angles: [{ id: 'a', label: 'A', query: 'q' }],
      observationSelections: [{ observationId: 'o-1', resultIndexes: [1, 3] }] });
    expect(service.submit).toHaveBeenCalledWith(expect.objectContaining({
      observationSelections: [{ observationId: 'o-1', resultIndexes: [1, 3] }],
    }),
      { threadId, runId: 'run-1', projectRoot: '/project' });
    expect(JSON.stringify(response)).toContain(researchRunId);
    await expect(tool.execute('call-2', { action: 'submit', originalQuestion: 'Q', angles: [],
      threadId: randomUUID() })).rejects.toThrow('threadId');
    expect(service.submit).toHaveBeenCalledTimes(1);
  });

  it('routes inspection and completion through the same owner-scoped task', async () => {
    const { service, tool } = harness();
    await tool.execute('call-1', { action: 'inspect', researchRunId, view: 'claims', pageSize: 20 });
    expect(service.inspect).toHaveBeenCalledWith(threadId, researchRunId,
      expect.objectContaining({ view: 'claims', pageSize: 20 }));
    await tool.execute('call-2', { action: 'complete', researchRunId, reportMarkdown: '# Report',
      fileName: 'topic' });
    expect(service.complete).toHaveBeenCalledWith(threadId, researchRunId, '# Report', 'topic', undefined);
  });

  it('waits for the submitted batch instead of polling inspect, then returns its snapshot', async () => {
    const { service, tool } = harness();
    let finish!: () => void;
    service.whenIdle.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = tool.execute('call-1', { action: 'wait', researchRunId });
    await Promise.resolve();
    expect(service.whenIdle).toHaveBeenCalledWith(threadId, researchRunId);
    expect(service.get).not.toHaveBeenCalled();
    expect(service.inspect).not.toHaveBeenCalled();
    finish();
    const response = await pending;
    expect(service.get).toHaveBeenCalledWith(threadId, researchRunId);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ action: 'wait', snapshot });
  });

  it('stops waiting when the agent turn is aborted without cancelling background work', async () => {
    const { service, tool } = harness();
    let finish!: () => void;
    service.whenIdle.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = tool.execute('call-1', { action: 'wait', researchRunId }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(service.get).not.toHaveBeenCalled();
    finish();
  });
});
