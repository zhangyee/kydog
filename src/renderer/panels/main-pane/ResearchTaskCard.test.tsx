import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET, type WebResearchTaskSnapshot } from '../../../shared/webResearchTask';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});
vi.mock('../../stores/webResearchTaskStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/webResearchTaskStore')>();
  const real = mod.useWebResearchTaskStore;
  const hook = ((selector: (s: ReturnType<typeof real.getState>) => unknown) =>
    selector(real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useWebResearchTaskStore: hook };
});

const { ResearchTaskCard } = await import('./ResearchTaskCard');
const { FileCard } = await import('./FileCard');
const { useWebResearchTaskStore } = await import('../../stores/webResearchTaskStore');
const snapshot: WebResearchTaskSnapshot = { researchRunId: 'task-1', threadId: 'thread-1',
  originalQuestion: '新版架构是什么？', revision: 4, status: 'running', createdAt: '', updatedAt: '',
  budget: { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET },
  usage: { candidates: 300, fetchesDispatched: 100, receivedBytes: 1000, modelCalls: 10 },
  counts: { discoveries: 1000, sources: 300, queued: 200, fetching: 0, extracting: 0,
    completed: 95, failed: 5, cancelled: 0, unprocessed: 0, processed: 100,
    evidenceReady: 80, irrelevant: 15, claims: 12, evidence: 15 },
  sites: [
    { domain: 'docs.example', sourceCount: 2, processed: 2,
      iconAvailable: true },
    { domain: 'other.example', sourceCount: 1, processed: 0, iconAvailable: false },
  ] };
const invoke = vi.fn<(method: string, args?: any) => Promise<any>>(async (method: string) =>
  method === 'webResearch.taskSiteIcon'
    ? { domain: 'docs.example', dataUrl: 'data:image/png;base64,aWNvbg==' }
    : snapshot);
function visibleText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join('');
  return visibleText((node as { props?: { children?: unknown } }).props?.children);
}

describe('ResearchTaskCard', () => {
  beforeEach(() => {
    useWebResearchTaskStore.setState(useWebResearchTaskStore.getInitialState());
    invoke.mockClear();
    (globalThis as unknown as { window: unknown }).window = { kydog: { invoke } };
  });

  it('reloads the exact task snapshot and shows source failures without marking the whole task failed', async () => {
    const mounted = mount(ResearchTaskCard, { threadId: 'thread-1', researchRunId: 'task-1' });
    await mounted.settle();
    mounted.rerender({ threadId: 'thread-1', researchRunId: 'task-1' });
    await mounted.settle();
    mounted.rerender({ threadId: 'thread-1', researchRunId: 'task-1' });
    expect(invoke).toHaveBeenCalledWith('webResearch.taskGet',
      { threadId: 'thread-1', researchRunId: 'task-1' });
    expect(mounted.find('research-task-card').props['data-status']).toBe('running');
    expect(visibleText(mounted.find('research-task-counts'))).toContain('失败 5');
    expect(visibleText(mounted.find('research-task-counts'))).toContain('发现 1000');
    expect(visibleText(mounted.find('research-task-progress')))
      .toContain('已处理 100/300 个已入队来源；有证据 80，无相关主张 15，失败 5');
    expect(mounted.find('research-site-icon').props.src).toBe('data:image/png;base64,aWNvbg==');
    expect(visibleText(mounted.find('research-site-domain'))).toContain('other.example');
    expect(invoke).toHaveBeenCalledWith('webResearch.taskSiteIcon',
      { threadId: 'thread-1', researchRunId: 'task-1', domain: 'docs.example' });
  });

  it('keeps a completed task card free of an embedded report file card', async () => {
    const completed = { ...snapshot, status: 'completed' as const, reportPath: '/project/report.md' };
    invoke.mockResolvedValueOnce(completed);
    const mounted = mount(ResearchTaskCard, { threadId: 'thread-1', researchRunId: 'task-1' });
    await mounted.settle();
    mounted.rerender({ threadId: 'thread-1', researchRunId: 'task-1' });
    expect(mounted.find('research-task-card').props['data-status']).toBe('completed');
    const isFileCard = (el: { type: unknown }) => el.type === FileCard;
    // Prove this traversal finds a FileCard before asserting the task card contains none.
    expect(findAllWhere({ $$typeof: Symbol.for('react.element'), type: 'div', key: null,
      props: { children: { $$typeof: Symbol.for('react.element'), type: FileCard, key: null,
        props: { path: '/project/report.md' } } } }, isFileCard)).toHaveLength(1);
    expect(findAllWhere(mounted.tree, isFileCard)).toHaveLength(0);
  });

  it('keeps the newest detail view when an older request resolves last', async () => {
    let resolveSources!: (value: unknown) => void;
    let resolveClaims!: (value: unknown) => void;
    const sources = new Promise((resolve) => { resolveSources = resolve; });
    const claims = new Promise((resolve) => { resolveClaims = resolve; });
    invoke.mockImplementation(async (method: string, args?: any) => {
      if (method === 'webResearch.taskGet') return snapshot;
      if (method === 'webResearch.taskSiteIcon') return { domain: args.domain };
      if (method === 'webResearch.taskInspect' && args.view === 'sources') return sources;
      if (method === 'webResearch.taskInspect' && args.view === 'claims') return claims;
      throw new Error(`unexpected ${method}`);
    });
    const mounted = mount(ResearchTaskCard, { threadId: 'thread-1', researchRunId: 'task-1' });
    await mounted.settle();
    mounted.rerender({ threadId: 'thread-1', researchRunId: 'task-1' });
    mounted.find('research-task-toggle').props.onClick();
    mounted.find('research-task-claims').props.onClick();
    resolveClaims({ snapshot, items: [{ claimId: 'claim-new', statement: 'newest claim' }] });
    await vi.waitFor(() => expect(visibleText(mounted.find('research-task-items'))).toContain('newest claim'));
    resolveSources({ snapshot, items: [{ sourceId: 'source-old', status: 'failed', requestedUrl: 'old source' }] });
    await Promise.resolve();
    expect(visibleText(mounted.find('research-task-items'))).toContain('newest claim');
    expect(visibleText(mounted.find('research-task-items'))).not.toContain('old source');
  });
});
