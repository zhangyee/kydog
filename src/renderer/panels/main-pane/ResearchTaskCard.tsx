import { useEffect, useRef, useState } from 'react';
import type { WebResearchTaskSnapshot } from '../../../shared/webResearchTask';
import { useWebResearchTaskStore } from '../../stores/webResearchTaskStore';

type View = 'sources' | 'claims';
function label(status: WebResearchTaskSnapshot['status']): string {
  return { running: '进行中', paused: '已暂停', completed: '已完成',
    cancelled: '已取消', failed: '任务失败' }[status];
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** The conversation owns one movable anchor; revisioned task snapshots update this card in place. */
export function ResearchTaskCard({ threadId, researchRunId }: { threadId: string; researchRunId: string }) {
  const snapshot = useWebResearchTaskStore((state) => state.snapshots[researchRunId]);
  const upsert = useWebResearchTaskStore((state) => state.upsert);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<View>('sources');
  const [items, setItems] = useState<unknown[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [evidence, setEvidence] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteIcons, setSiteIcons] = useState<Record<string, string>>({});
  const requestedIcons = useRef(new Set<string>());
  const detailRequest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    let active = true;
    void window.kydog.invoke('webResearch.taskGet', { threadId, researchRunId })
      .then((value) => { if (active) upsert(value); })
      .catch((reason: unknown) => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [threadId, researchRunId, upsert]);

  async function load(nextView: View, cursor?: string): Promise<void> {
    const request = ++detailRequest.current;
    setError(null);
    try {
      const result = await window.kydog.invoke('webResearch.taskInspect', {
        threadId, researchRunId, view: nextView, pageSize: 20, cursor,
      });
      if (request !== detailRequest.current) return;
      upsert(result.snapshot);
      setView(nextView);
      setItems((prior) => cursor ? [...prior, ...result.items] : result.items);
      setNextCursor(result.nextCursor);
    } catch (reason) { if (request === detailRequest.current) setError(errorText(reason)); }
  }

  async function openEvidence(evidenceId: string): Promise<void> {
    setError(null);
    try {
      const result = await window.kydog.invoke('webResearch.taskInspect', {
        threadId, researchRunId, view: 'evidence', evidenceIds: [evidenceId],
      });
      upsert(result.snapshot);
      setEvidence(result.items[0] as Record<string, unknown>);
    } catch (reason) { setError(errorText(reason)); }
  }

  const counts = snapshot?.counts;
  const visibleSites = snapshot?.sites.slice(0, expanded ? snapshot.sites.length : 12) ?? [];
  const iconDomains = visibleSites.filter((site) => site.iconAvailable).map((site) => site.domain).join('\n');
  useEffect(() => {
    for (const domain of iconDomains ? iconDomains.split('\n') : []) {
      if (requestedIcons.current.has(domain)) continue;
      requestedIcons.current.add(domain);
      void window.kydog.invoke('webResearch.taskSiteIcon', { threadId, researchRunId, domain })
        .then((result) => {
          if (mounted.current && result.dataUrl) {
            setSiteIcons((prior) => ({ ...prior, [result.domain]: result.dataUrl! }));
          }
        })
        .catch(() => { /* The domain pill remains the exact fallback. */ });
    }
  }, [threadId, researchRunId, iconDomains]);
  return (
    <section data-testid="research-task-card" data-status={snapshot?.status ?? 'loading'}
      className="ky-paper-deep font-sans" style={{ margin: '12px 0 16px', padding: '14px 16px',
        border: '0.5px solid var(--color-ink-hair)', borderRadius: 8, fontSize: 12 }}>
      <button type="button" data-testid="research-task-toggle" onClick={() => {
        const next = !expanded;
        setExpanded(next);
        if (next) void load(view);
      }} className="w-full text-left" style={{ color: 'var(--color-ink)' }}>
        <strong>网页研究 · {snapshot ? label(snapshot.status) : '读取中'}</strong>
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
        <br />抓取预算 {snapshot!.usage.fetchesDispatched}/{snapshot!.budget.maxFetches}
        {' · '}模型调用 {snapshot!.usage.modelCalls}/{snapshot!.budget.maxModelCalls}
      </div>}
      {snapshot?.statusReason && <div style={{ color: 'var(--color-ink-soft)' }}>{snapshot.statusReason}</div>}
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
            const entry = item as Record<string, unknown>;
            return <div key={`${String(entry.sourceId ?? entry.claimId)}-${index}`}
              style={{ padding: '7px 0', borderBottom: '0.5px solid var(--color-ink-hair-soft)' }}>
              {view === 'sources' ? <>
                <strong>{String(entry.status ?? '')}</strong> · {String(entry.finalUrl ?? entry.requestedUrl ?? '')}
                {entry.reason ? ` · ${String(entry.reason)}` : ''}
                {entry.claimCount ? ` · 主张 ${String(entry.claimCount)}` : ''}
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
