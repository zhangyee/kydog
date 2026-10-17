// `x_research` 的任务 service（spec §4.3–§4.7、§5.3）：提交、per-thread 串行队列、状态推进。
//
// 它只做「把工作排起来、把工作项的状态说准、把结果留在盘上」：真正碰浏览器的执行体由
// `deps.runWork` 注入（Task 4 的 runner），交付由 `wait` 负责（Task 5）。这样这一层可以在
// 一条用例里用假工作体跑完，不需要 DOM 也不需要浏览器。
import { randomUUID } from 'node:crypto';
import { KydogError } from '../../shared/errors';
import { logger } from '../log';
import type {
  XResearchSection, XResearchSubmission, XResearchTaskRecord, XResearchTaskSnapshot,
  XResearchTaskState, XResearchWorkItem,
} from '../../shared/xResearchTask';
import { X_RESEARCH_FAILURE_STATUSES, xResearchTaskSnapshot, xResearchTaskState } from '../../shared/xResearchTask';
import type { XResearchStatus, XStopReason } from '../../shared/xResearchStatus';
import type { XResearchTaskStore } from './xResearchTaskStore';
import type { XResearchArtifactStore } from './xResearchArtifacts';
import { clipForEnvelope, pickDelivery } from './xResearchDeliver';
import type { XResearchDelivery, XResearchDeliveryEnvelope } from './xResearchTaskShell';
import { serializeXResearchResult } from './xResearchOutput';
import type {
  XArticleFacts, XReadObservation, XReadRequest, XResearchResult, XSearchObservation, XSearchRequest,
} from './xResearchTypes';
import type { XBudgetPolicy } from './xResearchBudget';
import type { XResearchProgressEvent } from './xResearchSearch';

/** 进度事件归采集层（它知道自己在哪一段）：任务侧只消费，不另写一份形状。 */
export type { XResearchProgressEvent };

export type XResearchTaskOwner = {
  threadId: string; runId: string; projectRoot: string;
  /** 会话侧账本的不透明身份（`sessionFactory` 的 per-session 对象）：拆除时只认领自己那一份 ——
   *  同一个 threadId 上重新发布的替换会话是另一个对象，它的在飞研究与缓存都不该被旧会话带走。 */
  ledger?: object;
};

/** 一次提交的工作：一组 query（search）或一组目标（read），与 `XResearchInput` 的两支同形。
 *  `budgetPolicy` 由提交时从**原始参数**算出（`resolveXBudgetPolicy` 看的是「这个键写没写」）：
 *  到这一层只剩数值，采集层自己推会把每个省缺的预算都说成 `explicit` —— 一句关于请求的假话。 */
export type XResearchWorkRequest = {
  search: XSearchRequest; budgetPolicy?: XBudgetPolicy;
} | {
  read: XReadRequest; budgetPolicy?: XBudgetPolicy;
};

export type XResearchWorkContext = {
  threadId: string;
  researchRunId: string;
  submissionId: string;
  batchId: string;
  runId: string;
  /** 提交那一轮的 `callId`：结果里写的就是它，交付壳在恢复时据此与结果对上（Task 7）。 */
  submitCallId: string;
  signal: AbortSignal;
  /** 任务的标签页（spec §4.3「任务记自己的 browserTabId」）：读写都落在 `record.browserTabId` 上，
   *  下一次提交因此复用同一个标签页。改它是内存转移，随这一轮的收尾落盘。 */
  tabBinding: { get(): string | undefined; set(tabId: string | undefined): void };
  onProgress: (event: XResearchProgressEvent) => void;
};

export type XResearchRunWork = (
  work: XResearchWorkRequest,
  ctx: XResearchWorkContext,
) => Promise<XResearchResult>;

export type XResearchTaskServiceDeps = {
  store: XResearchTaskStore;
  runWork: XResearchRunWork;
  onUpdate: (snapshot: XResearchTaskSnapshot) => void;
  /** 交付用的工件根（Task 7 换成双根）：重启后交付要按提交记录里的 ref 把结果读回来（R20）。 */
  artifacts: (threadId: string, researchRunId: string) => XResearchArtifactStore;
  now?: () => string;
};

export type XResearchSubmitInput = {
  researchRunId?: string;
  work: XResearchWorkRequest;
  /** 覆盖任务的标签页（缺省沿用任务已有的那个；都不给就由采集层自己开）。 */
  tabId?: string;
};

export type XResearchSubmitResult = {
  researchRunId: string;
  submissionId: string;
  snapshot: XResearchTaskSnapshot;
};

/** `wait` 的产物：这一轮的快照、交付的那一份（可能没有）、以及还没交付的清单。
 *  壳的构造与 1 MiB 定点归 `./xResearchDeliver`（它只管字节，不碰任务状态）。 */
export type XResearchWaitResult = {
  snapshot: XResearchTaskSnapshot;
  delivery: XResearchDelivery | null;
  undelivered: NonNullable<XResearchDeliveryEnvelope['undelivered']>;
};

export type XResearchInspectView = 'rows' | 'deliveries' | 'failures';

export type XResearchInspectInput = {
  view: XResearchInspectView;
  /** 不透明的偏移记号（spec §九 把编码留给实现）：读不懂就拒绝，不静默从头发一页。 */
  cursor?: string;
  pageSize?: number;
};

/** `rows` 的一行：工作项原样给出，加上它属于哪次提交、是那次里的第几项。
 *  行明细在快照里也有（卡片走快照），这里给的是**带提交身份**的那一份。 */
export type XResearchInspectRow = {
  kind: 'work_item';
  submissionId: string;
  operation: 'search' | 'read';
  index: number;
  item: XResearchWorkItem;
};

/** `deliveries` 的一行：提交级的交付权威（`deliveredAt` / `deliveryCallId`）与工件有没有落盘。
 *  快照故意不带这层数据（它按工作项分桶），所以 `inspect` 是看它唯一的地方。 */
export type XResearchInspectDelivery = {
  kind: 'delivery';
  submissionId: string;
  operation: 'search' | 'read';
  objective: string;
  state: XResearchSubmission['state'];
  endedAt: string | null;
  deliveredAt: string | null;
  deliveryCallId: string | null;
  hasArtifact: boolean;
};

/** `failures` 的一行：只给结论（要看整行走 `rows`）。判据是快照「有失败」用的同一个集合。 */
export type XResearchInspectFailure = {
  kind: 'failure';
  submissionId: string;
  operation: 'search' | 'read';
  index: number;
  label: string;
  status: XResearchStatus;
  stopReason: XStopReason | null;
  reason: string | null;
};

export type XResearchInspectItem = XResearchInspectRow | XResearchInspectDelivery | XResearchInspectFailure;

