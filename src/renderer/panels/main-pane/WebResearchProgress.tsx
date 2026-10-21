import { useState } from 'react';
import type { ResearchEvidenceExcerpt, ResearchRunIndex, ResearchTaskStatus } from '../../../shared/webResearch';
import { useWebResearchStore } from '../../stores/webResearchStore';

const statusLabel: Record<ResearchTaskStatus, string> = {
  queued: '排队', fetching: '抓取', extracting: '抽取', completed: '完成',
  failed: '失败', cancelled: '取消', interrupted: '中断',
};

function failureText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function WebResearchProgress({ threadId }: { threadId: string }) {
  const currentRunId = useWebResearchStore((state) => state.currentRunByThread[threadId]);
  const live = useWebResearchStore((state) => Object.values(state.runs).find((run) =>
    run.threadId === threadId && run.runId === state.currentRunByThread[threadId]));
  const [records, setRecords] = useState<{ threadId: string; entries: ResearchRunIndex[] } | null>(null);
  const [selected, setSelected] = useState<ResearchRunIndex | null>(null);
  const [opened, setOpened] = useState<ResearchEvidenceExcerpt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const entries = records?.threadId === threadId ? records.entries : [];
  const selectedHere = selected?.threadId === threadId ? selected : null;
  const taskCounts = Object.values(live?.taskById ?? {}).reduce<Partial<Record<ResearchTaskStatus, number>>>(
    (counts, task) => ({ ...counts, [task.status]: (counts[task.status] ?? 0) + 1 }), {});

  async function showRecords(): Promise<void> {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    setError(null);
    setBusy(true);
    try {
      const next = await window.kydog.invoke('webResearch.list', { threadId });
      setRecords({ threadId, entries: next });
    } catch (err) { setError(failureText(err)); }
    finally { setBusy(false); }
  }

  async function showRun(researchRunId: string): Promise<void> {
    setError(null); setOpened(null); setBusy(true);
    try { setSelected(await window.kydog.invoke('webResearch.get', { threadId, researchRunId })); }
    catch (err) { setError(failureText(err)); }
    finally { setBusy(false); }
  }

  async function showEvidence(researchRunId: string, evidenceId: string): Promise<void> {
    setError(null); setBusy(true);
    try { setOpened(await window.kydog.invoke('webResearch.evidence', { threadId, researchRunId, evidenceId })); }
    catch (err) { setError(failureText(err)); }
    finally { setBusy(false); }
  }

  return (
    <section className="shrink-0 font-sans" data-testid="web-research-progress"
      style={{ borderBottom: '1px solid var(--color-ink-hair)', padding: '6px 16px', fontSize: 11,
        color: 'var(--color-ink-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {live && currentRunId ? <span data-testid="web-research-live">
          网页研究 · {Object.entries(taskCounts).map(([status, count]) =>
            `${statusLabel[status as ResearchTaskStatus]} ${count}`).join(' · ')}
          {' · '}抓取 {live.usage.fetchesDispatched}/{live.budget.maxFetches}
          {' · '}模型 {live.usage.modelCalls}/{live.budget.maxModelCalls}
          {' · '}流量 {live.usage.receivedBytes}/{live.budget.maxTotalBytes} B
        </span> : null}
        <button type="button" data-testid="web-research-records" onClick={() => { void showRecords(); }}
          style={{ textDecoration: 'underline', color: 'var(--color-ink-soft)' }}>
          研究记录
        </button>
      </div>
      {expanded ? <div data-testid="web-research-record-list" style={{ marginTop: 7, maxHeight: 200, overflowY: 'auto' }}>
        {busy ? <div>读取中…</div> : null}
        {error ? <div role="alert">{error}</div> : null}
        {!busy && entries.length === 0 ? <div>暂无研究记录</div> : null}
        {entries.map((entry) => <div key={entry.researchRunId}>
          <button type="button" onClick={() => { void showRun(entry.researchRunId); }}
            style={{ textDecoration: 'underline', textAlign: 'left' }}>
            {entry.originalQuestion} · {entry.sources.length} 个来源
          </button>
        </div>)}
        {selectedHere ? <div data-testid="web-research-source-list" style={{ marginTop: 6 }}>
          {selectedHere.sources.map((source) => <div key={source.sourceId}>
            {statusLabel[source.status]} · {source.finalUrl ?? source.requestedUrl}
            {source.evidenceIds?.map((evidenceId) => <button key={evidenceId} type="button"
              onClick={() => { void showEvidence(selectedHere.researchRunId, evidenceId); }}
              style={{ marginLeft: 8, textDecoration: 'underline' }}>{evidenceId}</button>)}
          </div>)}
        </div> : null}
        {opened && selectedHere ? <div data-testid="web-research-evidence" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
          <a href={opened.finalUrl} target="_blank" rel="noopener noreferrer">{opened.finalUrl}</a>
          {' · '}{opened.heading ?? ''}{opened.pageNumber === undefined ? '' : ` p. ${opened.pageNumber}`}
          <blockquote style={{ margin: '4px 0' }}>{opened.excerpt}</blockquote>
        </div> : null}
      </div> : null}
    </section>
  );
}
