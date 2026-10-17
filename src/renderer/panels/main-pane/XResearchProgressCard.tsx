import { useEffect, useState, type CSSProperties } from 'react';
import type { XResearchStatus } from '../../../shared/xResearchStatus';
import type {
  XResearchTaskSnapshot, XResearchTaskState, XResearchWorkItem,
} from '../../../shared/xResearchTask';
import { useXResearchTaskStore } from '../../stores/xResearchTaskStore';
import { confirm } from '../../stores/confirmStore';

const CARD_STYLE: CSSProperties = {
  margin: '12px 0 16px', padding: '14px 16px', border: '0.5px solid var(--color-ink-hair)',
  borderRadius: 8, fontSize: 12,
};
const OBJECTIVE_STYLE: CSSProperties = {
  marginTop: 4, color: 'var(--color-ink-soft)', lineHeight: 1.5,
};
const SUMMARY_STYLE: CSSProperties = { marginTop: 8, color: 'var(--color-ink)', lineHeight: 1.5 };
const BUDGET_STYLE: CSSProperties = { marginTop: 2, color: 'var(--color-ink-soft)' };
const CANCEL_STYLE: CSSProperties = {
  marginTop: 8, color: 'var(--color-ink-soft)', textDecoration: 'underline',
};
const ROWS_STYLE: CSSProperties = {
  marginTop: 10, borderTop: '0.5px solid var(--color-ink-hair)', paddingTop: 8,
};
const SECTION_HEADING_STYLE: CSSProperties = { color: 'var(--color-ink-soft)', marginBottom: 2 };
const ROW_STYLE: CSSProperties = {
  display: 'flex', gap: 6, alignItems: 'baseline', whiteSpace: 'nowrap', padding: '2px 0',
};
const MARK_STYLE: CSSProperties = { color: 'var(--color-ink-faint)', flex: '0 0 auto' };
const ROW_LABEL_STYLE: CSSProperties = { flex: '0 1 auto', minWidth: 0, maxWidth: 240 };
const SOFT_STYLE: CSSProperties = { color: 'var(--color-ink-soft)', flex: '0 0 auto' };
const REASON_STYLE: CSSProperties = {
  flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
  color: 'var(--color-ink-soft)',
};

/** 卡头状态词（spec §5.3 的卡状态表）。顺序与判据都在主进程的 `xResearchTaskState` 里，
 *  这里只负责把那个词翻成中文：卡上不重新判定状态。 */
const STATE_WORD: Record<XResearchTaskState, string> = {
  running: '进行中', completed: '完成', failed: '有失败', cancelled: '取消', interrupted: '中断',
};

/** 行还在飞时的阶段词（spec §5.4 的 phase，任务侧旁表报上来的值）。 */
const WORK_STATE_WORD: Record<XResearchWorkItem['state'], string> = {
  queued: '排队', navigating: '打开中', collecting: '收集中', waiting: '等待中',
  scrolling: '滚动中', action: '操作中', stopped: '',
};

/** 行收尾后的结论词。`partial` 另有「预算用尽」这一支（见 `rowStatusWord`）。 */
const STATUS_WORD: Record<XResearchStatus, string> = {
  observed: '收完', partial: '部分', explicit_empty: '空结果',
  auth_required: '要登录', action_required: '要人工', rate_limited: '被限速',
  access_denied: '访问被拒', unavailable: '源不可用', cancelled: '已取消', failed: '失败',
};

/** 文章四态（spec §5.4）。`not_requested` 是「这次没要文章」，不是「文章取失败了」。
 *  `pending` 在没起跑的行上说的是义务而不是动作：`排队 请求中` 是还没发生的进行时。 */
const ARTICLE_WORD: Record<XResearchWorkItem['article'], string> = {
  not_requested: '无文章', pending: '请求中', entry: '有入口', body: '有正文', failed: '文章失败',
};