/** 一页：快照 + 这一页的条目（+ 下一页的游标）。`snapshot` 让调用方不必再 `get` 一次。 */
export type XResearchInspectResult = {
  snapshot: XResearchTaskSnapshot;
  items: XResearchInspectItem[];
  nextCursor?: string;
};

const X_INSPECT_DEFAULT_PAGE_SIZE = 20;
const X_INSPECT_MAX_PAGE_SIZE = 50;

function encodeInspectCursor(offset: number): string {
  return `o${offset}`;
}
function decodeInspectCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const matched = /^o(\d+)$/.exec(cursor);
  if (!matched) throw new Error('x_research inspect: invalid cursor');
  return Number(matched[1]);
}
function inspectPageSize(raw: number | undefined): number {
  if (raw === undefined) return X_INSPECT_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(raw) || raw < 1) throw new Error('x_research inspect: pageSize must be a positive integer');
  return Math.min(raw, X_INSPECT_MAX_PAGE_SIZE);
}

const X_WAIT_ABORTED = 'X research wait aborted';

/** 等一个 promise，但**中止信号一响就当场放手**（与 `webResearchTools.waitUnlessAborted` 同一语义）。
 *  pi 的回合被停掉时 `wait` 必须立刻收场，否则一次等待会挂到整条队列排空 —— 20 个目标的 read
 *  是几分钟。中止的回合**不交付**：`deliveredAt` 一写就等于把结果交给了没人接的那一侧，所以拒绝
 *  发生在选中与标记之前 —— 中止不消费交付。 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new KydogError('agent.aborted', X_WAIT_ABORTED));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(new KydogError('agent.aborted', X_WAIT_ABORTED));
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/** 已中止就当场拒绝。`abortable` 只护住「等」的那一段；交付路径上还有两个真实 await ——
 *  重启后首次 `open` 读盘与 `deliverable` 读工件 —— 它们都在写 `deliveredAt` 之前，中止落在
 *  那里时不复查就会「标了却没人接」。两次复查都在 mark 之前，所以不会造出「标了却没交出去」。 */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new KydogError('agent.aborted', X_WAIT_ABORTED);
}

/** 一个研究在本进程里的活状态。盘上只有落盘边界那一刻的副本，实时数字只在这里。 */
type ActiveResearch = {
  record: XResearchTaskRecord;
  submissions: Map<string, XResearchSubmission>;
  /** 收尾那一刻的结果（`settle` 用来写结论的那一份，与交付出去的是同一份字节）。
   *  只在这个进程里有效：重启后靠提交记录上的工件 ref 读回来（R20）。 */
  results: Map<string, XResearchResult>;
  controller: AbortController;
  /** 这段研究被 `cancel` 过：之后排队的提交不再起跑、在飞的那一份按取消收尾。
   *  跨重启的一致性靠盘上的 `state` / `stateReason`（见 `submit`），这个标记只管本进程的窗口。 */
  cancelRequested: boolean;
  /** 这段研究所在的会话被拆掉了：排队的提交不再起跑，在飞的那一份按**中断**收尾（不是用户取消）——
   *  用户按停止是 `cancelRequested`，两者在盘上留下的结论不同（`cancelled` vs `interrupted`）。 */
  disposed: boolean;
  /** 谁最后一次把工作提交进这段研究（会话侧账本身份）。拆除时据此只中断自己那一份。 */
  ledger?: object;
  /** 每份提交自己的执行体（`enqueue` 排上链时就记下、跑完就删）。`cancel` 等的是**在飞那一份
   *  自己**的收尾 —— 等整条 thread 链会让同一 thread 上另一段研究排在后头的采集把 cancel 绑住。 */
  pending: Map<string, Promise<void>>;
};

/** 「收 N 帖」= 去重后接纳的帖子数，不是保留的观测条数；`另省 N` 取采样省略数。
 *  每个数字都来自这一行自己的字段，没有任何估算。 */
function copyRowFacts(workItem: XResearchWorkItem, row: XSearchObservation | XReadObservation): void {
  workItem.scrolls = row.budgetUsage.scrolls;
  workItem.expandActions = row.budgetUsage.expandActions;
  workItem.pages = (row.networkPages?.length ?? 0) + (row.networkPagesOmitted ?? 0);
  if ('query' in row) {
    workItem.posts = row.budgetUsage.distinctEntries;
    workItem.omitted = row.sampleTruncation?.omitted ?? 0;
    return;
  }
  workItem.hasRoot = row.root !== null;
  // 回复只算回复区：`unscopedPosts` 是没证明属于这个讨论的帖子（spec §5.4）。
  workItem.replies = row.replies.observations.length;
  workItem.article = articleState(row.article);
}

/** 文章四态（spec §5.4）：请求里没要 → 没要；拿到正文 → body；撞了 barrier → failed；
 *  只看到入口 → entry；其余（报了要、还没走到任何一步）→ pending。 */
function articleState(article: XArticleFacts): XResearchWorkItem['article'] {
  if (!article.requested) return 'not_requested';
  if (article.bodyObserved) return 'body';
  if (article.barrier) return 'failed';
  if (article.entryObserved || article.entry) return 'entry';
  return 'pending';
}

/** 行停下来的那一刻才有结论：`status` / `stopReason` / `reason` 是它的结论。 */
function concludeRow(workItem: XResearchWorkItem, row: XSearchObservation | XReadObservation): void {
  copyRowFacts(workItem, row);
  workItem.state = 'stopped';
  workItem.phaseDetail = null;
  workItem.status = row.status;
  workItem.stopReason = row.stopReason;
  workItem.reason = 'reason' in row ? row.reason : row.barrier?.reason ?? null;
}

/** 提交级用量取自它自己的工作项（与快照同一批数字，不另算一遍）：read 行不计 `posts`，
 *  否则一次读取会让卡头的「收 N 帖」多出帖子数。 */
function usageOf(workItems: readonly XResearchWorkItem[]): XResearchSubmission['usage'] {
  const usage: XResearchSubmission['usage'] = { posts: 0, scrolls: 0, expandActions: 0 };
  for (const workItem of workItems) {
    if (workItem.section === 'search') usage.posts += workItem.posts;
    usage.scrolls += workItem.scrolls;
    usage.expandActions += workItem.expandActions;
  }
  return usage;
}

function queuedWorkItem(section: XResearchSection, label: string,
  product: 'Top' | 'Latest' | null): XResearchWorkItem {
  return {
    workItemId: randomUUID(), section, label, product, state: 'queued', phaseDetail: null,
    status: null, stopReason: null, reason: null, posts: 0, omitted: 0, pages: 0,
    hasRoot: false, replies: 0, article: 'not_requested', scrolls: 0, expandActions: 0,
  };
}

