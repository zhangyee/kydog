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
const { useUiStore } = await import('../../stores/uiStore');
const { useBrowserStore } = await import('../browser/browserStore');
const { useConfirmStore } = await import('../../stores/confirmStore');
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
    invoke.mockReset();
    invoke.mockImplementation(async (method: string) => method === 'webResearch.taskSiteIcon'
      ? { domain: 'docs.example', dataUrl: 'data:image/png;base64,aWNvbg==' } : snapshot);
    useUiStore.setState({ browserOpen: false });
    useBrowserStore.setState(useBrowserStore.getInitialState());
    useConfirmStore.setState({ request: null });
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
    expect(visibleText(mounted.find('research-task-counts'))).toContain('浏览器排队 0 · 浏览器读取 0 · 待处理 0');
    expect(visibleText(mounted.tree)).toContain('浏览器文档字节 0/1073741824');
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

  it.each([
    [{ queued: 0, fetching: 0, extracting: 0, browser_queued: 0, browser_reading: 0, waiting_user: 2 }, '待用户处理'],
    [{ queued: 0, fetching: 0, extracting: 0, browser_queued: 1, browser_reading: 3, waiting_user: 2 }, '进行中 · 待处理 2'],
  ])('uses authoritative waiting counts and Chinese browser phases: %s', async (counts, title) => {
    const value = { ...snapshot, browserDomBytes: 456, counts: { ...snapshot.counts, ...counts } };
    installRecovery(value);
    const mounted = await ready();
    expect(visibleText(mounted.find('research-task-toggle'))).toContain(title);
    expect(visibleText(mounted.tree)).toContain('浏览器排队 ' + counts.browser_queued);
    expect(visibleText(mounted.tree)).toContain('浏览器读取 ' + counts.browser_reading);
    expect(visibleText(mounted.tree)).toContain('待处理 2');
    expect(visibleText(mounted.tree)).toContain('失败 5');
    expect(visibleText(mounted.tree)).toContain('读取派发（含浏览器打开） 100/300');
    expect(visibleText(mounted.tree)).toContain('浏览器文档字节 456/1073741824');
  });

  it.each([
    ['browser.too_many_tabs', '浏览器标签已满，请关闭不需要的标签后继续'],
    ['browser.not_dispatchable', '浏览器页面暂不可用，可重新打开后继续'],
    ['browser.page_no_result', '浏览器页面求值暂未返回，可继续读取'],
  ])('keeps recovery actions available for native reason %s', async (reason, message) => {
    installRecovery(snapshot, undefined, [{ ...source('source-a', 'attempt-a'), reason }]);
    const mounted = await ready();
    mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    expect(mounted.find('research-source-open-source-a').props.disabled).toBe(false);
    expect(mounted.find('research-source-retry-source-a').props.disabled).toBe(false);
    expect(visibleText(mounted.find('research-task-items'))).toContain(message);
    mounted.find('research-source-retry-source-a').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskRetrySource', {
      threadId: 'thread-1', researchRunId: 'task-1', sourceId: 'source-a', expectedAttemptId: 'attempt-a',
    });
  });

  it('opens the panel once through the source RPC, keeps waiting, then retries the returned version', async () => {
    installRecovery(snapshot);
    const mounted = await ready();
    mounted.find('research-task-toggle').props.onClick();
    await mounted.settle();
    // The real browser mirror accepts broadcasts; source actions must not guess an active tab.
    useBrowserStore.getState().applyTabs({ revision: 10, tabs: [], activeTabId: 'broadcast-tab' });
    expect(useBrowserStore.getState().activeTabId).toBe('broadcast-tab');
    const toggle = vi.spyOn(useUiStore.getState(), 'toggleBrowser');
    const open = deferred();
    invoke.mockImplementationOnce(() => open.promise);
    const button = mounted.find('research-source-open-source-a');
    button.props.onClick(); button.props.onClick();
    expect(mounted.find('research-source-open-source-a').props.disabled).toBe(true);
    expect(invoke.mock.calls.filter(([method]) => method === 'webResearch.taskOpenSource')).toHaveLength(1);
    open.resolve({ tabId: 'actual-main-tab', expectedAttemptId: 'attempt-new', snapshot });
    await mounted.settle();
    expect(useUiStore.getState().browserOpen).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(useBrowserStore.getState().activeTabId).toBe('broadcast-tab');
    expect(visibleText(mounted.find('research-task-items'))).toContain('待用户处理');
    mounted.find('research-source-retry-source-a').props.onClick();
    await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskRetrySource', {
      threadId: 'thread-1', researchRunId: 'task-1', sourceId: 'source-a', expectedAttemptId: 'attempt-new',
    });
    mounted.find('research-source-open-source-a').props.onClick();
    await mounted.settle();
    expect(toggle).toHaveBeenCalledTimes(1);
    // Exact allowlist: no navigation, activation or renderer-created tab RPCs.
    expect([...new Set(invoke.mock.calls.map(([method]) => method))].sort()).toEqual([
      'webResearch.taskGet', 'webResearch.taskInspect', 'webResearch.taskOpenSource',
      'webResearch.taskRetrySource', 'webResearch.taskSiteIcon',
    ]);
    toggle.mockRestore();
  });

  it('routes pause/resume/cancel and confirms cancellation, including declined cancellation', async () => {
    let current = snapshot;
    installRecovery(snapshot, (method, args) => {
      if (method !== 'webResearch.taskControl') return;
      current = { ...current, revision: current.revision + 1,
        status: args.action === 'pause' ? 'paused' : args.action === 'resume' ? 'running' : 'cancelled',
        statusReason: args.action === 'pause' ? 'paused_by_user' : undefined };
      return current;
    });
    const mounted = await ready();
    mounted.find('research-task-pause').props.onClick(); await mounted.settle();
    mounted.rerender(props);
    expect(visibleText(mounted.tree)).toContain('用户已暂停');
    expect(invoke).toHaveBeenCalledWith('webResearch.taskControl', { ...props, action: 'pause' });
    mounted.find('research-task-resume').props.onClick(); await mounted.settle(); mounted.rerender(props);
    expect(invoke).toHaveBeenCalledWith('webResearch.taskControl', { ...props, action: 'resume' });
    mounted.find('research-task-cancel').props.onClick();
    expect(useConfirmStore.getState().request?.confirmLabel).toBe('取消研究');
    useConfirmStore.getState().resolve(true); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskControl', { ...props, action: 'cancel' });
    const cancelledCalls = invoke.mock.calls.filter(([m, a]) => m === 'webResearch.taskControl' && a.action === 'cancel').length;
    useWebResearchTaskStore.getState().upsert({ ...snapshot, revision: current.revision + 1 }); mounted.rerender(props);
    mounted.find('research-task-cancel').props.onClick(); useConfirmStore.getState().resolve(false);
    await mounted.settle();
    expect(invoke.mock.calls.filter(([m, a]) => m === 'webResearch.taskControl' && a.action === 'cancel')).toHaveLength(cancelledCalls);
  });

  it('disables paused retry without secretly resuming, while keeping missing-tab sources openable', async () => {
    let current = snapshot;
    installRecovery(snapshot);
    const mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    mounted.find('research-source-retry-source-a').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskRetrySource', { ...props, sourceId: 'source-a', expectedAttemptId: 'attempt-a' });
    current = { ...snapshot, revision: 8, status: 'paused', statusReason: 'browser_total_dom_limit' };
    installRecovery(current);
    useWebResearchTaskStore.getState().upsert(current); mounted.rerender(props); await mounted.settle();
    expect(visibleText(mounted.tree)).toContain('浏览器文档总字节预算不足');
    expect(mounted.find('research-source-open-source-a').props.disabled).toBe(false);
    expect(mounted.find('research-source-retry-source-a').props.disabled).toBe(true);
    const before = invoke.mock.calls.length;
    mounted.find('research-source-retry-source-a').props.onClick(); await mounted.settle();
    expect(invoke.mock.calls.slice(before)).toEqual([]);
    mounted.find('research-source-open-source-a').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskOpenSource', { ...props, sourceId: 'source-a' });
  });

  it('keeps source action versions scoped when an old response arrives', async () => {
    const a = deferred(); const b = deferred();
    installRecovery(snapshot, (method, args) => {
      if (method === 'webResearch.taskOpenSource') return args.sourceId === 'source-a' ? a.promise : b.promise;
    }, [source('source-a', 'attempt-a'), source('source-b', 'attempt-b')]);
    const mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('https://source-a.example/article');
    mounted.find('research-source-open-source-a').props.onClick();
    mounted.find('research-source-open-source-b').props.onClick();
    b.resolve({ tabId: 'b', expectedAttemptId: 'attempt-b-new', snapshot }); await mounted.settle();
    mounted.find('research-source-retry-source-b').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskRetrySource', { ...props, sourceId: 'source-b', expectedAttemptId: 'attempt-b-new' });
    a.resolve({ tabId: 'a', expectedAttemptId: 'attempt-a-late', snapshot }); await mounted.settle();
    mounted.find('research-source-retry-source-b').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenLastCalledWith('webResearch.taskRetrySource', { ...props, sourceId: 'source-b', expectedAttemptId: 'attempt-b-new' });
    const late = deferred();
    invoke.mockImplementationOnce(() => late.promise);
    mounted.find('research-source-open-source-a').props.onClick();
    mounted.find('research-task-claims').props.onClick(); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('current claim');
    late.resolve({ tabId: 'a', expectedAttemptId: 'attempt-a-late', snapshot }); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('current claim');
    expect(visibleText(mounted.find('research-task-items'))).not.toContain('https://source-a.example/article');
  });

  it('refreshes current source details on newer snapshots and rejects a stale inspect receipt', async () => {
    let rows = [source('source-a', 'attempt-a')];
    let current = snapshot;
    const old = deferred(); let delayed = false;
    installRecovery(snapshot, (method, args) => {
      if (method === 'webResearch.taskInspect' && args.view === 'sources') {
        if (delayed) { delayed = false; return old.promise; }
        return { snapshot: current, items: rows };
      }
    });
    const mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    mounted.find('research-source-retry-source-a').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskRetrySource', { ...props, sourceId: 'source-a', expectedAttemptId: 'attempt-a' });
    delayed = true; mounted.find('research-task-sources').props.onClick();
    current = { ...snapshot, revision: 9 }; rows = [source('source-a', 'attempt-live', 'tab-live')];
    useWebResearchTaskStore.getState().upsert(current); mounted.rerender(props); await mounted.settle();
    old.resolve({ snapshot, items: [source('source-a', 'attempt-stale')] }); await mounted.settle();
    mounted.find('research-source-retry-source-a').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenLastCalledWith('webResearch.taskRetrySource', { ...props, sourceId: 'source-a', expectedAttemptId: 'attempt-live' });
  });

  it('restores task and inspect after renderer reload and opens the same main-process source key', async () => {
    installRecovery(snapshot, undefined, [source('source-a', null, 'still-live')]);
    let mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('https://source-a.example/article');
    mounted.unmount(); useWebResearchTaskStore.setState(useWebResearchTaskStore.getInitialState());
    mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    mounted.find('research-source-open-source-a').props.onClick(); await mounted.settle();
    expect(invoke.mock.calls.filter(([m]) => m === 'webResearch.taskGet')).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith('webResearch.taskOpenSource', { ...props, sourceId: 'source-a' });
  });

  it.each([
    ['browser_total_dom_limit', '浏览器文档总字节预算不足'],
    ['browser_source_dom_limit', '来源浏览器文档字节预算不足'],
    ['total_byte_limit', '总字节预算不足'],
    ['source_byte_limit', '来源字节预算不足'],
    ['http_403', '页面拒绝访问（HTTP 403）'],
    ['navigation_timeout', '来源导航超时'],
  ])('uses the actual persisted reason %s', async (reason, text) => {
    installRecovery({ ...snapshot, status: 'paused', statusReason: reason });
    const mounted = await ready();
    expect(visibleText(mounted.tree)).toContain(text);
  });

  it('keeps timeout distinct from an observed verification widget', async () => {
    let rows = [{ ...source('source-a', 'attempt-a'), reason: 'verification_widget' }];
    installRecovery(snapshot, (method, args) => method === 'webResearch.taskInspect' && args.view === 'sources'
      ? { snapshot, items: rows } : undefined);
    const mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('页面需要验证');
    rows = [source('source-a', 'attempt-a')];
    mounted.find('research-task-sources').props.onClick(); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('浏览器读取超时，尚未取得正文');
    expect(visibleText(mounted.find('research-task-items'))).not.toContain('页面需要验证');
  });

  it.each([
    { threadId: 'thread-2', researchRunId: 'task-1' },
    { threadId: 'thread-1', researchRunId: 'task-2' },
  ])('drops old open receipts after changing task ownership to %s', async (nextProps) => {
    const old = deferred();
    installRecovery(snapshot, (method, args) => method === 'webResearch.taskOpenSource' && args.sourceId === 'source-a'
      ? old.promise : undefined);
    const mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('https://source-a.example/article');
    mounted.find('research-source-open-source-a').props.onClick();
    const next = { ...snapshot, ...nextProps, revision: 12 };
    installRecovery(next, undefined, [source('source-b', 'attempt-b')]);
    mounted.rerender(nextProps); await mounted.settle(); mounted.rerender(nextProps);
    mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('https://source-b.example/article');
    mounted.find('research-source-open-source-b').props.onClick(); await mounted.settle();
    expect(useUiStore.getState().browserOpen).toBe(true);
    useUiStore.setState({ browserOpen: false });
    old.resolve({ tabId: 'old-tab', expectedAttemptId: 'attempt-wrong', snapshot }); await mounted.settle();
    expect(useUiStore.getState().browserOpen).toBe(false);
    expect(visibleText(mounted.find('research-task-items'))).toContain('https://source-b.example/article');
    expect(visibleText(mounted.find('research-task-items'))).not.toContain('https://source-a.example/article');
    mounted.find('research-source-retry-source-b').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskRetrySource', { ...nextProps,
      sourceId: 'source-b', expectedAttemptId: 'attempt-new' });
  });

  it('locks retry until its response and supports the explicit null attempt version', async () => {
    const pending = deferred();
    installRecovery(snapshot, (method) => method === 'webResearch.taskRetrySource' ? pending.promise : undefined,
      [source('source-a', null)]);
    const mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    const button = mounted.find('research-source-retry-source-a');
    button.props.onClick(); button.props.onClick();
    expect(invoke.mock.calls.filter(([m]) => m === 'webResearch.taskRetrySource')).toEqual([
      ['webResearch.taskRetrySource', { ...props, sourceId: 'source-a', expectedAttemptId: null }],
    ]);
    expect(mounted.find('research-source-retry-source-a').props.disabled).toBe(true);
    pending.resolve(snapshot); await mounted.settle();
    expect(mounted.find('research-source-retry-source-a').props.disabled).toBe(false);
  });

  it('still opens the panel when taskUpdated refreshes sources before the open receipt', async () => {
    const pending = deferred();
    let current = snapshot;
    installRecovery(snapshot, (method, args) => {
      if (method === 'webResearch.taskOpenSource') return pending.promise;
      if (method === 'webResearch.taskInspect' && args.view === 'sources') return { snapshot: current,
        items: [source('source-a', current.revision === 4 ? 'attempt-a' : 'attempt-live')] };
    });
    const mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    mounted.find('research-source-open-source-a').props.onClick();
    current = { ...snapshot, revision: 8 };
    useWebResearchTaskStore.getState().upsert(current); mounted.rerender(props); await mounted.settle();
    pending.resolve({ tabId: 'actual-main-tab', expectedAttemptId: 'attempt-live', snapshot: current });
    await mounted.settle();
    expect(useUiStore.getState().browserOpen).toBe(true);
    mounted.find('research-source-retry-source-a').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskRetrySource', { ...props,
      sourceId: 'source-a', expectedAttemptId: 'attempt-live' });
  });

  it('keeps the newer inspect version when an older open response arrives', async () => {
    const pending = deferred(); let current = snapshot;
    installRecovery(snapshot, (method, args) => {
      if (method === 'webResearch.taskOpenSource') return pending.promise;
      if (method === 'webResearch.taskInspect' && args.view === 'sources') return { snapshot: current,
        items: [source('source-a', current.revision === 4 ? 'attempt-a' : 'attempt-live')] };
    });
    const mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    mounted.find('research-source-retry-source-a').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskRetrySource', { ...props,
      sourceId: 'source-a', expectedAttemptId: 'attempt-a' });
    mounted.find('research-source-open-source-a').props.onClick();
    current = { ...snapshot, revision: 8 }; useWebResearchTaskStore.getState().upsert(current);
    mounted.rerender(props); await mounted.settle();
    pending.resolve({ tabId: 'actual-main-tab', expectedAttemptId: 'attempt-stale', snapshot }); await mounted.settle();
    mounted.find('research-source-retry-source-a').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskRetrySource', { ...props,
      sourceId: 'source-a', expectedAttemptId: 'attempt-live' });
  });

  it('keeps a waiting source openable after its live tab disappears', async () => {
    let current = snapshot;
    let rows = [source('source-a', 'attempt-a', 'live-tab')];
    installRecovery(snapshot, (method, args) => method === 'webResearch.taskInspect' && args.view === 'sources'
      ? { snapshot: current, items: rows } : undefined);
    const mounted = await ready(); mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    expect(mounted.find('research-source-open-source-a').props.disabled).toBe(false);
    rows = [{ ...source('source-a', 'attempt-a'), reason: 'tab_closed' }];
    current = { ...snapshot, revision: 7 };
    useWebResearchTaskStore.getState().upsert(current); mounted.rerender(props); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('来源标签已关闭，可重新打开');
    expect(mounted.find('research-source-open-source-a').props.disabled).toBe(false);
    mounted.find('research-source-open-source-a').props.onClick(); await mounted.settle();
    expect(invoke).toHaveBeenCalledWith('webResearch.taskOpenSource', { ...props, sourceId: 'source-a' });
  });

  it('locks task controls during an RPC and cancellation confirmation', async () => {
    const pending = deferred();
    installRecovery(snapshot, (method) => method === 'webResearch.taskControl' ? pending.promise : undefined);
    const mounted = await ready();
    const pause = mounted.find('research-task-pause'); pause.props.onClick(); pause.props.onClick();
    expect(mounted.find('research-task-cancel').props.disabled).toBe(true);
    expect(invoke.mock.calls.filter(([m]) => m === 'webResearch.taskControl')).toHaveLength(1);
    pending.resolve(snapshot); await mounted.settle();
    const cancel = mounted.find('research-task-cancel'); cancel.props.onClick();
    const requestId = useConfirmStore.getState().request?.id;
    cancel.props.onClick();
    expect(useConfirmStore.getState().request?.id).toBe(requestId);
    expect(mounted.find('research-task-pause').props.disabled).toBe(true);
    useConfirmStore.getState().resolve(false); await mounted.settle();
    expect(mounted.find('research-task-pause').props.disabled).toBe(false);
  });

  it('keeps the newest detail view when an older request resolves last', async () => {
    let resolveSources!: (value: unknown) => void;
    let resolveClaims!: (value: unknown) => void;
    const sources = new Promise((resolve) => { resolveSources = resolve; });
    let pendingSources = false;
    const claims = new Promise((resolve) => { resolveClaims = resolve; });
    invoke.mockImplementation(async (method: string, args?: any) => {
      if (method === 'webResearch.taskGet') return snapshot;
      if (method === 'webResearch.taskSiteIcon') return { domain: args.domain };
      if (method === 'webResearch.taskInspect' && args.view === 'sources') return pendingSources ? sources
        : { snapshot, items: [{ sourceId: 'source-old', status: 'failed', requestedUrl: 'old source' }] };
      if (method === 'webResearch.taskInspect' && args.view === 'claims') return claims;
      throw new Error(`unexpected ${method}`);
    });
    const mounted = mount(ResearchTaskCard, { threadId: 'thread-1', researchRunId: 'task-1' });
    await mounted.settle();
    mounted.rerender({ threadId: 'thread-1', researchRunId: 'task-1' });
    mounted.find('research-task-toggle').props.onClick(); await mounted.settle();
    expect(visibleText(mounted.find('research-task-items'))).toContain('old source');
    pendingSources = true;
    mounted.find('research-task-sources').props.onClick();
    mounted.find('research-task-claims').props.onClick();
    resolveClaims({ snapshot, items: [{ claimId: 'claim-new', statement: 'newest claim' }] });
    await vi.waitFor(() => expect(visibleText(mounted.find('research-task-items'))).toContain('newest claim'));
    resolveSources({ snapshot, items: [{ sourceId: 'source-old', status: 'failed', requestedUrl: 'old source' }] });
    await Promise.resolve();
    expect(visibleText(mounted.find('research-task-items'))).toContain('newest claim');
    expect(visibleText(mounted.find('research-task-items'))).not.toContain('old source');
  });
});