/** 读取行的段落（spec §5.4：`readX` 循环里四个真实分支）。它答的是「这一行现在在哪一段」，
 *  与状态词连起来读：「等待中 · 读回复」。已收尾的行 `phaseDetail` 为空，不渲染（见 `readRowElement`）。 */
const PHASE_DETAIL_WORD: Record<NonNullable<XResearchWorkItem['phaseDetail']>, string> = {
  root: '读根帖', article: '读文章', return: '回主帖', discussion: '读回复',
};

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/** 段内编号：两段各自从 ① 起。超过 ⑳ 之后退回 `N.` —— 没有第 21 个圈号，凑一个只会变成怪字符。 */
function numberMark(index: number): string {
  return CIRCLED[index] ?? `${index + 1}.`;
}

/** 收尾的行说结论，还在飞的行说阶段。`status === null` 的「收尾但无结论」照 §4.4 说「中断」，
 *  不猜成失败或成功。 */
function rowStatusWord(row: XResearchWorkItem): string {
  if (row.status === null) return '中断';
  if (row.section === 'read' && row.status === 'observed') return '已读';
  // 预算用尽是一个真实的 stopReason，不是从「帖数少」推出来的近似。
  if (row.status === 'partial' && row.stopReason === 'budget_reached') return '预算用尽';
  return STATUS_WORD[row.status];
}

function rowStateWord(row: XResearchWorkItem): string {
  return row.state === 'stopped' ? rowStatusWord(row) : WORK_STATE_WORD[row.state];
}

/** `stateReason` 只在它能解释状态时才当括注出现：「取消」+「被取消」是同一件事说两遍。
 *  不认识的词不进卡面：它是开放字符串，猜一句解释会把「有一份提交读不出来」说成用户动作。 */
function stateNote(reason: string | undefined, state: XResearchTaskState): string | null {
  if (!reason) return null;
  if (reason === 'cancelled') return state === 'cancelled' ? null : '部分被取消';
  if (reason === 'process_restarted') return '进程重启';
  if (reason === 'submission_unreadable') return '有提交记录读不出来';
  return null;
}

/** 摘要行：每个数字都是快照的权威字段 —— `counts.*` 由主进程按工作项分桶，
 *  `*Done/*Total` 是**按段**分好的同一份分桶（卡片不再自己数 `read.length`：那一读在运行中
 *  会被读成「20 个目标都读完了」）。 */
function summaryLine(snapshot: XResearchTaskSnapshot): string {
  const { counts } = snapshot;
  const failed = counts.failed > 0 ? ` · 失败 ${counts.failed}` : '';
  return `搜索 ${counts.searchDone}/${counts.searchTotal} 个 query · 收 ${counts.posts} 帖 ｜ `
    + `读取 ${counts.readDone}/${counts.readTotal} 个目标 · ${counts.replies} 回复`
    + ` · 文章 ${counts.articles} 篇${failed}`;
}

/** 预算行取快照的 `usage` / `budget` 两个字段，口径就是 spec §5.3 与 §5.4 的那一对。 */
function budgetLine(snapshot: XResearchTaskSnapshot): string {
  return `滚动 ${snapshot.usage.scrolls}/${snapshot.budget.scrolls}`
    + ` · 展开 ${snapshot.usage.expandActions}/${snapshot.budget.expandActions}`;
}

/**
 * 搜索行：query + 产品 + 状态 + `收 N 帖`（`budgetUsage.distinctEntries` 的去重帖数）
 * + `另省 N`（`sampleTruncation.omitted`，只在 >0 时有内容）+ `N 页`（被接纳的网络页数）。
 * 每条都来自行自己的字段；行还没起跑（`queued`）时一个数字都不说 —— 「收 0 帖」会被读成结论。
 */