/** 把一次请求展开成有序工作项：顺序就是采集循环的顺序（search 按 query、read 按 target）。
 *  预算取「本次提交各上限之和」（spec §6.7）：5 个 query × 500 滚动 + 20 个目标 × 500 = 12500。 */
function planWork(work: XResearchWorkRequest): {
  operation: XResearchSubmission['operation'];
  objective: string;
  budget: XResearchSubmission['budget'];
  workItems: XResearchWorkItem[];
} {
  if ('search' in work) {
    const { objective, queries, maxScrollsPerQuery } = work.search;
    return {
      operation: 'search',
      objective,
      budget: { scrolls: maxScrollsPerQuery * queries.length, expandActions: 0 },
      workItems: queries.map((query) => queuedWorkItem('search', query.query, query.product)),
    };
  }
  const { objective, targets, includeArticle, maxScrollsPerPost, maxExpandActionsPerPost } = work.read;
  return {
    operation: 'read',
    objective,
    budget: {
      scrolls: maxScrollsPerPost * targets.length,
      expandActions: maxExpandActionsPerPost * targets.length,
    },
    workItems: targets.map((target): XResearchWorkItem => ({
      // 没有 url 的目标就是那条 postId：采集层「从不生成 permalink」，这里也不造一个。
      ...queuedWorkItem('read', target.url ?? target.postId, null),
      // 请求里说过要不要文章：这不是估算，是这次提交声明过的义务。
      article: includeArticle ? 'pending' : 'not_requested',
    })),
  };
}

