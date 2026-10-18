import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { XResearchStatus } from '../../../shared/xResearchStatus';
import type {
  XResearchCancelActor, XResearchTaskSnapshot, XResearchTaskState, XResearchWorkItem,
} from '../../../shared/xResearchTask';
import { useXResearchTaskStore, xResearchTaskSegments } from '../../stores/xResearchTaskStore';
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
const SEGMENT_HEADER_STYLE: CSSProperties = {
  display: 'flex', gap: 6, alignItems: 'baseline', whiteSpace: 'nowrap',
};
const SEGMENT_OBJECTIVE_STYLE: CSSProperties = {
  flex: '0 1 auto', minWidth: 0, color: 'var(--color-ink-soft)',
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

/** 收尾了却没有结论的行：进程被杀在中间（spec §4.4），它的计数只长到最后一次落盘，而快照又把它算进
 *  `*Done` 那一桶。卡头（`summaryLine`）与行内（`searchRowElement` / `readRowElement`）读的是同一
 *  条判据 —— 两个读者各写一份，迟早各自漂移。 */
function rowWithoutConclusion(row: XResearchWorkItem): boolean {
  return row.state === 'stopped' && row.status === null;
}

/** `stateReason` 只在它能解释状态时才当括注出现：「取消」+「被取消」是同一件事说两遍。
 *  `cancelledBy` 答的是「谁停的」（R81a）：用户没有按过取消时，卡面不许把模型自己停的写成无主语的
 *  「被取消」—— 两种主语各自有一句话，旧数据（没有这个字段）照旧说今天的措辞。
 *  不认识的词不进卡面：它是开放字符串，猜一句解释会把「有一份提交读不出来」说成用户动作。 */
function stateNote(reason: string | undefined, state: XResearchTaskState,
  cancelledBy?: XResearchCancelActor): string | null {
  if (!reason) return null;
  if (reason === 'cancelled') {
    if (cancelledBy === 'agent') return '模型中途取消';
    if (cancelledBy === 'user') return '你中途取消';
    return state === 'cancelled' ? null : '部分被取消';
  }
  if (reason === 'process_restarted') return '进程重启';
  if (reason === 'submission_unreadable') return '有提交记录读不出来';
  return null;
}

/** 卡头上的每个数字：同一回合里各段研究的权威计数**相加**，不取最大、不估算。
 *  键列在这里而不是 `for (const key in segments[0].counts)`：`counts` 多一个字段时，
 *  这份字面量会先编译失败，逼人决定它要不要进合计。 */
function groupCounts(segments: readonly XResearchTaskSnapshot[]): XResearchTaskSnapshot['counts'] {
  const total: XResearchTaskSnapshot['counts'] = {
    submissions: 0, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, interrupted: 0,
    posts: 0, replies: 0, articles: 0, undelivered: 0,
    searchDone: 0, searchTotal: 0, readDone: 0, readTotal: 0,
  };
  for (const segment of segments) {
    for (const key of Object.keys(total) as Array<keyof typeof total>) {
      total[key] += segment.counts[key];
    }
  }
  return total;
}

/** 摘要行：每个数字都是快照的权威字段 —— `counts.*` 由主进程按工作项分桶，
 *  `*Done/*Total` 是**按段**分好的同一份分桶（卡片不再自己数 `read.length`：那一读在运行中
 *  会被读成「20 个目标都读完了」）。一个回合里几段研究的数字逐项相加。
 *  一段的目标数是 0 时整段不出现：一次纯读取的研究不该在卡头写「搜索 0/0 个 query」。
 *  任何一段里有收尾却没有结论的行（`rowWithoutConclusion`）时整段也不出现：那一行的帖数 / 回复数停在
 *  最后一次落盘上（`收 N 帖` 漏了它），而 `*Done` 又把它算成收尾（`N/N` 说它已经有结论）。
 *  两个数字都是没人观测到的，那一节的结论只由行自己说（spec §4.4）。 */
function summaryLine(segments: readonly XResearchTaskSnapshot[]): string {
  const counts = groupCounts(segments);
  const parts: string[] = [];
  if (counts.searchTotal > 0 && !segments.some((segment) => segment.search.some(rowWithoutConclusion))) {
    parts.push(`搜索 ${counts.searchDone}/${counts.searchTotal} 个 query · 收 ${counts.posts} 帖`);
  }
  if (counts.readTotal > 0 && !segments.some((segment) => segment.read.some(rowWithoutConclusion))) {
    parts.push(`读取 ${counts.readDone}/${counts.readTotal} 个目标 · ${counts.replies} 回复`
      + ` · 文章 ${counts.articles} 篇`);
  }
  const head = parts.join(' ｜ ');
  const failed = counts.failed > 0 ? `失败 ${counts.failed}` : '';
  if (failed === '') return head;
  return head === '' ? failed : `${head} · ${failed}`;
}

/** 预算行取快照的 `usage` / `budget` 两个字段，口径就是 spec §5.3 与 §5.4 的那一对。
 *  一个回合里的几段研究各自有一份额度，合计是它们相加（与主进程按提交相加同一条规则）。 */
/** 段之间的结论不一致时（同一回合里「取消 → 重试成功」就是这种形状），卡头只挑优先级最高的那一个
 *  词，会把「这一回合最后是交付了的」藏进展开里 —— 与 R81a 要修的是同一类事：卡头不许与事实相左。
 *  这里不重算状态，只把各段已经得出的词数出来：`2 段：1 完成 / 1 取消`。全段同词时不补。 */
function mixedNote(segments: readonly XResearchTaskSnapshot[]): string | null {
  if (segments.length < 2) return null;
  const counts = new Map<XResearchTaskState, number>();
  for (const segment of segments) counts.set(segment.state, (counts.get(segment.state) ?? 0) + 1);
  if (counts.size < 2) return null;
  const parts = GROUP_STATE_ORDER
    .filter((state) => counts.has(state))
    .map((state) => `${counts.get(state)} ${STATE_WORD[state]}`);
  return `${segments.length} 段：${parts.join(' / ')}`;
}

function budgetLine(segments: readonly XResearchTaskSnapshot[]): string {
  let usageScrolls = 0;
  let usageExpand = 0;
  let budgetScrolls = 0;
  let budgetExpand = 0;
  for (const segment of segments) {
    usageScrolls += segment.usage.scrolls;
    usageExpand += segment.usage.expandActions;
    budgetScrolls += segment.budget.scrolls;
    budgetExpand += segment.budget.expandActions;
  }
  return `滚动 ${usageScrolls}/${budgetScrolls} · 展开 ${usageExpand}/${budgetExpand}`;
}

/** 卡头状态：按段聚合，优先级与主进程的 `xResearchTaskState` 是同一套
 *  （进行中 > 中断 > 取消 > 有失败 > 完成）。卡上不重新判定状态，只挑一个已经得出的词。 */
const GROUP_STATE_ORDER: readonly XResearchTaskState[] = [
  'running', 'interrupted', 'cancelled', 'failed', 'completed',
];
function groupState(segments: readonly XResearchTaskSnapshot[]): XResearchTaskState {
  for (const state of GROUP_STATE_ORDER) {
    if (segments.some((segment) => segment.state === state)) return state;
  }
  return segments[0].state;
}

/** 一个分段的头：圈号 + 该段终态（含 R81a 的取消归因）+ 该段的目标。
 *  空段（一行都没有）也要画这个头：段数要数得出来，而「这一段没有行」本身就是该段的结论。 */
function segmentElement(segment: XResearchTaskSnapshot, index: number) {
  const note = stateNote(segment.stateReason, segment.state, segment.cancelledBy);
  return (
    <div key={segment.researchRunId} data-testid="x-research-segment" data-status={segment.state}
      style={{ marginTop: index === 0 ? 0 : 10 }}>
      <div style={SEGMENT_HEADER_STYLE}>
        <span style={MARK_STYLE}>{numberMark(index)}</span>
        <span style={SOFT_STYLE}>{STATE_WORD[segment.state]}{note ? `（${note}）` : ''}</span>
        <span className="truncate" title={segment.objective}
          style={SEGMENT_OBJECTIVE_STYLE}>{segment.objective}</span>
      </div>
      {segment.search.length > 0 &&
        <div data-testid="x-research-search" style={{ marginTop: 6 }}>
          <div style={SECTION_HEADING_STYLE}>搜索</div>
          {segment.search.map(searchRowElement)}
        </div>}
      {segment.read.length > 0 &&
        <div data-testid="x-research-read" style={{ marginTop: 8 }}>
          <div style={SECTION_HEADING_STYLE}>读取</div>
          {segment.read.map(readRowElement)}
        </div>}
    </div>
  );
}

/**
 * 搜索行：query + 产品 + 状态 + `收 N 帖`（`budgetUsage.distinctEntries` 的去重帖数）
 * + `略过 N 条`（`sampleTruncation.omitted`，只在 >0 时有内容）+ `N 页响应`（被接纳的网络页数 ——
 * 「响应」写全是因为 `N 页` 会被读成「翻了几屏」，而这里数的是一份 GraphQL 响应）。
 * 每条都来自行自己的字段；行还没起跑（`queued`）时一个数字都不说 —— 「收 0 帖」会被读成结论。
 * `interrupted` 的行也一样：`stopped` + `status: null` 是「进程被杀在中间」的形，它的计数只长到
 * 最后一次落盘 / 最后一次进度回调，拿它当结论就会写出「收 0 帖」这种没人观测到的数（spec §4.4）。
 */
function searchRowElement(row: XResearchWorkItem, index: number) {
  const started = row.state !== 'queued';
  // 有结论的收尾行才谈数字：`stopped` 而没有 `status` 的那一类只能说「中断」。
  const counted = started && !rowWithoutConclusion(row);
  return (
    <div key={row.workItemId} data-testid="x-research-row" data-section="search" style={ROW_STYLE}>
      <span style={MARK_STYLE}>{numberMark(index)}</span>
      <span className="truncate" title={row.label} style={ROW_LABEL_STYLE}>{row.label}</span>
      {row.product && <span data-testid="x-research-row-product" style={SOFT_STYLE}>{row.product}</span>}
      <span style={SOFT_STYLE}>{rowStateWord(row)}</span>
      {counted && <span style={SOFT_STYLE}>收 {row.posts} 帖</span>}
      {counted && row.omitted > 0 && <span style={SOFT_STYLE}>略过 {row.omitted} 条</span>}
      {counted && row.pages > 0 && <span style={SOFT_STYLE}>{row.pages} 页响应</span>}
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
  // `stopped` + `status: null` = 进程被杀留下的那一类：行自己已经说「中断」，它的根帖与回复数
  // 停在最后一次落盘上，再说「无根帖」就是拿残缺的计数当结论（spec §4.4）。
  const counted = started && !rowWithoutConclusion(row);
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
      {counted && row.hasRoot && <span style={SOFT_STYLE}>根帖 + {row.replies} 回复</span>}
      {/* 收尾了还没拿到根帖才是「无根帖」；还在飞的时候只是「还没拿到」，不能这么说。 */}
      {counted && !row.hasRoot && row.state === 'stopped' && <span style={SOFT_STYLE}>无根帖</span>}
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
 * 「X 研究」的过程卡片（spec §5.3）：**一个回合一张卡**（R81b）。卡跟着一个回合走，里面按
 * `createdAt` 升序列出这个回合的每一段研究（分段头 = 圈号 + 该段终态 + 目标），数据源是渲染层
 * store 里的快照：挂载时用 `xResearch.taskGet` 把锚点提到的那几段补齐，之后
 * `xResearch.taskUpdated` 广播（bootstrap 那条线）会逐段更新到 store 里。另有两种「取不到」不应当成
 * 结论，各自补取一次：服务还没接上（`research.unavailable`）与 store 里那几段取到之后又消失（见
 * 下面两条 effect）。运行中默认展开、进终态自动收起，用户手动点过之后以点击为准。
 */
export function XResearchProgressCard({ threadId, groupKey, researchRunIds }: {
  threadId: string; groupKey: string; researchRunIds: readonly string[];
}) {
  const snapshotsByRunId = useXResearchTaskStore((state) => state.snapshotsByRunId);
  const upsert = useXResearchTaskStore((state) => state.upsert);
  // 一张卡的内容就是这个回合里的全部研究，按创建时间排：广播照旧一段一段地到，
  // 每一段只替换它自己那一格，卡的次序因此在运行中不会跳。
  const segments = useMemo(
    () => xResearchTaskSegments(snapshotsByRunId, groupKey), [snapshotsByRunId, groupKey]);
  // `null` = 还没点过，跟着状态走；一旦点过就永远以这一份布尔为准（不再随状态自动收放）。
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `research.not_found`：这几段研究都不在了（被删了，或它不属于正看着的对话/窗口/标签页）。
  // 不是错误，也不该把卡永远停在「读取中」—— 记一笔，卡头改说「记录不可用」。
  const [gone, setGone] = useState(false);
  // `research.unavailable`：这个进程里还没有任务服务（x research 的开关默认关闭）。
  // **它不是一个结论**：服务接上之后同一个 id 就能取到，所以不 latch、卡停在「读取中」、
  // 等 store 里出现这组的快照时再取一次（见下面那条补取的 effect）。
  const [unavailable, setUnavailable] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // 这次挂载里已经拿到过这组里的快照（只有「有 → 没有」的转变才有补取可言）。
  const sawSnapshot = useRef(false);
  // 已经为「段从 store 里消失」补取过一次：只补一次，真被删掉的研究不会变成死循环。
  const refetchedAfterLoss = useRef(false);
  // 名单的键：同一组的研究还是那几个时不给 effect 换身份（数组字面量每次都换）。
  const researchKey = researchRunIds.join(',');

  /** 把锚点提到的那几段研究的快照取回来并落进 store。挂载、换组、以及下面两条补取都走这一处。
   *  只把**全部**答 `research.not_found` 读成「记录不可用」：一组里少了一段，其余几段照常画。 */
  async function loadSnapshots(isActive: () => boolean): Promise<void> {
    let found = 0;
    let notFound = 0;
    let unwired = false;
    let failure: unknown = null;
    for (const researchRunId of researchRunIds) {
      try {
        const value = await window.kydog.invoke('xResearch.taskGet', { threadId, researchRunId });
        if (!isActive()) return;
        found += 1;
        upsert(value);
      } catch (reason) {
        if (!isActive()) return;
        const code = (reason as { code?: string } | null)?.code;
        // 研究已经被删掉不是错误：卡跟着那条记录一起消失，不该在会话里留一条红字。
        if (code === 'research.not_found') { notFound += 1; continue; }
        // 服务没接上：不 latch（latch 了就变成「记录不可用」永驻），交给下面那条补取。
        if (code === 'research.unavailable') { unwired = true; continue; }
        failure = reason;
      }
    }
    if (!isActive()) return;
    if (found > 0) {
      sawSnapshot.current = true;
      setUnavailable(false);
      // 「记录不可用」也要撤：`research.not_found` 对「这个窗口没在看该对话」只是一个瞬时事实，
      // 取到一次就把这个永久锁清掉 —— 否则下一次段从池里消失时它会以「记录不可用」重新露出来。
      setGone(false);
    } else if (unwired) {
      setUnavailable(true);
    } else if (researchRunIds.length > 0 && notFound === researchRunIds.length) {
      setGone(true);
    }
    if (failure !== null) setError(errorText(failure));
  }

  useEffect(() => {
    let active = true;
    // 两个记号跟着这一组研究走：换组之后，「拿到过 / 补过一次」重新算。
    sawSnapshot.current = false;
    refetchedAfterLoss.current = false;
    void loadSnapshots(() => active);
    return () => { active = false; };
  }, [threadId, groupKey, researchKey, upsert]);

  // 补取：两条触发条件都读 store 里这组快照的「有无」，所以共用一个 effect。
  //  · 上一轮答 `research.unavailable` 之后，store 里却出现了这组的快照 —— 服务接上了，再问一次；
  //  · 取到过之后又消失了（`taskList` 的整批替换可能在这几段研究落盘之前就扫完，于是删掉它没见过的行）。
  //    卡是被消息块锚住的，等不到 store 再叫它，只有这里补一次。
  // 两者不会互相打架：快照不在时只走「消失之后补一次」，它不看 `unavailable`；
  // 快照在时只走「服务接上了补一次」，它不动 `refetchedAfterLoss` 那个一次性记号 ——
  // 于是未接线的服务不会把「行丢了再取一次」这一次机会用掉，反之亦然。
  // 依赖取 store 里那一组对象（不是另开一条通道，也不是计时器）：它只在 store 写入新快照时换身份，
  // 出现与消失都在里面。「`revision` 变了」单靠自己也说得出出现，说不出消失 —— 所以不用它当键。
  useEffect(() => {
    let active = true;
    if (segments.length > 0) {
      if (unavailable) void loadSnapshots(() => active);
    } else if (sawSnapshot.current && !gone && !refetchedAfterLoss.current) {
      refetchedAfterLoss.current = true;
      void loadSnapshots(() => active);
    }
    return () => { active = false; };
  }, [segments, unavailable, gone]);

  /** 取消**整张卡**：确认一次，然后把这个回合里还在排队/进行中的每一段都停下。
   *  RPC 仍是**按研究**的（取消是每段研究自己的控制），这里只是把 id 逐个发出去。 */
  async function cancelRun(): Promise<void> {
    const targets = segments
      .filter((segment) => segment.counts.queued + segment.counts.running > 0)
      .map((segment) => segment.researchRunId);
    const confirmed = await confirm({
      title: '取消这段 X 研究？',
      message: '已收集的帖子与已读的帖子会保留；排队中与进行中的工作会停下，之后不能在这些研究上续跑。',
      confirmLabel: '取消研究',
    });
    if (!confirmed) return;
    setCancelling(true);
    try {
      // 逐段发、逐段写回快照：并发发出去的两份回执可能乱序，卡会按 revision 丢掉旧的那份。
      for (const researchRunId of targets) {
        upsert(await window.kydog.invoke('xResearch.taskCancel', { threadId, researchRunId }));
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setCancelling(false);
    }
  }

  const state = segments.length > 0 ? groupState(segments) : undefined;
  // 卡头括注取**决定这个状态的那一段**：一段研究时就是它自己，几段时是优先级最高的那一段。
  const deciding = state === undefined ? undefined
    : segments.find((segment) => segment.state === state) ?? segments[0];
  const note = deciding ? stateNote(deciding.stateReason, deciding.state, deciding.cancelledBy) : null;
  // 几段的结论不一致时，卡头补一句「N 段：…」，否则「取消后重试成功」的回合只看得到「取消」。
  const mixed = mixedNote(segments);
  const headerNote = [note, mixed].filter((part): part is string => part !== null).join('，');
  const expanded = manualExpanded ?? (state === 'running');
  // 有快照时仍以快照为准（「不在这个窗口的标签页」那一条也可能带着广播来的快照）。
  const status = state ?? (gone ? 'missing' : 'loading');
  const headerWord = state ? STATE_WORD[state] : (gone ? '记录不可用' : '读取中');
  // 卡头副标题是**最早一段**研究的目标（R10）：合并不能让卡头换题。
  const objective = segments[0]?.objective ?? '';
  // 一段行都没有时这一行没东西可说（空串），不画一个空 div。
  const summary = segments.length > 0 ? summaryLine(segments) : '';
  const cancellable = segments.some((segment) => segment.counts.queued + segment.counts.running > 0);

  return (
    <section data-testid="x-research-card" data-status={status}
      className="ky-paper-deep font-sans" style={CARD_STYLE}>
      <button type="button" data-testid="x-research-toggle" onClick={() => setManualExpanded(!expanded)}
        className="w-full text-left" style={{ color: 'var(--color-ink)' }}>
        <strong>X 研究 · {headerWord}{headerNote ? `（${headerNote}）` : ''}</strong>
        <span style={{ float: 'right', color: 'var(--color-ink-faint)' }}>{expanded ? '收起' : '展开'}</span>
      </button>
      {objective !== '' &&
        <div data-testid="x-research-objective" style={OBJECTIVE_STYLE}>{objective}</div>}
      {summary !== '' &&
        <div data-testid="x-research-summary" style={SUMMARY_STYLE}>{summary}</div>}
      {segments.length > 0 &&
        <div data-testid="x-research-budget" style={BUDGET_STYLE}>{budgetLine(segments)}</div>}
      {/* 取消放在收起区之外：用户手动收起之后，运行中的那几段研究仍然要停得下来。
          判据是**队列里还有没有活**，不是状态词：`interrupted` 是黏的（一份失败的提交就把它留在盘上），
          而一段刚追加了工作、正在采集的研究会因为那个词被判成中断 —— 卡收起、取消入口消失，
          用户于是没有办法停下它。`counts.queued + counts.running` 就是「还有活」的可执行形式。 */}
      {cancellable &&
        <button type="button" data-testid="x-research-cancel" disabled={cancelling}
          onClick={() => { void cancelRun(); }} style={CANCEL_STYLE}>
          {cancelling ? '取消中' : '取消研究'}
        </button>}
      {expanded && segments.length > 0 &&
        <div data-testid="x-research-rows" style={ROWS_STYLE}>
          {segments.map(segmentElement)}
        </div>}
      {error && <div role="alert" data-testid="x-research-error" style={{ marginTop: 8 }}>{error}</div>}
    </section>
  );
}
