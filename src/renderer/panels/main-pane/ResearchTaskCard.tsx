import { useEffect, useMemo, useRef, useState } from 'react';
import type { WebResearchTaskSnapshot } from '../../../shared/webResearchTask';
import { useWebResearchTaskStore } from '../../stores/webResearchTaskStore';
import { useUiStore } from '../../stores/uiStore';
import { confirm } from '../../stores/confirmStore';

type View = 'sources' | 'claims';
const SOURCE_LABELS: Record<string, string> = { queued: '排队中', fetching: '抓取中',
  extracting: '抽取中', completed: '已完成', failed: '失败', cancelled: '已取消',
  unprocessed: '未处理', browser_queued: '浏览器排队', browser_reading: '浏览器读取', waiting_user: '待用户处理' };
const REASONS: Record<string, string> = {
  browser_read_timeout: '浏览器读取超时，尚未取得正文', verification_widget: '页面需要验证',
  verification_required: '页面需要验证', grounded_barrier: '页面存在已确认的访问障碍',
  browser_unavailable: '浏览器暂不可用', tab_unavailable: '来源标签已不可用，可重新打开',
  tab_closed: '来源标签已关闭，可重新打开', tab_evicted: '来源标签已被回收，可重新打开',
  user_navigated: '来源页面已被更改，请重新打开', document_changed: '来源文档已变更',
  interrupted: '读取已中断，请明确继续', paused_by_user: '用户已暂停',
  task_paused: '任务已暂停', storage_error: '保存任务失败，任务已暂停',
  browser_total_dom_limit: '浏览器文档总字节预算不足', browser_source_dom_limit: '来源浏览器文档字节预算不足',
  browser_dom_budget: '浏览器文档字节预算不足', fetch_limit: '读取派发预算不足',
  model_call_limit: '模型调用预算不足', total_byte_limit: '总字节预算不足',
  source_byte_limit: '来源字节预算不足', candidate_limit: '来源数量预算不足',
  http_401: '页面要求登录（HTTP 401）', http_403: '页面拒绝访问（HTTP 403）',
  navigation_timeout: '来源导航超时', navigation_error: '来源导航失败',
  navigation_crashed: '来源页面进程已退出', attempt_superseded: '读取尝试已被替代',
  unsupported_media: '不支持的媒体类型', navigation_download: '来源导航触发了下载',
  script_only_or_no_article: '页面尚无可提取正文', needs_browser: '需要浏览器读取',
};
function reasonLabel(reason: string): string { return REASONS[reason] ?? reason; }
function label(snapshot: WebResearchTaskSnapshot): string {
  if (snapshot.status === 'running' && snapshot.counts.waiting_user) {
    const c = snapshot.counts;
    return c.queued + c.fetching + c.extracting + (c.browser_queued ?? 0) + (c.browser_reading ?? 0) === 0
      ? '待用户处理' : `进行中 · 待处理 ${c.waiting_user}`;
  }
  return { running: '进行中', paused: '已暂停', completed: '已完成',
    cancelled: '已取消', failed: '任务失败' }[snapshot.status];
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function sourceAction(entry: Record<string, unknown>): { sourceId: string; expectedAttemptId: string | null } | null {
  return typeof entry.sourceId === 'string' && typeof entry.requestedUrl === 'string' &&
    (typeof entry.expectedAttemptId === 'string' || entry.expectedAttemptId === null)
    ? { sourceId: entry.sourceId, expectedAttemptId: entry.expectedAttemptId } : null;
}

/** The conversation owns one movable anchor; revisioned task snapshots update this card in place. */
export function ResearchTaskCard({ threadId, researchRunId }: { threadId: string; researchRunId: string }) {
  const stored = useWebResearchTaskStore((state) => state.snapshots[researchRunId]);
  const snapshot = stored?.threadId === threadId ? stored : undefined;
  const upsert = useWebResearchTaskStore((state) => state.upsert);
  // Runtime ownership changes immediately on a prop change, before any effect can settle.
  const scope = useMemo(() => ({ threadId, researchRunId, alive: true, request: 0, viewRequest: 0, openRequest: 0,
    view: 'sources' as View, expanded: false, detailRevision: -1, actions: new Set<string>(), control: false,
    requestedIcons: new Set<string>() }), [threadId, researchRunId]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const current = () => scope.alive && currentScope.current === scope;
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View>('sources');
  const [details, setDetails] = useState<{ owner: typeof scope; items: unknown[]; nextCursor?: string }>(
    { owner: scope, items: [] });
  const items = details.owner === scope ? details.items : [];
  const nextCursor = details.owner === scope ? details.nextCursor : undefined;
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteIcons, setSiteIcons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string[]>([]);
  const [controlling, setControlling] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    scope.alive = true;
    setExpanded(false); setView('sources'); setEvidence(null); setError(null);
    setSiteIcons({}); setBusy([]); setControlling(false); setLoading(false);
    return () => { scope.alive = false; };
  }, [scope]);

  const accept = (value: WebResearchTaskSnapshot) => {
    if (current() && value.threadId === threadId && value.researchRunId === researchRunId) upsert(value);
  };
  useEffect(() => {
    void window.kydog.invoke('webResearch.taskGet', { threadId, researchRunId })
      .then(accept).catch((reason: unknown) => { if (current()) setError(errorText(reason)); });
  }, [scope, upsert]);

  async function load(nextView: View, cursor?: string, refresh = false): Promise<void> {
    const request = ++scope.request;
    if (!refresh) ++scope.viewRequest;
    scope.view = nextView;
    setView(nextView); setError(null); setEvidence(null); setLoading(true);
    if (!cursor && nextView !== view) setDetails({ owner: scope, items: [] });
    try {
      const result = await window.kydog.invoke('webResearch.taskInspect', {
        threadId, researchRunId, view: nextView, pageSize: 20, cursor,
      });
      if (!current() || request !== scope.request || result.snapshot.threadId !== threadId ||
          result.snapshot.researchRunId !== researchRunId) return;
      const latest = useWebResearchTaskStore.getState().snapshots[researchRunId];
      if (latest && latest.revision > result.snapshot.revision) return;
      scope.detailRevision = result.snapshot.revision;
      accept(result.snapshot);
      setDetails((prior) => ({ owner: scope, items: cursor && prior.owner === scope
        ? [...prior.items, ...result.items] : result.items, nextCursor: result.nextCursor }));
    } catch (reason) { if (current() && request === scope.request) setError(errorText(reason)); }
    finally { if (current() && request === scope.request) setLoading(false); }
  }

  // bootstrap is the sole event subscriber. A newer full snapshot invalidates paginated details.
  useEffect(() => {
    if (scope.expanded && snapshot && snapshot.revision > scope.detailRevision) void load(scope.view, undefined, true);
  }, [scope, snapshot?.revision]);

  async function openEvidence(evidenceId: string): Promise<void> {
    const request = ++scope.request;
    setError(null); setLoading(false);
    try {
      const result = await window.kydog.invoke('webResearch.taskInspect', {
        threadId, researchRunId, view: 'evidence', evidenceIds: [evidenceId],
      });
      if (!current() || request !== scope.request) return;
      accept(result.snapshot); setEvidence(record(result.items[0]));
    } catch (reason) { if (current() && request === scope.request) setError(errorText(reason)); }
  }

  function taskMutable(retry = false): boolean {
    const task = useWebResearchTaskStore.getState().snapshots[researchRunId];
    return task?.threadId === threadId && (task.status === 'running' || (!retry && task.status === 'paused'));
  }
  async function actOnSource(entry: Record<string, unknown>, action: 'open' | 'retry'): Promise<void> {
    const key = sourceAction(entry);
    if (!current() || !key || !taskMutable(action === 'retry') || scope.actions.has(key.sourceId) || loading) return;
    const request = scope.viewRequest;
    const openRequest = action === 'open' ? ++scope.openRequest : scope.openRequest;
    scope.actions.add(key.sourceId); setBusy([...scope.actions]); setError(null);
    try {
      if (action === 'open') {
        const result = await window.kydog.invoke('webResearch.taskOpenSource', { threadId, researchRunId, sourceId: key.sourceId });
        if (!current()) return;
        if (result.snapshot.threadId !== threadId || result.snapshot.researchRunId !== researchRunId) return;
        if (request === scope.viewRequest && scope.view === 'sources') {
          const latest = useWebResearchTaskStore.getState().snapshots[researchRunId];
          if (!latest || result.snapshot.revision >= latest.revision) setDetails((prior) => prior.owner !== scope ? prior : { ...prior, items: prior.items.map((row) => {
            const source = record(row);
            return source.sourceId === key.sourceId ? { ...source, expectedAttemptId: result.expectedAttemptId } : row;
          }) });
          if (openRequest === scope.openRequest && !useUiStore.getState().browserOpen) useUiStore.getState().toggleBrowser();
        }
        accept(result.snapshot);
      } else {
        const result = await window.kydog.invoke('webResearch.taskRetrySource', { threadId, researchRunId, ...key });
        if (current()) accept(result);
      }
    } catch (reason) { if (current() && request === scope.viewRequest) setError(errorText(reason)); }
    finally { scope.actions.delete(key.sourceId); if (current()) setBusy([...scope.actions]); }
  }

  async function control(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    if (!current() || scope.control || !taskMutable()) return;
    scope.control = true; setControlling(true); setError(null);
    try {
      if (action === 'cancel' && !(await confirm({ title: '取消这段网页研究？',
        message: '排队中与进行中的工作会停下，已取得的证据会保留。', confirmLabel: '取消研究' }))) return;
      if (!current() || !taskMutable()) return;
      accept(await window.kydog.invoke('webResearch.taskControl', { threadId, researchRunId, action }));
    } catch (reason) { if (current()) setError(errorText(reason)); }
    finally { scope.control = false; if (current()) setControlling(false); }
  }

  const counts = snapshot?.counts;
  const visibleSites = snapshot?.sites.slice(0, expanded ? snapshot.sites.length : 12) ?? [];
  const iconDomains = visibleSites.filter((site) => site.iconAvailable).map((site) => site.domain).join('\n');
  useEffect(() => {
    for (const domain of iconDomains ? iconDomains.split('\n') : []) {
      if (scope.requestedIcons.has(domain)) continue;
      scope.requestedIcons.add(domain);
      void window.kydog.invoke('webResearch.taskSiteIcon', { threadId, researchRunId, domain })
        .then((result) => {
          if (current() && result.dataUrl) {
            setSiteIcons((prior) => ({ ...prior, [result.domain]: result.dataUrl! }));
          }
        })
        .catch(() => { /* The domain pill remains the exact fallback. */ });
    }
  }, [scope, iconDomains]);
  return (
    <section data-testid="research-task-card" data-status={snapshot?.status ?? 'loading'}
      className="ky-paper-deep font-sans" style={{ margin: '12px 0 16px', padding: '14px 16px',
        border: '0.5px solid var(--color-ink-hair)', borderRadius: 8, fontSize: 12 }}>
      <button type="button" data-testid="research-task-toggle" onClick={() => {
        const next = !expanded;
        scope.expanded = next; setExpanded(next);
        if (next) void load(scope.view);
        else { ++scope.request; ++scope.viewRequest; setLoading(false); }
      }} className="w-full text-left" style={{ color: 'var(--color-ink)' }}>
        <strong>网页研究 · {snapshot ? label(snapshot) : '读取中'}</strong>
        {snapshot && <span style={{ marginLeft: 8, color: 'var(--color-ink-soft)' }}>{snapshot.originalQuestion}</span>}
        <span style={{ float: 'right', color: 'var(--color-ink-faint)' }}>{expanded ? '收起' : '展开'}</span>
      </button>
      {counts && <div data-testid="research-task-progress" style={{ marginTop: 8,
        color: 'var(--color-ink)', lineHeight: 1.5 }}>
        {`已处理 ${counts.processed}/${counts.sources} 个已入队来源；有证据 ${counts.evidenceReady}，无相关主张 ${counts.irrelevant}，失败 ${counts.failed}`}
        {counts.cancelled ? `，取消 ${counts.cancelled}` : ''}
        {counts.unprocessed ? `，未处理 ${counts.unprocessed}` : ''}
      </div>}
      {visibleSites.length > 0 && <div data-testid="research-task-sites" style={{ display: 'flex',
        gap: 6, alignItems: 'center', overflow: 'hidden', marginTop: 8, whiteSpace: 'nowrap' }}>
        {visibleSites.map((site) => siteIcons[site.domain] ?
          <img key={site.domain} data-testid="research-site-icon" src={siteIcons[site.domain]} alt={site.domain}
            title={`${site.domain} · ${site.processed}/${site.sourceCount}`}
            style={{ width: 18, height: 18, borderRadius: 4, objectFit: 'contain', flex: '0 0 auto' }} /> :
          <span key={site.domain} data-testid="research-site-domain" title={`${site.processed}/${site.sourceCount}`}
            style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', padding: '2px 6px',
              border: '0.5px solid var(--color-ink-hair)', borderRadius: 10,
              color: 'var(--color-ink-soft)', flex: '0 0 auto' }}>{site.domain}</span>)}
        {!expanded && snapshot!.sites.length > visibleSites.length &&
          <span style={{ color: 'var(--color-ink-faint)' }}>+{snapshot!.sites.length - visibleSites.length}</span>}
      </div>}
      {counts && <div data-testid="research-task-counts" style={{ marginTop: 8,
        color: 'var(--color-ink-soft)', lineHeight: 1.6 }}>
        发现 {counts.discoveries} · 来源 {counts.sources} · 排队 {counts.queued} · 抓取 {counts.fetching}
        {' · '}抽取 {counts.extracting} · 有证据 {counts.evidenceReady} · 无相关主张 {counts.irrelevant}
        {' · '}失败 {counts.failed}
        {counts.unprocessed ? ` · 未处理 ${counts.unprocessed}` : ''}
        {' · '}浏览器排队 {counts.browser_queued ?? 0} · 浏览器读取 {counts.browser_reading ?? 0}
        {' · '}待处理 {counts.waiting_user ?? 0}
        <br />读取派发（含浏览器打开） {snapshot!.usage.fetchesDispatched}/{snapshot!.budget.maxFetches}
        {' · '}浏览器文档字节 {snapshot!.browserDomBytes ?? 0}/{snapshot!.budget.maxTotalBytes}
        {' · '}模型调用 {snapshot!.usage.modelCalls}/{snapshot!.budget.maxModelCalls}
      </div>}
      {snapshot?.statusReason && <div style={{ color: 'var(--color-ink-soft)' }}>{reasonLabel(snapshot.statusReason)}</div>}
      {snapshot && (snapshot.status === 'running' || snapshot.status === 'paused') &&
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <button type="button" data-testid={snapshot.status === 'paused' ? 'research-task-resume' : 'research-task-pause'}
            disabled={controlling} onClick={() => { void control(snapshot.status === 'paused' ? 'resume' : 'pause'); }}>
            {snapshot.status === 'paused' ? '恢复任务' : '暂停任务'}</button>
          <button type="button" data-testid="research-task-cancel" disabled={controlling}
            onClick={() => { void control('cancel'); }}>取消任务</button>
        </div>}
      {error && <div role="alert" style={{ marginTop: 8 }}>{error}</div>}
      {expanded && <div style={{ marginTop: 10, borderTop: '0.5px solid var(--color-ink-hair)', paddingTop: 8 }}>
        <div className="flex gap-3">
          <button type="button" data-testid="research-task-sources" onClick={() => { void load('sources'); }}
            style={{ textDecoration: 'underline' }}>来源</button>
          <button type="button" data-testid="research-task-claims" onClick={() => { void load('claims'); }}
            style={{ textDecoration: 'underline' }}>主张</button>
          <button type="button" onClick={() => { void load(view); }} style={{ textDecoration: 'underline' }}>刷新</button>
        </div>
        <div data-testid="research-task-items" style={{ maxHeight: 300, overflowY: 'auto' }}>
          {items.map((item, index) => {
            const entry = record(item);
            const action = sourceAction(entry);
            const mutable = snapshot?.status === 'running' || snapshot?.status === 'paused';
            const sourceBusy = action ? busy.includes(action.sourceId) : false;
            return <div key={`${String(entry.sourceId ?? entry.claimId)}-${index}`}
              style={{ padding: '7px 0', borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}>
              {view === 'sources' ? <>
                <strong>{SOURCE_LABELS[String(entry.status)] ?? String(entry.status ?? '')}</strong> · {String(entry.finalUrl ?? entry.requestedUrl ?? '')}
                {entry.reason ? ` · ${reasonLabel(String(entry.reason))}` : ''}
                {entry.claimCount ? ` · 主张 ${String(entry.claimCount)}` : ''}
                {entry.status === 'waiting_user' && action && <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                  <button type="button" data-testid={`research-source-open-${action.sourceId}`}
                    disabled={!mutable || sourceBusy || loading} onClick={() => { void actOnSource(entry, 'open'); }}>
                    {sourceBusy ? '处理中…' : '打开页面'}</button>
                  <button type="button" data-testid={`research-source-retry-${action.sourceId}`}
                    disabled={snapshot?.status !== 'running' || sourceBusy || loading}
                    onClick={() => { void actOnSource(entry, 'retry'); }}>继续读取</button>
                </div>}
              </> : <>
                <span>{String(entry.statement ?? '')}</span>
                <div style={{ color: 'var(--color-ink-faint)' }}>{String(entry.finalUrl ?? '')}</div>
                {Array.isArray(entry.evidence) && entry.evidence.map((raw) => {
                  const item = raw as Record<string, unknown>;
                  const id = String(item.evidenceId ?? '');
                  return <button type="button" key={id} onClick={() => { void openEvidence(id); }}
                    style={{ marginRight: 8, textDecoration: 'underline' }}>{id}</button>;
                })}
              </>}
            </div>;
          })}
        </div>
        {nextCursor && <button type="button" onClick={() => { void load(view, nextCursor); }}
          style={{ marginTop: 8, textDecoration: 'underline' }}>加载更多</button>}
        {evidence && <blockquote data-testid="research-task-evidence" style={{ marginTop: 8,
          padding: 8, borderLeft: '2px solid var(--color-ink-hair)' }}>
          {String(evidence.excerpt ?? '')}
        </blockquote>}
      </div>}
    </section>
  );
}