/** 研究任务：提交进盘、per-thread 串行执行、状态推进、快照推送。 */
export class XResearchTaskService {
  private readonly active = new Map<string, ActiveResearch>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: XResearchTaskServiceDeps) {}

  private key(threadId: string, researchRunId: string): string {
    return `${threadId}/${researchRunId}`;
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  /** 从盘上读（或取内存里的）一个研究。`readTask` 把「文件不在」与「文件坏了」都当 `null`。 */
  private async open(threadId: string, researchRunId: string): Promise<ActiveResearch | null> {
    const key = this.key(threadId, researchRunId);
    const cached = this.active.get(key);
    if (cached) return cached;
    const record = await this.deps.store.readTask(threadId, researchRunId);
    if (!record) return null;
    const submissions = await this.deps.store.listSubmissions(threadId, researchRunId);
    const opened: ActiveResearch = {
      record,
      // 插入序 = 提交序（`listSubmissions` 按 createdAt 排），`objective` 取的是第一份。
      submissions: new Map(submissions.map((submission) => [submission.submissionId, submission])),
      // 上一个进程手里的结果已经随进程消失：这里只可能是空的，要交付就回到工件（R20）。
      results: new Map(),
      controller: new AbortController(),
      cancelRequested: false,
      disposed: false,
      ledger: undefined,
      pending: new Map(),
    };
    this.active.set(key, opened);
    // 「进行中」只可能来自一个已经不在的进程：`open` 读盘的前提就是这条研究没有内存活副本。
    if (record.state === 'running') await this.repairRestarted(opened);
    return opened;
  }

  /** 崩溃后的诚实表示（spec §4.4）：盘上写着「进行中」= 写它的那个进程在两个边界之间被杀。
   *  未收尾的提交按中断收尾（复用 `interrupt` / `project`，不另写一份状态规则），再落一次盘 ——
   *  否则同一个「进行中」在每次重开时都会被当成最新状态读回来。 */
  private async repairRestarted(active: ActiveResearch): Promise<void> {
    const unsettled = [...active.submissions.values()]
      .filter((submission) => submission.state === 'queued' || submission.state === 'running');
    for (const submission of unsettled) this.interrupt(submission);
    // 落盘失败在这里只能放弃：这条研究下一次打开时会再修一次，而 `get` 不该因为修复写失败而不回答。
    await this.persist(active, unsettled, unsettled.length ? 'process_restarted' : undefined)
      .catch(() => undefined);
  }

  private create(owner: XResearchTaskOwner, researchRunId: string): ActiveResearch {
    const now = this.now();
    const created: ActiveResearch = {
      record: {
        version: 1, researchRunId, threadId: owner.threadId, projectRoot: owner.projectRoot,
        createdAt: now, updatedAt: now, revision: 0, state: 'running', submissionIds: [],
      },
      submissions: new Map(),
      results: new Map(),
      controller: new AbortController(),
      cancelRequested: false,
      disposed: false,
      ledger: owner.ledger,
      pending: new Map(),
    };
    this.active.set(this.key(owner.threadId, researchRunId), created);
    return created;
  }

  async submit(input: XResearchSubmitInput, owner: XResearchTaskOwner): Promise<XResearchSubmitResult> {
    const plan = planWork(input.work);
    const researchRunId = input.researchRunId ?? randomUUID();
    const opened = input.researchRunId ? await this.open(owner.threadId, researchRunId) : null;
    if (input.researchRunId && !opened) {
      throw new KydogError('research.not_found', 'X research task not found');
    }
    // 已取消的研究不能续跑（`cancel` 是唯一的控制，没有 pause / resume）。放行这次提交就是**静默复活**：
    // 排上链的那一份会被 `run` 的闸当场写成 `cancelled`，而模型拿到的提交回执是一段「已排上」的
    // 研究 —— 它于是一遍遍 `wait` 一段永远不会动的研究，且没有任何一次调用会说出原因。判据全在盘上，
    // 跨重启一致；要接着做就显式开一段新研究（`research.not_found` 的下一步是把 id 找对，处置不同）。
    if (opened && (opened.cancelRequested || opened.record.state === 'cancelled'
      || opened.record.stateReason === 'cancelled')) {
      throw new KydogError('research.cancelled', 'X research task was cancelled; start a new research');
    }
    const active = opened ?? this.create(owner, researchRunId);
    // 续跑同一段研究时，最后提交进它的会话接手这段研究：旧会话的拆除不该打断它。
    if (owner.ledger !== undefined) active.ledger = owner.ledger;
    const createdAt = this.now();
    const submission: XResearchSubmission = {
      version: 1,
      submissionId: randomUUID(),
      researchRunId,
      threadId: owner.threadId,
      // 提交那一轮的身份：结果里的 `callId` 取它，于是交付壳与结果能在恢复时逐一对上（Task 7）。
      submitCallId: randomUUID(),
      batchId: `xbatch_${randomUUID()}`,
      runId: owner.runId,
      operation: plan.operation,
      objective: plan.objective,
      state: 'queued',
      budget: plan.budget,
      usage: { posts: 0, scrolls: 0, expandActions: 0 },
      workItems: plan.workItems,
      createdAt,
      endedAt: null,
    };
    active.record.submissionIds.push(submission.submissionId);
    if (input.tabId) active.record.browserTabId = input.tabId;
    active.submissions.set(submission.submissionId, submission);
    let snapshot: XResearchTaskSnapshot;
    try {
      snapshot = await this.persist(active, [submission]);
    } catch (error) {
      // 落盘失败 = 这次提交不存在：工作从没被排进队列，内存里留着它会让 `get()` 永远报「进行中」。
      // 撤回内存再尽力把撤回后的样子落一次盘（失败就放弃 —— 调用方拿到的是原来那个错误）。
      active.submissions.delete(submission.submissionId);
      // 按 id 删，不能用 `pop()`：并发的另一次提交可能已经排在这一份后面，
      // 弹尾会删掉它、留下这一份（文件不存在、索引却说有）—— 索引与文件当场对不上。
      const index = active.record.submissionIds.indexOf(submission.submissionId);
      if (index >= 0) active.record.submissionIds.splice(index, 1);
      await this.persist(active).catch(() => undefined);
      throw error;
    }
    this.enqueue(active, submission, input.work);
    return { researchRunId, submissionId: submission.submissionId, snapshot };
  }

  async get(threadId: string, researchRunId: string): Promise<XResearchTaskSnapshot> {
    const active = await this.open(threadId, researchRunId);
    if (!active) throw new KydogError('research.not_found', 'X research task not found');
    return this.snapshotOf(active);
  }

  async list(threadId: string): Promise<XResearchTaskSnapshot[]> {
    const runs = await this.deps.store.listRuns(threadId);
    const snapshots = await Promise.all(runs.map(async (researchRunId) => {
      const active = await this.open(threadId, researchRunId);
      return active ? this.snapshotOf(active) : null;
    }));
    // 新的在前（与 `webResearch.taskList` 一致）。同一毫秒创建的两条按 `researchRunId` 定序：
    // 只比 `createdAt` 时它们的先后取决于数组顺序，同一个盘的两次 `list` 可以给出不同的列表。
    // 读不出来的那一份跳过：一个坏目录不该让整个列表变空。
    return snapshots
      .filter((snapshot): snapshot is XResearchTaskSnapshot => snapshot !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)
        || b.researchRunId.localeCompare(a.researchRunId));
  }

  /** 等该研究的队列排空（`wait` 与测试共用同一个事实）。
   *  队列是 per-thread 的一条尾链，所以「这条研究跑完了」只能靠整条链排空来回答：同一 thread 上
   *  排在它后面的提交也在这条链上，只盯该研究自己的那一轮会提前返回。
   *  `researchRunId` 在这里的作用是确认这条研究存在 —— 盘上没有它，就没有可等的活。 */
  async whenIdle(threadId: string, researchRunId: string): Promise<void> {
    if (!(await this.open(threadId, researchRunId))) {
      throw new KydogError('research.not_found', 'X research task not found');
    }
    await this.awaitIdle(threadId);
  }

  private async awaitIdle(threadId: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const chain = this.chains.get(threadId);
      if (!chain) return;
      const settled = chain.catch(() => undefined);
      await (signal ? abortable(settled, signal) : settled);
      if (this.chains.get(threadId) === chain) return;
    }
  }

  /** 交付：等队列排空，然后把**最早一份尚未交付**的结果交出去（spec §4.5）。
   *  一次只给一份 —— 一份结果的上限就是整个 1 MiB 包络（壳 + 快照 + 这份结果），
   *  多份会把它撑成几 MiB。剩下的进 `undelivered`，`counts.undelivered` 也还在快照里。
   *
   *  顺序是「选中 → 内存标记 → 落盘」：`deliveredAt` 是跨重启的权威，所以它必须在结果**真的**
   *  交给调用方之前就写上（否则同一个窗口里崩掉会让同一份结果再交一次）；
   *  这也是它只在这里写、在进展回调里不写的原因。
   *
   *  `signal` 是 pi 这一轮工具调用的中止信号（用户按了停止）：一响就当场放手，并且**不再交付** ——
   *  拒绝发生在选中与标记之前（见 `abortable` 与 `assertNotAborted`），中止不会把一份结果标成交过了。 */
  async wait(threadId: string, researchRunId: string, deliveryCallId: string,
    signal?: AbortSignal): Promise<XResearchWaitResult> {
    assertNotAborted(signal);
    const active = await this.open(threadId, researchRunId);
    if (!active) throw new KydogError('research.not_found', 'X research task not found');
    await this.awaitIdle(threadId, signal);
    assertNotAborted(signal);
    let candidates = [...active.submissions.values()];
    let delivery: XResearchDelivery | null = null;
    for (;;) {
      const pick = pickDelivery(candidates);
      if (!pick) break;
      const picked = await this.deliverable(active, pick, deliveryCallId);
      if (picked) {
        delivery = picked;
        break;
      }
      // 这份结果真的不在了（工件写失败过、或工件读不回来）：不拿它挡住后面那份。
      candidates = candidates.filter((submission) => submission !== pick);
    }
    if (!delivery) {
      return { snapshot: this.snapshotOf(active), delivery: null, undelivered: this.undeliveredOf(active) };
    }
    const delivered = active.submissions.get(delivery.submissionId)!;
    // 顺序是「选中 → 内存标记 → 落盘」：`deliveredAt` 必须在结果真的交给调用方之前写（spec §4.5，
    // 否则同一个崩溃窗口会让同一份结果再交一次）；而「标了却抛错」那条路已被关掉 —— 包络装不下
    // 时 `deliverEnvelope` 会抛，但两条交付副本（收尾 / 重启）都先按量出来的额度裁过，抛不出来。
    // mark 之前的最后一次复查：读工件那一段是真实的 await（重启后的交付才会走到），中止落在那里
    // 同样不交付。
    assertNotAborted(signal);
    delivered.deliveredAt = this.now();
    delivered.deliveryCallId = deliveryCallId;
    active.results.delete(delivered.submissionId);
    // 标记落盘失败不该把已经交出去的结果要回来：内存里它已经是交付过的，重启后最多再交一次
    // （交付幂等就是那个窗口的兜底，spec §4.5），日志是这件事唯一露面的地方。
    const snapshot = await this.persist(active, [delivered]).catch((error: unknown) => {
      logger.warn('x_research', 'could not persist the delivery mark', {
        threadId, researchRunId, submissionId: delivered.submissionId, err: String(error),
      });
      return this.snapshotOf(active);
    });
    return { snapshot, delivery, undelivered: this.undeliveredOf(active) };
  }

  /** 分页看行 / 交付清单 / 失败（spec §4.2、§4.5）：读的就是快照背后那批记录，
   *  绝不重算状态 —— 它是同一份事实的另一种切法，不是第二份权威。
   *  「只读」指不作用于任务，不是不写盘：它 `open()` 一条研究，而 `open()` 可能修一次重启遗留
   *  （`running` 收成 `interrupted` 并落盘），那是打开一条研究的代价，不是 `inspect` 自己在改状态。 */
  async inspect(threadId: string, researchRunId: string,
    input: XResearchInspectInput): Promise<XResearchInspectResult> {
    const active = await this.open(threadId, researchRunId);
    if (!active) throw new KydogError('research.not_found', 'X research task not found');
    if (input.view !== 'rows' && input.view !== 'deliveries' && input.view !== 'failures') {
      throw new Error(`x_research inspect: unknown view ${String(input.view)}`);
    }
    const offset = decodeInspectCursor(input.cursor);
    const pageSize = inspectPageSize(input.pageSize);
    const items = this.inspectItems(active, input.view);
    const page = items.slice(offset, offset + pageSize);
    const end = offset + page.length;
    return {
      snapshot: this.snapshotOf(active),
      items: page,
      ...(end < items.length ? { nextCursor: encodeInspectCursor(end) } : {}),
    };
  }

  /** 取消（spec §4.2）：`cancel` 是唯一的控制，没有 pause / resume。
   *
   *  排队中的提交当场写成 `cancelled` —— 一次导航都不会发生；在飞的那一份由任务的 AbortController
   *  停下，采集层照 `ctx.signal` 收尾。**已经收尾的行保住它们的结论**（取消不抹掉观察过的事实），
   *  没收尾的行写成 `cancelled`：那是「为什么停了」的事实，不是崩溃留下的「中断」。
   *  已完成的提交不受影响：`wait` 照样交付它们。
   *
   *  没有排队/在飞的提交就是空操作：不改状态、不写盘，也不把研究毒成「已取消」（否则一段做完的
   *  研究只因为点过一次取消就再也追加不了工作）。 */
  async cancel(threadId: string, researchRunId: string): Promise<XResearchTaskSnapshot> {
    const active = await this.open(threadId, researchRunId);
    if (!active) throw new KydogError('research.not_found', 'X research task not found');
    return this.cancelActive(active);
  }

  private async cancelActive(active: ActiveResearch): Promise<XResearchTaskSnapshot> {
    const inFlight = [...active.submissions.values()].filter(
      (submission) => submission.state === 'queued' || submission.state === 'running',
    );
    if (!inFlight.length) return this.snapshotOf(active);
    active.cancelRequested = true;
    active.controller.abort();
    const queued = inFlight.filter((submission) => submission.state === 'queued');
    for (const submission of queued) this.cancelSubmission(submission);
    // 等在飞那一份**自己**照信号收尾（`run` 按 `cancelRequested` 把它写成 cancelled 并落盘）。
    // 不等整条 thread 链：同一 thread 上另一段研究排在后面的采集与这次取消无关，等它会把
    // 「点一下取消」变成「等几分钟」。返回时盘上已经是取消后的样子（R12：先 flush 再返回）。
    for (const submission of inFlight) {
      if (submission.state !== 'running') continue;
      await active.pending.get(submission.submissionId)?.catch(() => undefined);
    }
    // 落盘失败不该把已经发生的取消说成没发生：内存里它已经是取消后的样子了（与 `wait` 的交付
    // 标记同一条处置），日志是这件事唯一露面的地方。
    return this.persist(active, queued, 'cancelled').catch((error: unknown) => {
      logger.warn('x_research', 'could not persist the cancellation', {
        threadId: active.record.threadId, researchRunId: active.record.researchRunId, err: String(error),
      });
      return this.snapshotOf(active);
    });
  }

  /** 会话被拆 / 对话被删：这条 thread 的全部在飞提交照信号收尾成**中断**、写进盘，然后淘汰内存缓存。
   *
   *  与 `cancel` 分开（结论不同）：用户按停止是「被取消」，会话消失是「被打断」—— 前者是有人
   *  做了决定，后者只是这一段执行没了。所以这里不置 `cancelRequested`：工作体自己照信号抛出，
   *  `run` 的 catch 把它收成 `interrupted`。
   *
   *  排在 `forget` 之前的两步都是必需的：中断只改内存，盘上的「进行中」要靠 `run` 的收尾落一次盘
   *  （R12）；而排队的那些提交还挂在 per-thread 链上，它们的 `run` 会再写一次盘 —— 不先把链排空就
   *  `forget`，那次写盘会拿内存里的活副本把一条已经不存在的研究重新写回盘上（删对话之后这条
   *  目录刚刚被 `removeThread` 删掉）。链上这时只剩状态转移，不会再碰浏览器。 */
  async disposeThread(threadId: string, ledger?: object): Promise<void> {
    for (const active of [...this.active.values()]) {
      if (active.record.threadId === threadId && this.owns(active, ledger)) await this.interruptActive(active);
    }
    await this.awaitIdle(threadId).catch(() => undefined);
    this.forget(threadId, ledger);
  }

  /** 拆除只认领自己那一份：给了账本身份时，只碰由它最后一次提交的研究；没给（删对话等）
   *  就是整条 thread。`undefined` 的 active 是只被 `get` / `wait` 打开过的缓存，里面不可能有在飞工作。 */
  private owns(active: ActiveResearch, ledger?: object): boolean {
    return ledger === undefined || active.ledger === ledger;
  }

  /** 会话消失时的收尾：在飞那一份照信号抛出（`run` 的 catch 写成 `interrupted`），
   *  排队的一次都没起跑就收成 `interrupted`，最后落一次盘。 */
  private async interruptActive(active: ActiveResearch): Promise<void> {
    // 先关门再早退：否则落在「没有在飞」与「拆除完成」之间的提交会照常起跑一整轮采集。
    active.disposed = true;
    const inFlight = [...active.submissions.values()].filter(
      (submission) => submission.state === 'queued' || submission.state === 'running',
    );
    if (!inFlight.length) return;
    active.controller.abort();
    const queued = inFlight.filter((submission) => submission.state === 'queued');
    for (const submission of queued) this.interrupt(submission);
    for (const submission of inFlight) {
      if (submission.state !== 'running') continue;
      await active.pending.get(submission.submissionId)?.catch(() => undefined);
    }
    await this.persist(active, queued).catch((error: unknown) => {
      logger.warn('x_research', 'could not persist the interruption', {
        threadId: active.record.threadId, researchRunId: active.record.researchRunId, err: String(error),
      });
    });
  }

  /** 淘汰内存缓存：下一次 `get()` 从盘上重读（删对话后不许再从缓存答复）。
   *  给了账本身份时只淘汰自己那一份 —— 同一条 thread 上替换会话的缓存不许被旧会话删掉。 */
  forget(threadId: string, ledger?: object): void {
    for (const [key, active] of this.active) {
      if (active.record.threadId === threadId && this.owns(active, ledger)) this.active.delete(key);
    }
  }

  /** 每个视图都按**提交序 → 工作项序**铺开：翻页因此是稳定的，游标只是偏移。
   *  `failures` 与快照的「有失败」用同一个集合，不另写一份词表。 */
  private inspectItems(active: ActiveResearch, view: XResearchInspectView): XResearchInspectItem[] {
    const submissions = [...active.submissions.values()];
    if (view === 'deliveries') {
      return submissions.map((submission): XResearchInspectDelivery => ({
        kind: 'delivery',
        submissionId: submission.submissionId,
        operation: submission.operation,
        objective: submission.objective,
        state: submission.state,
        endedAt: submission.endedAt ?? null,
        deliveredAt: submission.deliveredAt ?? null,
        deliveryCallId: submission.deliveryCallId ?? null,
        hasArtifact: submission.artifact !== undefined,
      }));
    }
    const rows = submissions.flatMap((submission) => submission.workItems.map(
      (item, index): XResearchInspectRow => ({
        kind: 'work_item', submissionId: submission.submissionId,
        operation: submission.operation, index, item,
      }),
    ));
    if (view === 'rows') return rows;
    return rows.flatMap((row): XResearchInspectFailure[] => {
      const { status, stopReason, reason, label } = row.item;
      if (status === null || !X_RESEARCH_FAILURE_STATUSES.has(status)) return [];
      return [{
        kind: 'failure', submissionId: row.submissionId, operation: row.operation,
        index: row.index, label, status, stopReason, reason,
      }];
    });
  }

  /** 这份提交能不能交出结果：服务手里那份优先（它就是 `settle` 写结论用的那一份字节），
   *  只有在内存里没有它（重启后）时才走工件。工件里存的是完整 canonical，读回来要照今天的
   *  预算再裁一次，并且和收尾路径一样按**量出来的包络额度**裁（控制器裁决 T5/B'）——
   *  否则一个顶到 1 MiB 的工件加上壳就装不进包络，而那份结果恰恰是重启后最需要交出去的。 */
  private async deliverable(active: ActiveResearch, submission: XResearchSubmission,
    deliveryCallId: string): Promise<XResearchDelivery | null> {
    const { threadId, researchRunId } = active.record;
    const identity = {
      deliveryCallId, submissionId: submission.submissionId,
      submitCallId: submission.submitCallId, operation: submission.operation,
    };
    const held = active.results.get(submission.submissionId);
    if (held) return { ...identity, result: held };
    // 工件写失败过：这份结果不在盘上，重启后它就不存在了（R20）。
    if (!submission.artifact) return null;
    const artifacts = this.deps.artifacts(threadId, researchRunId);
    try {
      const canonical = await artifacts.read(submission.artifact);
      // 工件里是 canonical DTO（没有交付字段）：补上「已落盘」，否则序列化会把这件事说成失败。
      canonical.artifact = submission.artifact;
      canonical.delivery = {
        truncated: false, omittedObservations: 0, omittedFields: [],
        // 重启后提交记录里的 ref 可能出自旧根（改造前那份提交）：路径也要双根定位。
        artifactPath: await artifacts.locate(submission.artifact), persistence: 'saved',
      };
      // R24：这两份事实只有序列化时才算出来，工件（序列化之前的 canonical）里没有它们 ——
      // 收尾那一刻存进提交记录，这里放回去再序列化。放在裁切之前，字节数从一开始就把它们算进去。
      if (submission.reportScopeFacts) canonical.reportScopeFacts = submission.reportScopeFacts;
      if (submission.reportRunScopeFacts) canonical.reportRunScopeFacts = submission.reportRunScopeFacts;
      const result = clipForEnvelope({
        researchRunId, snapshot: this.snapshotOf(active),
        submissionId: submission.submissionId, submitCallId: submission.submitCallId,
        operation: submission.operation,
        result: serializeXResearchResult(canonical).result,
      });
      active.results.set(submission.submissionId, result);
      return { ...identity, result };
    } catch (error) {
      logger.warn('x_research', 'could not read a delivered artifact', {
        threadId, researchRunId, submissionId: submission.submissionId, err: String(error),
      });
      return null;
    }
  }

  /** 还没交付的清单：与 `pickDelivery` / `counts.undelivered` 同一判据。
   *  拿不到结果的那一份也在里面 —— 它确实没交付过，不假装。 */
  private undeliveredOf(active: ActiveResearch): XResearchWaitResult['undelivered'] {
    return [...active.submissions.values()]
      .filter((submission) => submission.endedAt != null && !submission.deliveredAt)
      .map((submission) => ({
        submissionId: submission.submissionId, operation: submission.operation,
        objective: submission.objective, state: submission.state,
      }));
  }

  /** 每个 thread 一条尾链：x 的风控与「一个 thread 一个标签页」都要求串行（spec §4.3）。 */
  private enqueue(active: ActiveResearch, submission: XResearchSubmission, work: XResearchWorkRequest): void {
    const threadId = active.record.threadId;
    const prior = this.chains.get(threadId) ?? Promise.resolve();
    // 一条链上的失败不许卡住后续提交：`run` 自己吞掉工作体的异常，这里再兜一次。
    const run = prior.catch(() => undefined).then(() => this.run(active, submission, work));
    this.chains.set(threadId, run);
    active.pending.set(submission.submissionId, run);
    const release = (): void => {
      if (this.chains.get(threadId) === run) this.chains.delete(threadId);
      active.pending.delete(submission.submissionId);
    };
    void run.then(release, () => {
      // `run` 只会在落盘失败时拒绝。还挂在「进行中」上的提交收成「中断」，再尽力落一次盘；
      // 第二次失败也只能放弃 —— 但它不许变成 unhandled rejection，也不许卡住队列。
      if (submission.state === 'running') this.interrupt(submission);
      void this.persist(active, [submission]).catch(() => undefined);
      release();
    });
  }

  private async run(active: ActiveResearch, submission: XResearchSubmission,
    work: XResearchWorkRequest): Promise<void> {
    // 取消之后不再起跑：排队中的提交在 `cancel` 那一刻就有结论，采集层一次都不该被碰。
    if (active.cancelRequested) {
      this.cancelSubmission(submission);
      await this.persist(active, [submission], 'cancelled');
      return;
    }
    // 会话已经拆掉：排队的这一份一次都不起跑，按中断收尾（结论与用户取消不同）。
    if (active.disposed) {
      this.interrupt(submission);
      await this.persist(active, [submission]);
      return;
    }
    submission.state = 'running';
    await this.persist(active, [submission]);
    try {
      const result = await this.deps.runWork(work, {
        threadId: active.record.threadId,
        researchRunId: active.record.researchRunId,
        submissionId: submission.submissionId,
        batchId: submission.batchId,
        runId: submission.runId,
        submitCallId: submission.submitCallId,
        signal: active.controller.signal,
        tabBinding: {
          get: () => active.record.browserTabId,
          set: (tabId) => {
            if (tabId) active.record.browserTabId = tabId;
            else delete active.record.browserTabId;
          },
        },
        onProgress: (event) => this.progress(active, submission, event),
      });
      // 交付优先用这一份：它就是 `settle` 写结论、并按包络额度裁过的那一份字节
      // （卡与交付出去的结果不许各自一套结论）。
      active.results.set(submission.submissionId, this.settle(active, submission, result));
    } catch (err) {
      // 工作体抛出 = 这一轮没有结果。没有结果就没有任何行结论（见 `interrupt`）。
      // 先留一条诊断：抛出被收在这里，日志是它唯一露面的地方。
      logger.warn('x_research', 'work body threw', {
        threadId: active.record.threadId, researchRunId: active.record.researchRunId,
        submissionId: submission.submissionId, err: String(err),
      });
      // 因取消而停下的是「取消」，不是崩溃留下的「中断」（见 `cancelSubmission`）。
      if (!active.cancelRequested) this.interrupt(submission);
    }
    // 取消可能恰好落在收尾前后：这一份仍按「被取消」收尾（已收尾的行结论原样保留），
    // 并且在盘上留下「被取消」这条理由 —— `state` 只由投影决定（可能仍是 completed），
    // 重启后的 `submit` 与卡片都要靠这条理由知道这段研究已经被停过。
    if (active.cancelRequested) this.cancelSubmission(submission);
    await this.persist(active, [submission], active.cancelRequested ? 'cancelled' : undefined);
  }

  /** 进度事件说的是「这一行此刻在哪个阶段」，不是结论：`status` / `stopReason` / `reason`
   *  只在事件说 `stopped` 时写入 —— 运行中的 `row.status` 是采集层的「还没结论」（初始就是
   *  partial），写进去会把在飞的行说成「收了一部分」。 */
  private progress(active: ActiveResearch, submission: XResearchSubmission,
    event: XResearchProgressEvent): void {
    if (submission.state !== 'running') return;
    const workItem = submission.workItems[event.rowIndex];
    if (!workItem || workItem.section !== event.section) return;
    copyRowFacts(workItem, event.row);
    workItem.phaseDetail = event.phaseDetail ?? null;
    if (event.state === 'stopped') concludeRow(workItem, event.row);
    else workItem.state = event.state;
    this.publish(active);
  }

  /** 收尾：结果的行序就是请求的行序（采集循环按 query / target 顺序跑），工作项按同一个序展开。 */
  private settle(active: ActiveResearch, submission: XResearchSubmission,
    result: XResearchResult): XResearchResult {
    const rows: readonly (XSearchObservation | XReadObservation)[] =
      result.operation === 'search' ? result.queries : result.targets;
    if (result.operation === submission.operation) {
      rows.forEach((row, index) => {
        const workItem = submission.workItems[index];
        if (workItem) concludeRow(workItem, row);
      });
    }
    // 有工作项没等到行 = 这一轮没收完。停在 `stopped`、`status` 留空，投影把它们算成「中断」
    // （`workItemBucket` 的那一支），不猜成失败或成功；提交层也不落成 `done`，
    // 否则整段研究会按 `xResearchTaskState` 落成 `completed`。
    for (const workItem of submission.workItems) {
      if (workItem.state === 'stopped') continue;
      workItem.state = 'stopped';
      workItem.phaseDetail = null;
    }
    const concluded = result.operation === submission.operation
      && rows.length >= submission.workItems.length;
    submission.state = concluded ? 'done' : 'interrupted';
    submission.endedAt = this.now();
    submission.usage = usageOf(submission.workItems);
    // R20：结果只按今天的工件格式落一次，提交记录里只存 ref —— 重启后的交付靠它把结果读回来。
    if (result.artifact) submission.artifact = result.artifact;
    else delete submission.artifact;
    // 控制器裁决（T5，B'）：交付副本在这里按**量出来的**包络额度裁一次，交付路径不再裁第二次。
    // 额度 = 1 MiB 减去壳与快照占的字节（壳按交付时的形状搭一遍量出来，没有写死的常数）。
    const clipped = clipForEnvelope({
      researchRunId: active.record.researchRunId,
      snapshot: this.snapshotOf(active),
      submissionId: submission.submissionId,
      submitCallId: submission.submitCallId,
      operation: submission.operation,
      result,
    });
    // R24：交付的这份结果带着序列化时算出来的 scope 事实，工件里只有序列化之前的 canonical。
    // 提交记录是重启后唯一的来源，所以收尾时把存在的那两份一并落进去。
    if (clipped.reportScopeFacts) submission.reportScopeFacts = clipped.reportScopeFacts;
    else delete submission.reportScopeFacts;
    if (clipped.reportRunScopeFacts) submission.reportRunScopeFacts = clipped.reportRunScopeFacts;
    else delete submission.reportRunScopeFacts;
    return clipped;
  }

  /** 取消的收尾：已经收尾的行保住结论（spec §4.2「保留已完成的观察」），没收尾的行写成
   *  `cancelled` —— 用户停的，不是进程被杀。
   *  只给**还没收尾**的提交改结论：取消落在收尾之后时这一份已经有自己的结论（`done` /
   *  `interrupted`），取消不许把它改写成一个它并不处于的状态。 */
  private cancelSubmission(submission: XResearchSubmission): void {
    if (submission.state !== 'queued' && submission.state !== 'running') return;
    for (const workItem of submission.workItems) {
      if (workItem.state === 'stopped') continue;
      workItem.state = 'stopped';
      workItem.phaseDetail = null;
      workItem.status = 'cancelled';
      workItem.stopReason = 'cancelled';
    }
    submission.state = 'cancelled';
    submission.endedAt = this.now();
    submission.usage = usageOf(submission.workItems);
  }

  /** 没有结果的工作项停在这里：`state: 'stopped'` + `status: null` 就是「中断」在投影里的形状。
   *  已经收尾的那一份原样不动（会话拆除可能落在它自己的收尾之后）。 */
  private interrupt(submission: XResearchSubmission): void {
    if (submission.state !== 'queued' && submission.state !== 'running') return;
    for (const workItem of submission.workItems) {
      if (workItem.state === 'stopped') continue;
      workItem.state = 'stopped';
      workItem.phaseDetail = null;
    }
    submission.state = 'interrupted';
    submission.endedAt = this.now();
    submission.usage = usageOf(submission.workItems);
  }

  /** 一次状态转移：内存先改，再落盘，再推一帧。
   *  写盘顺序是先 `task.json`、后这些 `submission-*.json`：中间被杀只会留下「索引比提交新」
   *  的一侧，任务目录里永远不会出现「有提交、没有索引」的形状（Task 1 评审的同一条约束）。
   *  `reason` 只给「不是投影推出来的」那一个结论用（进程重启后的修复）。
   *  `stateReason` 一旦是 `cancelled` 就不许被擦（`process_restarted` 除外：崩溃是真的发生过的事）。 */
  private async persist(active: ActiveResearch,
    submissions: readonly XResearchSubmission[] = [],
    reason?: string): Promise<XResearchTaskSnapshot> {
    active.record.revision += 1;
    active.record.updatedAt = this.now();
    const settled = this.project(active);
    active.record.state = settled.state;
    // 「被取消过」是黏的：取消之后每一次落盘（交付标记、更新）都没有理由可写，但它不许把这件事
    // 擦掉 —— 重启后 `cancelRequested` 已经不在内存里（只在本次进程的窗口里有效），`stateReason`
    // 是「这段研究被停过」唯一跨进程的痕迹：`submit` 靠它拒绝续跑，卡片靠它说「被取消过」。
    //
    // 投影里的 `submission_unreadable` 也不许盖掉它：那是**读盘缺口**（有一份提交文件读不出来），
    // 不是「为什么停了」的事实。让它盖掉就等于把一段已取消的研究在重启后变回可追加 —— `submit`
    // 认的就是这条理由。`process_restarted` 不同：崩溃真的发生过，它优先于取消。
    const derived = reason ?? settled.reason;
    const stickyCancelled = active.record.stateReason === 'cancelled' ? 'cancelled' : undefined;
    const stateReason = derived === 'submission_unreadable'
      ? (stickyCancelled ?? derived)
      : (derived ?? stickyCancelled);
    if (stateReason) active.record.stateReason = stateReason;
    else delete active.record.stateReason;
    await this.deps.store.writeTask(active.record);
    for (const submission of submissions) await this.deps.store.writeSubmission(submission);
    return this.emit(active);
  }

  /** 只推一帧、不落盘：进度回调绝不能等磁盘（spec §4.4「实时状态按边界更新内存」）。
   *  `revision` 照样自增 —— 渲染层的 store 按 revision 丢弃迟到的快照，不增就等于新的一帧被当成旧的。 */
  private publish(active: ActiveResearch): XResearchTaskSnapshot {
    active.record.revision += 1;
    active.record.updatedAt = this.now();
    return this.emit(active);
  }

  private snapshotOf(active: ActiveResearch): XResearchTaskSnapshot {
    return xResearchTaskSnapshot(active.record, [...active.submissions.values()]);
  }

  /** 观察者抛异常绝不能改变任务状态（同采集层的「Observer failures never replace the original refusal」）。 */
  private emit(active: ActiveResearch): XResearchTaskSnapshot {
    const snapshot = this.snapshotOf(active);
    try {
      this.deps.onUpdate(snapshot);
    } catch { /* UI observers cannot alter persisted state */ }
    return snapshot;
  }

  /** 生命周期只由这里写（快照取 `record.state`）。`submissionIds` 读不齐时不下结论：
   *  读不出来的那份可能载着未收尾的工作，而 `xResearchTaskState([])` 落出的 `completed` 不是结论
   *  （Task 2 的调用方约定）。
   *
   *  `xResearchTaskState` 只在**每一份**提交都被取消时才落 `cancelled`：一段研究里有已完成的提交、
   *  也有被取消的，投影仍是 `completed`，取消这件事由 `record.stateReason = 'cancelled'` 说出来 ——
   *  每一行的 `status` 各自说得出真相，这是刻意的（不是漏了 `cancelled` 这一支）。 */
  private project(active: ActiveResearch): { state: XResearchTaskState; reason?: string } {
    const submissions = [...active.submissions.values()];
    if (!submissions.length || submissions.length !== active.record.submissionIds.length) {
      return { state: 'interrupted', reason: 'submission_unreadable' };
    }
    return { state: xResearchTaskState(submissions) };
  }
}