function searchRowElement(row: XResearchWorkItem, index: number) {
  const started = row.state !== 'queued';
  return (
    <div key={row.workItemId} data-testid="x-research-row" data-section="search" style={ROW_STYLE}>
      <span style={MARK_STYLE}>{numberMark(index)}</span>
      <span className="truncate" title={row.label} style={ROW_LABEL_STYLE}>{row.label}</span>
      {row.product && <span data-testid="x-research-row-product" style={SOFT_STYLE}>{row.product}</span>}
      <span style={SOFT_STYLE}>{rowStateWord(row)}</span>
      {started && <span style={SOFT_STYLE}>收 {row.posts} 帖</span>}
      {started && row.omitted > 0 && <span style={SOFT_STYLE}>另省 {row.omitted}</span>}
      {started && row.pages > 0 && <span style={SOFT_STYLE}>{row.pages} 页</span>}
      {row.reason && <span style={REASON_STYLE}>{row.reason}</span>}
    </div>
  );
}

/**
 * 读取行：permalink（截断显示，完整文本在 `title`）+ 状态 + 根帖与回复区观测数
 * （`replies` 只算回复区，不含没证明属于这个讨论的帖子）+ 文章四态 +
 * 在飞那一行的实时动作数（`budgetUsage.scrolls` / `budgetUsage.expandActions`）。
 */