const props = { threadId: 'thread-1', researchRunId: 'task-1' };
function source(sourceId: string, expectedAttemptId: string | null, tabId?: string) {
  return { sourceId, requestedUrl: `https://${sourceId}.example/article`, status: 'waiting_user',
    reason: 'browser_read_timeout', discoveryCount: 1, discoveryPreview: [], claimCount: 0,
    evidenceCount: 0, expectedAttemptId, ...(tabId ? { tabId } : {}) };
}
function deferred() {
  let resolve!: (value: any) => void;
  return { promise: new Promise<any>((done) => { resolve = done; }), resolve: (value: any) => resolve(value) };
}
function installRecovery(value: WebResearchTaskSnapshot,
  extra?: (method: string, args: any) => unknown, rows = [source('source-a', 'attempt-a')]) {
  invoke.mockImplementation(async (method, args) => {
    const custom = extra?.(method, args);
    if (custom !== undefined) return custom;
    if (method === 'webResearch.taskSiteIcon') return { domain: args.domain };
    if (method === 'webResearch.taskInspect') return { snapshot: value,
      items: args.view === 'sources' ? rows : [{ claimId: 'claim-b', statement: 'current claim' }] };
    if (method === 'webResearch.taskOpenSource') return { tabId: 'main-tab', expectedAttemptId: 'attempt-new', snapshot: value };
    return value;
  });
}
async function ready() {
  const mounted = mount(ResearchTaskCard, props);
  await mounted.settle(); mounted.rerender(props); await mounted.settle();
  return mounted;
}