/**
 * 进程级实例的**接入点**（RPC 只读这一份）。
 *
 * 为什么不是像 `getWebResearchTaskService()` 那样在这里自己装配：这个 service 的 runner 需要
 * per-session 的证据账本、范围 prior 与标签页绑定（`sessionFactory.createSession` 里才有的东西），
 * 装配点因此只能在会话那侧。这里只留一个登记缝：Task 9 的会话接线登记**唯一**那一个实例，
 * `xResearch.task*` 四条 RPC 读它。**不许**每个会话登记一个新实例 —— 队列与在飞状态都在实例里。
 */
let instance: XResearchTaskService | null = null;

export function registerXResearchTaskService(service: XResearchTaskService | undefined): void {
  const next = service ?? null;
  // 同一实例重复登记是无害的；换一个实例则是接线错误：队列、在飞状态与 `onUpdate` 各自一份，
  // 而两边的行为都说得通 —— 不抛的话，Task 9 的接线 bug 与「功能没开」在外部完全同形。
  // 合法重接线的路是中间夹一次 `registerXResearchTaskService(undefined)`。
  if (instance !== null && next !== null && next !== instance) {
    throw new KydogError(
      'research.conflict',
      'X research task service is already registered; register(undefined) before wiring a different instance',
    );
  }
  instance = next;
}

/** 未接线（x research 关闭、或这个进程还没建过会话）时回 `null`，**不抛**：
 *  「没接线」与「这条研究不存在」是两件事，`taskList` 要能把前者答成空列表。 */
export function xResearchTaskService(): XResearchTaskService | null {
  return instance;
}

/** 会话被拆（切项目 / 换模型 / 切语言 / 删对话）时，这条 thread 的在飞研究要停下并落盘。
 *  由会话侧调用（`AgentService.dispose`）：**先**取消并等盘上写成收尾状态，**再**解绑那次会话
 *  的活账本 —— 反过来的话，排队的提交会在一个已经不存在的会话上起跑。 */
export async function disposeXResearchThread(threadId: string, ledger?: object): Promise<void> {
  await instance?.disposeThread(threadId, ledger);
}

/** 删对话：盘上的目录由 `XResearchTaskStore.removeThread` 删，这里淘汰内存缓存 ——
 *  删一条从没建过会话的对话走的正是这条路（没有 `disposeThread` 可走，缓存却可能还在）。 */
export function forgetXResearchThread(threadId: string): void {
  instance?.forget(threadId);
}