function readRowElement(row: XResearchWorkItem, index: number) {
  const started = row.state !== 'queued';
  const active = started && row.state !== 'stopped';
  // 没起跑的行说「待取」（提交时声明过的义务），起跑之后才说「请求中」（真的在取）。
  const articleWord = row.article === 'pending' && !started ? '待取' : ARTICLE_WORD[row.article];
  return (
    <div key={row.workItemId} data-testid="x-research-row" data-section="read" style={ROW_STYLE}>
      <span style={MARK_STYLE}>{numberMark(index)}</span>
      <span className="truncate" title={row.label} style={ROW_LABEL_STYLE}>{row.label}</span>
      <span style={SOFT_STYLE}>{rowStateWord(row)}</span>
      {/* 段落只在还在飞的行上有意义（收尾时主进程会清空它）；为空时就不说这段，
          状态词已经交代了它在哪一步，渲染一个空 span 或「null」只是噪声。 */}
      {active && row.phaseDetail &&
        <span data-testid="x-research-phase-detail" style={SOFT_STYLE}>
          {PHASE_DETAIL_WORD[row.phaseDetail]}
        </span>}
      {started && row.hasRoot && <span style={SOFT_STYLE}>根帖 + {row.replies} 回复</span>}
      {/* 收尾了还没拿到根帖才是「无根帖」；还在飞的时候只是「还没拿到」，不能这么说。 */}
      {started && !row.hasRoot && row.state === 'stopped' && <span style={SOFT_STYLE}>无根帖</span>}
      {/* 文章四态是提交时就声明过的义务（没要 / 要了），起跑前就说得出，不依赖 `started`。 */}
      <span style={SOFT_STYLE}>{articleWord}</span>
      {active && <span style={SOFT_STYLE}>展开 {row.expandActions} · 滚动 {row.scrolls}</span>}
      {row.reason && <span style={REASON_STYLE}>{row.reason}</span>}
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 「X 研究」的过程卡片（spec §5.3）。一张卡跟着一段研究走，数据源是渲染层 store 里的快照：
 * 挂载时用 `xResearch.taskGet` 把这一份补齐，之后 `xResearch.taskUpdated` 广播（bootstrap 那条线）
 * 会把它更新到 store 里。运行中默认展开、进终态自动收起，用户手动点过之后以点击为准。
 */
export function XResearchProgressCard({ threadId, researchRunId }: {
  threadId: string; researchRunId: string;
}) {
  const snapshot = useXResearchTaskStore((state) => state.snapshotsByRunId[researchRunId]);
  const upsert = useXResearchTaskStore((state) => state.upsert);
  // `null` = 还没点过，跟着状态走；一旦点过就永远以这一份布尔为准（不再随状态自动收放）。
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `research.not_found` 没有快照可说：那个 code 同时盖着「不在这个线程/窗口/活动标签页」、
  // 「这段研究真被删了」与「任务服务没接上」。前两种都不是错误，第三种是接线回归；
  // 两种情形都不该把卡永远停在「读取中」—— 这里记一笔，卡头改说「记录不可用」。
  const [gone, setGone] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let active = true;
    void window.kydog.invoke('xResearch.taskGet', { threadId, researchRunId })
      .then((value) => { if (active) upsert(value); })
      .catch((reason: unknown) => {
        if (!active) return;
        // 研究已经被删掉不是错误：卡跟着那条记录一起消失，不该在会话里留一条红字。
        if ((reason as { code?: string } | null)?.code === 'research.not_found') {
          setGone(true);
          return;
        }
        setError(errorText(reason));
      });
    return () => { active = false; };
  }, [threadId, researchRunId, upsert]);

  async function cancelResearch(): Promise<void> {
    const confirmed = await confirm({
      title: '取消这段 X 研究？',
      message: '已收集的帖子与已读的帖子会保留；排队中与进行中的工作会停下，之后不能在这段研究上续跑。',
      confirmLabel: '取消研究',
    });
    if (!confirmed) return;
    setCancelling(true);
    try {
      upsert(await window.kydog.invoke('xResearch.taskCancel', { threadId, researchRunId }));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setCancelling(false);
    }
  }

  const state = snapshot?.state;
  const note = state ? stateNote(snapshot.stateReason, state) : null;
  const expanded = manualExpanded ?? (state === 'running');
  // 有快照时仍以快照为准（那个 code 也盖着「不在这个窗口的标签页」，广播来的快照是真的）。
  const status = state ?? (gone ? 'missing' : 'loading');
  const headerWord = state ? STATE_WORD[state] : (gone ? '记录不可用' : '读取中');

  return (
    <section data-testid="x-research-card" data-status={status}
      className="ky-paper-deep font-sans" style={CARD_STYLE}>
      <button type="button" data-testid="x-research-toggle" onClick={() => setManualExpanded(!expanded)}
        className="w-full text-left" style={{ color: 'var(--color-ink)' }}>
        <strong>X 研究 · {headerWord}{note ? `（${note}）` : ''}</strong>
        <span style={{ float: 'right', color: 'var(--color-ink-faint)' }}>{expanded ? '收起' : '展开'}</span>
      </button>
      {snapshot && snapshot.objective &&
        <div data-testid="x-research-objective" style={OBJECTIVE_STYLE}>{snapshot.objective}</div>}
      {snapshot && <div data-testid="x-research-summary" style={SUMMARY_STYLE}>{summaryLine(snapshot)}</div>}
      {snapshot && <div data-testid="x-research-budget" style={BUDGET_STYLE}>{budgetLine(snapshot)}</div>}
      {/* 取消放在收起区之外：用户手动收起之后，运行中的那段研究仍然要停得下来。 */}
      {snapshot && state === 'running' &&
        <button type="button" data-testid="x-research-cancel" disabled={cancelling}
          onClick={() => { void cancelResearch(); }} style={CANCEL_STYLE}>
          {cancelling ? '取消中' : '取消研究'}
        </button>}
      {expanded && snapshot && (snapshot.search.length > 0 || snapshot.read.length > 0) &&
        <div data-testid="x-research-rows" style={ROWS_STYLE}>
          {snapshot.search.length > 0 &&
            <div data-testid="x-research-search">
              <div style={SECTION_HEADING_STYLE}>搜索</div>
              {snapshot.search.map(searchRowElement)}
            </div>}
          {snapshot.read.length > 0 &&
            <div data-testid="x-research-read" style={{ marginTop: 8 }}>
              <div style={SECTION_HEADING_STYLE}>读取</div>
              {snapshot.read.map(readRowElement)}
            </div>}
        </div>}
      {error && <div role="alert" data-testid="x-research-error" style={{ marginTop: 8 }}>{error}</div>}
    </section>
  );
}
