import { useEffect, useRef, useState, type CSSProperties } from 'react';
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
 *  会被读成「20 个目标都读完了」）。
 *  一段的目标数是 0 时整段不出现：一次纯读取的研究不该在卡头写「搜索 0/0 个 query」。 */
function summaryLine(snapshot: XResearchTaskSnapshot): string {
  const { counts } = snapshot;
  const parts: string[] = [];
  if (counts.searchTotal > 0) {
    parts.push(`搜索 ${counts.searchDone}/${counts.searchTotal} 个 query · 收 ${counts.posts} 帖`);
  }
  if (counts.readTotal > 0) {
    parts.push(`读取 ${counts.readDone}/${counts.readTotal} 个目标 · ${counts.replies} 回复`
      + ` · 文章 ${counts.articles} 篇`);
  }
  const head = parts.join(' ｜ ');
  const failed = counts.failed > 0 ? `失败 ${counts.failed}` : '';
  if (failed === '') return head;
  return head === '' ? failed : `${head} · ${failed}`;
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
  // `article === 'pending'` 说的是「要了、还没取到」。只有真在飞的那一行才是进行时的「请求中」：
  // 排队行说义务（`待取`），收尾行说的是它没走到取文章那一步（`concludeRow` 不收尾这个字段），
  // 对着一行已经有结论的行说「请求中」等于承诺一件再也不会发生的事。
  const articleWord = row.article === 'pending' && !active ? '待取' : ARTICLE_WORD[row.article];
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
 * 会把它更新到 store 里。另有两种「取不到」不应当成结论，各自补取一次：
 * 服务还没接上（`research.unavailable`）与 store 里那一行取到之后又消失（见下面两条 effect）。
 * 运行中默认展开、进终态自动收起，用户手动点过之后以点击为准。
 */
export function XResearchProgressCard({ threadId, researchRunId }: {
  threadId: string; researchRunId: string;
}) {
  const snapshot = useXResearchTaskStore((state) => state.snapshotsByRunId[researchRunId]);
  const upsert = useXResearchTaskStore((state) => state.upsert);
  // `null` = 还没点过，跟着状态走；一旦点过就永远以这一份布尔为准（不再随状态自动收放）。
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `research.not_found`：这段研究不在（被删了，或它不属于正看着的对话/窗口/标签页）。
  // 不是错误，也不该把卡永远停在「读取中」—— 记一笔，卡头改说「记录不可用」。
  const [gone, setGone] = useState(false);
  // `research.unavailable`：这个进程里还没有任务服务（x research 的开关默认关闭）。
  // **它不是一个结论**：服务接上之后同一个 id 就能取到，所以不 latch、卡停在「读取中」、
  // 等 store 里出现这份 run 的快照时再取一次（见下面那条补取的 effect）。
  const [unavailable, setUnavailable] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // 这次挂载里已经拿到过这份 run 的快照（只有「有 → 没有」的转变才有补取可言）。
  const sawSnapshot = useRef(false);
  // 已经为「行从 store 里消失」补取过一次：只补一次，真被删掉的研究不会变成死循环。
  const refetchedAfterLoss = useRef(false);

  /** 取一次这份研究的快照并落进 store。挂载、换 run、以及下面两条补取都走这一处。 */
  async function loadSnapshot(isActive: () => boolean): Promise<void> {
    try {
      const value = await window.kydog.invoke('xResearch.taskGet', { threadId, researchRunId });
      if (!isActive()) return;
      sawSnapshot.current = true;
      setUnavailable(false);
      upsert(value);
    } catch (reason) {
      if (!isActive()) return;
      const code = (reason as { code?: string } | null)?.code;
      // 研究已经被删掉不是错误：卡跟着那条记录一起消失，不该在会话里留一条红字。
      if (code === 'research.not_found') { setGone(true); return; }
      // 服务没接上：不 latch（latch 了就变成「记录不可用」永驻），交给下面那条补取。
      if (code === 'research.unavailable') { setUnavailable(true); return; }
      setError(errorText(reason));
    }
  }

  useEffect(() => {
    let active = true;
    // 两个记号跟着这一段 run 走：换 run 之后，「拿到过 / 补过一次」重新算。
    sawSnapshot.current = false;
    refetchedAfterLoss.current = false;
    void loadSnapshot(() => active);
    return () => { active = false; };
  }, [threadId, researchRunId, upsert]);

  // 补取：两条触发条件都读 store 里这份快照的「有无」，所以共用一个 effect。
  //  · 上一轮答 `research.unavailable` 之后，store 里却出现了这份 run 的快照 —— 服务接上了，再问一次；
  //  · 取到过之后又消失了（`taskList` 的整批替换可能在这条研究落盘之前就扫完，于是删掉它没见过的那一行）。
  //    卡是被消息块锚住的，等不到 store 再叫它，只有这里补一次。
  // 两者不会互相打架：快照不在时只走「消失之后补一次」，它不看 `unavailable`；
  // 快照在时只走「服务接上了补一次」，它不动 `refetchedAfterLoss` 那个一次性记号 ——
  // 于是未接线的服务不会把「行丢了再取一次」这一次机会用掉，反之亦然。
  // 依赖就取 store 里那一份对象本身（不是另开一条通道，也不是计时器）：它只在 store 写入新快照时换
  // 身份，出现与消失都在里面。「`revision` 变了」单靠自己也说得出出现，说不出消失 ——
  // 所以这里不用 `revision` 当键。两个标记也不进依赖：它们只是「这一刻该怎么读」的旗，
  // 变了不需要动作，要等 store 里那一行再变。
  useEffect(() => {
    let active = true;
    if (snapshot !== undefined) {
      if (unavailable) void loadSnapshot(() => active);
    } else if (sawSnapshot.current && !gone && !refetchedAfterLoss.current) {
      refetchedAfterLoss.current = true;
      void loadSnapshot(() => active);
    }
    return () => { active = false; };
  }, [snapshot]);

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
  // 有快照时仍以快照为准（「不在这个窗口的标签页」那一条也可能带着广播来的快照）。
  const status = state ?? (gone ? 'missing' : 'loading');
  const headerWord = state ? STATE_WORD[state] : (gone ? '记录不可用' : '读取中');
  // 两段都是 0 行时这一行没东西可说（空串），不画一个空 div。
  const summary = snapshot ? summaryLine(snapshot) : '';

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
      {summary !== '' &&
        <div data-testid="x-research-summary" style={SUMMARY_STYLE}>{summary}</div>}
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
