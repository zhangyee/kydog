import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';
import { DEFAULT_RESEARCH_BUDGET, type ResearchRunIndex } from '../../../shared/webResearch';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});
vi.mock('../../stores/webResearchStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/webResearchStore')>();
  const real = mod.useWebResearchStore;
  const hook = ((selector: (s: ReturnType<typeof real.getState>) => unknown) =>
    selector(real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useWebResearchStore: hook };
});

const { WebResearchProgress } = await import('./WebResearchProgress');
const { useWebResearchStore } = await import('../../stores/webResearchStore');
const record: ResearchRunIndex = {
  researchRunId: 'research-a', threadId: 'thread-a', createdByRunId: 'agent-a',
  continuationRunIds: [], originalQuestion: '新版文档是否要求 HTTPS？',
  createdAt: '', updatedAt: '', angles: [], enabledEngines: [], attempts: [], candidates: [],
  budget: { ...DEFAULT_RESEARCH_BUDGET },
  usage: { candidates: 1, fetchesDispatched: 1, receivedBytes: 300, modelCalls: 1 },
  sources: [{ sourceId: 'source-a', requestedUrl: 'https://example.org/start',
    finalUrl: 'https://example.org/final', status: 'completed', discoveries: [], evidenceIds: ['evidence-a'] }],
};
const invoke = vi.fn(async (method: string) => {
  if (method === 'webResearch.list') return [record];
  if (method === 'webResearch.get') return record;
  if (method === 'webResearch.evidence') return { evidenceId: 'evidence-a', sourceId: 'source-a',
    finalUrl: 'https://example.org/final', passageId: 'passage-a', quote: 'HTTPS',
    relation: 'supports', verification: 'grounded', excerpt: 'The source requires HTTPS.', excerptTruncated: false };
  throw new Error(`unexpected ${method}`);
});

function visibleText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join('');
  return visibleText((node as { props?: { children?: unknown } }).props?.children);
}

describe('WebResearchProgress', () => {
  beforeEach(() => {
    useWebResearchStore.setState(useWebResearchStore.getInitialState());
    invoke.mockClear();
    (globalThis as unknown as { window: unknown }).window = { kydog: { invoke } };
  });

  it('shows protocol task states and budgets, then loads one passage only after its evidence ID is clicked', async () => {
    useWebResearchStore.getState().setCurrentRun('thread-a', 'agent-run-a');
    useWebResearchStore.getState().applyProgress({ threadId: 'thread-a', runId: 'agent-run-a',
      messageId: 'message-a', toolCallId: 'tool-a', researchRunId: 'research-a', taskId: 'source-a',
      stage: 'extract', status: 'completed', budget: { ...DEFAULT_RESEARCH_BUDGET }, usage: record.usage });
    const mounted = mount(WebResearchProgress, { threadId: 'thread-a' });
    expect(visibleText(mounted.find('web-research-live'))).toContain('完成 1');
    expect(visibleText(mounted.find('web-research-live'))).toContain('抓取 1/24');
    expect(invoke).not.toHaveBeenCalled();

    mounted.find('web-research-records').props.onClick();
    await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.list', { threadId: 'thread-a' });
    const runButton = findAllWhere(mounted.tree, (el) => el.type === 'button' &&
      visibleText(el).includes(record.originalQuestion))[0];
    runButton.props.onClick();
    await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.get', { threadId: 'thread-a', researchRunId: 'research-a' });
    expect(invoke.mock.calls.some(([method]) => method === 'webResearch.evidence')).toBe(false);

    const evidenceButton = findAllWhere(mounted.tree, (el) => el.type === 'button' &&
      visibleText(el) === 'evidence-a')[0];
    evidenceButton.props.onClick();
    await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.evidence', { threadId: 'thread-a',
      researchRunId: 'research-a', evidenceId: 'evidence-a' });
    expect(visibleText(mounted.find('web-research-evidence'))).toContain('The source requires HTTPS.');
  });
});
