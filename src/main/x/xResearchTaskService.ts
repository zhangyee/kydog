// `x_research` 的任务 service（spec §4.3–§4.7、§5.3）：提交、per-thread 串行队列、状态推进。
//
// 它只做「把工作排起来、把工作项的状态说准、把结果留在盘上」：真正碰浏览器的执行体由
// `deps.runWork` 注入（Task 4 的 runner），交付由 `wait` 负责（Task 5）。这样这一层可以在
// 一条用例里用假工作体跑完，不需要 DOM 也不需要浏览器。
import { randomUUID } from 'node:crypto';
import { KydogError } from '../../shared/errors';
import { logger } from '../log';
import type {
  XResearchCancelActor, XResearchSection, XResearchSubmission, XResearchTaskRecord,
  XResearchTaskSnapshot, XResearchTaskState, XResearchWorkItem,
} from '../../shared/xResearchTask';
import { X_RESEARCH_FAILURE_STATUSES, xResearchTaskSnapshot, xResearchTaskState } from '../../shared/xResearchTask';
import type { XResearchStatus, XStopReason } from '../../shared/xResearchStatus';
import type { XResearchTaskStore } from './xResearchTaskStore';
import type { XResearchArtifactStore } from './xResearchArtifacts';
import { clipForEnvelope, deliverableSubmissions, fitsDeliveryEnvelope } from './xResearchDeliver';
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

/** `wait` 的产物：这一轮的快照、这一轮交付的每一份（可能为空）、以及还没交付的清单。
 *  `undelivered` 是**这次调用之后**仍然收尾未交付的提交：包络装不下时它会大于 0，模型据此再 `wait`。
 *  壳的构造与 1 MiB 定点归 `./xResearchDeliver`（它只管字节，不碰任务状态）。
 *
 *  `evidence` 与 `deliveries` **同序一一对应**：每条交付的账本投喂源（R81d）。它是**工件里的 canonical**
 *  （`store.read(submission.artifact)` 那条 sha256 校验过的读），不是交付那份按 1 MiB 裁过的副本 ——
 *  实测 1,196,614 字节的交付里正文被裁成 `"text": ""`、整段 `posts` 被省掉，而工件里逐字还在；
 *  裁剪是模型可见性，不是「没观察到」。工件读不回来（`persistence: 'failed'`、旧交付没有 ref、
 *  字节坏了）时它就是交付副本本身：可引用面不因此扩大一个字。它**不进包络**，模型看到的仍只有
 *  `deliveries`。 */
export type XResearchWaitResult = {
  snapshot: XResearchTaskSnapshot;
  deliveries: XResearchDelivery[];
  evidence: XResearchResult[];
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

/** 「收 N 帖」= 去重后接纳的帖子数，不是保留的观测条数；`略过 N 条` 取采样省略数。
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
  /** 返回之后才落的那笔写（spec §4.5：交付标记写在返回之后）。它不在那条尾链上，所以「排空」不能
   *  只看链：删对话的顺序是「拆除（排空）→ 删目录」，这笔写抢在删之后落地就会把 `task.json` /
   *  `submission-*.json` 写回来 —— 一条已经删掉的研究重新长出来。键是 threadId（目录的所有者）。 */
  private readonly lateWrites = new Map<string, Set<Promise<void>>>();
  /** 这条对话的标签页（R81h）：新开一段研究时先继承这里记的那一页，于是「取消后重试」不用让模型去
   *  `browser_tabs` 把页找回来。按 threadId 记，不按研究：换一段研究还是同一个对话的同一张页。
   *  只活在内存里 —— 重启后靠各研究自己的 `task.json` 上的 `browserTabId`（本轮继承只在本进程内）。 */
  private readonly threadTab = new Map<string, string>();

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
    // 判据是**提交**，不是 `record.state`：盘上还留着排队/在飞的那一份 = 写它的那个进程没走完（何况
    // `open` 的前提本来就是这条研究没有内存活副本 —— 本进程里没有在跑的队列）。`flush` 先写 `task.json`
    // 再写提交文件，两次写之间被杀就会留下「任务已完成 + 提交还在跑」（`wait` 的交付落盘正是这种写法）；
    // 按 `record.state` 判断这一份永远不会被修，而卡片按 `counts.queued + counts.running` 判「还有活」，
    // 于是一段做完了的研究在卡上带着一个能按的取消。
    if (this.hasInFlight(opened)) await this.repairRestarted(opened);
    return opened;
  }

  /** 崩溃后的诚实表示（spec §4.4）：盘上还留着排队/在飞的提交 = 写它的那个进程在两个边界之间被杀
   *  （`task.json` 与提交文件那两次写之间，或一轮采集跑到一半）。未收尾的提交按中断收尾（复用
   *  `interrupt` / `project`，不另写一份状态规则），再落一次盘 —— 否则同一个「在飞」在每次重开时都会
   *  被当成最新状态读回来。
   *
   *  例外是**被取消过**的那一段（盘上 `stateReason = 'cancelled'`，见 R28）：崩溃也可能落在 `cancel`
   *  落盘的两个边界之间 —— 排队的那份已经写成 `cancelled`，索引还没写（或者反过来）。这时把残留的
   *  提交收成 `interrupted` 就抹掉了「有人停过它」这条黏的事实，而 `submit` 认的正是 `stateReason`：
   *  工作于是能重新回到一段已取消的研究里。所以按取消收尾（复用 `cancelSubmission`，结论与 `cancel`
   *  一致），并且落盘的理由也写 `cancelled` —— 写成 `process_restarted` 会盖掉那条黏的事实。 */
  private async repairRestarted(active: ActiveResearch): Promise<void> {
    const unsettled = [...active.submissions.values()]
      .filter((submission) => submission.state === 'queued' || submission.state === 'running');
    const cancelled = active.record.stateReason === 'cancelled';
    for (const submission of unsettled) {
      if (cancelled) this.cancelSubmission(submission);
      else this.interrupt(submission);
    }
    const reason = cancelled ? 'cancelled' : unsettled.length ? 'process_restarted' : undefined;
    // 落盘失败在这里只能放弃：这条研究下一次打开时会再修一次，而 `get` 不该因为修复写失败而不回答。
    await this.persist(active, unsettled, reason).catch(() => undefined);
  }

  private create(owner: XResearchTaskOwner, researchRunId: string): ActiveResearch {
    const now = this.now();
    // 本对话当前那张页：新研究先继承它（R81h）。没有就什么都不写 —— 空串不是标签页 id。
    const inherited = this.threadTab.get(owner.threadId);
    const created: ActiveResearch = {
      record: {
        version: 1, researchRunId, threadId: owner.threadId, projectRoot: owner.projectRoot,
        createdAt: now, updatedAt: now, revision: 0, state: 'running', submissionIds: [],
        ...(inherited ? { browserTabId: inherited } : {}),
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
    if (input.tabId) {
      active.record.browserTabId = input.tabId;
      // 显式给的页也是这条对话的页：下一段研究接着用它（R81h）。
      this.threadTab.set(owner.threadId, input.tabId);
    }
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
   *  「排空」也包括返回之后才落的那笔交付标记（`lateWrites`）：它不在链上，但删目录必须排在它之后。
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
      const late = [...(this.lateWrites.get(threadId) ?? new Set<Promise<void>>())];
      if (!chain && !late.length) return;
      const settled = Promise.all([
        chain ? chain.catch(() => undefined) : Promise.resolve(),
        // 这些写自己已经把失败记进日志（`trackLateWrite`）：排空不因其中一笔失败而拒绝。
        ...late.map((work) => work.catch(() => undefined)),
      ]);
      await (signal ? abortable(settled, signal) : settled);
      if (this.chains.get(threadId) === chain && !this.lateWrites.get(threadId)?.size) return;
    }
  }

  /** 记下「这笔写还没落完」：落完（成功或失败）就摘掉，`awaitIdle` 等的是这个集合。 */
  private trackLateWrite(threadId: string, work: Promise<void>): void {
    const writes = this.lateWrites.get(threadId) ?? new Set<Promise<void>>();
    this.lateWrites.set(threadId, writes);
    writes.add(work);
    const release = (): void => {
      writes.delete(work);
      if (!writes.size && this.lateWrites.get(threadId) === writes) this.lateWrites.delete(threadId);
    };
    void work.then(release, release);
  }

  /** 交付：等队列排空，然后把该 run 下**所有已收尾、未交付**的结果一次交出去（spec §4.5）。
   *  逐条塞进同一个 1 MiB 包络（壳 + 快照 + 本轮全部结果）：塞不下就停在最后一个装得下的位置，
   *  剩下的进 `undelivered`，`counts.undelivered` 也还在快照里 —— 模型再 `wait` 一次即可。
   *  一份就超过预算时仍然把它交出去（与改造前同一条路：快照与结果的省略账本让位，最后才是硬失败）
   *  —— 否则它会永远交不出来，把整条队列堵死。
   *
   *  顺序是 spec §4.5 的那一条：**选中 → 内存标记 → 返回 → 落盘确认**。`deliveredAt` 是跨重启
   *  的权威，但把它先写盘再返回会造出「标了却没交」：同一个窗口里崩掉，结果永远丢（盘上说交过了，
   *  而模型从没见过它）。反过来，落盘落在返回之后，窗口内崩掉只是「再交一次」—— 那一次的重复写入
   *  由 `XResearchEvidence.observe` 的幂等兜底（同一份结果不会在 records 里变成两份）。
   *  标记是逐条的（每条各自 `deliveredAt` / `deliveryCallId`），但整批只推进一次快照、只落一次盘。
   *
   *  `signal` 是 pi 这一轮工具调用的中止信号（用户按了停止）：一响就当场放手，并且**一条都不标** ——
   *  拒绝发生在选中与标记之前（见 `abortable` 与 `assertNotAborted`），中止不会把结果标成交过了。 */
  async wait(threadId: string, researchRunId: string, deliveryCallId: string,
    signal?: AbortSignal): Promise<XResearchWaitResult> {
    assertNotAborted(signal);
    const active = await this.open(threadId, researchRunId);
    if (!active) throw new KydogError('research.not_found', 'X research task not found');
    await this.awaitIdle(threadId, signal);
    assertNotAborted(signal);
    const candidates = deliverableSubmissions([...active.submissions.values()]);
    const packed: XResearchSubmission[] = [];
    const deliveries: XResearchDelivery[] = [];
    // 与 `deliveries` 同序：每条交付的账本投喂源（工件 canonical），不进包络。
    const evidence: XResearchResult[] = [];
    for (const candidate of candidates) {
      const candidateDelivery = await this.deliverable(active, candidate, deliveryCallId);
      // 这份结果真的不在了（工件写失败过、或工件读不回来）：不拿它挡住后面的，也不假装交付过。
      if (!candidateDelivery) continue;
      const { delivery } = candidateDelivery;
      if (deliveries.length) {
        // 试装下一份：装不下就停在上一份。`undelivered` 按「试装之后还剩谁」量，包络字节因此
        // 说的就是这一轮真正会返回的形状 —— 不是先按空清单量、再塞进一份更大的清单。
        const next = [...deliveries, delivery];
        const taken = new Set([...packed, candidate].map((submission) => submission.submissionId));
        if (!fitsDeliveryEnvelope({
          researchRunId, snapshot: this.snapshotOf(active), deliveries: next,
          undelivered: candidates.filter((submission) => !taken.has(submission.submissionId))
            .map((submission) => ({
              submissionId: submission.submissionId, operation: submission.operation,
              objective: submission.objective, state: submission.state,
            })),
          action: 'wait',
        })) break;
      }
      deliveries.push(delivery);
      evidence.push(candidateDelivery.evidence);
      packed.push(candidate);
    }
    if (!deliveries.length) {
      return {
        snapshot: this.snapshotOf(active), deliveries: [], evidence: [],
        undelivered: this.undeliveredOf(active),
      };
    }
    // mark 之前的最后一次复查：读工件那一段是真实的 await（重启后的交付才会走到），中止落在那里
    // 同样一条都不交。
    assertNotAborted(signal);
    const deliveredAt = this.now();
    for (const submission of packed) {
      submission.deliveredAt = deliveredAt;
      submission.deliveryCallId = deliveryCallId;
      active.results.delete(submission.submissionId);
    }
    // 内存标记与交给调用方的那一帧先做完：这些从此刻起就是「交过了」（本进程的 `wait` 不会再挑它们）。
    this.transition(active);
    const snapshot = this.emit(active);
    // 落盘确认放在返回**之后**（spec §4.5 的顺序）：失败不该把已经交出去的结果要回来 —— 内存里它
    // 已经是交付过的，重启后最多再交一次（幂等兜底就在那个窗口里），日志是这件事唯一露面的地方。
    // 这一笔写仍要进 `lateWrites`：删对话的顺序是「排空 → 删目录」，排空不把它算进来的话，它会
    // 在目录被删之后把 `task.json` 与 `submission-*.json` 写回来。
    this.trackLateWrite(threadId, this.flush(active, packed).catch((error: unknown) => {
      logger.warn('x_research', 'could not persist the delivery mark', {
        threadId, researchRunId, submissionIds: packed.map((submission) => submission.submissionId),
        err: String(error),
      });
    }));
    return { snapshot, deliveries, evidence, undelivered: this.undeliveredOf(active) };
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
   *  研究只因为点过一次取消就再也追加不了工作）。`cancelledBy` 因此只在真停下东西时才盖章 ——
   *  空操作连「谁取消的」都不该在盘上留下（R81a）。 */
  async cancel(threadId: string, researchRunId: string,
    cancelledBy?: XResearchCancelActor): Promise<XResearchTaskSnapshot> {
    const active = await this.open(threadId, researchRunId);
    if (!active) throw new KydogError('research.not_found', 'X research task not found');
    return this.cancelActive(active, cancelledBy);
  }

  private async cancelActive(active: ActiveResearch,
    cancelledBy?: XResearchCancelActor): Promise<XResearchTaskSnapshot> {
    const inFlight = [...active.submissions.values()].filter(
      (submission) => submission.state === 'queued' || submission.state === 'running',
    );
    if (!inFlight.length) return this.snapshotOf(active);
    // 谁停的（R81a）：有东西真的停下才盖章。空操作的返回必须与调用前逐字节相同。
    if (cancelledBy) active.record.cancelledBy = cancelledBy;
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
   *  给了账本身份（切项目 / 关窗 / 换 provider）时**只等自己那一份在跑的提交**：`interruptActive`
   *  等的就是那个；整条 per-thread 链上还排着替换会话的采集，等它会把一次拆除绑在别人几分钟的
   *  浏览上。没给账本（删对话）时仍然排空整条链 —— 目录随后就被删，迟到的落盘会把一条已经不存在
   *  的研究写回来。排队的那几份在两种路径里都一样：中断只改内存 + 落一次盘，不会再碰浏览器
   *  （带账本那条路上，它们随后还会按 `disposed` 自己收尾一次；thread 还在，那次写盘无害）。 */
  async disposeThread(threadId: string, ledger?: object): Promise<void> {
    for (const active of [...this.active.values()]) {
      if (active.record.threadId === threadId && this.owns(active, ledger)) await this.interruptActive(active);
    }
    if (ledger === undefined) await this.awaitIdle(threadId).catch(() => undefined);
    this.forget(threadId, ledger);
  }

  /** 拆除只认领自己那一份：给了账本身份时，只碰由它最后一次提交的研究；没给（删对话等）
   *  就是整条 thread。`undefined` 的 active 只可能来自卡片 RPC（`get` / `inspect` / `cancel`
   *  打开的缓存）：它不属于任何会话，没有在飞工作时就是一段纯内存残留，跟着这次拆除一起走；
   *  真有在飞工作时谁也认领不了它，留着不动。 */
  private owns(active: ActiveResearch, ledger?: object): boolean {
    if (ledger === undefined || active.ledger === ledger) return true;
    return active.ledger === undefined && !this.hasInFlight(active);
  }

  /** 提交级的「还在队列上或正在跑」：淘汰缓存（`owns`）与重启修复（`repairRestarted`）问的是同一个
   *  事实 —— 盘上还剩这种提交，就是上一个进程留下的。 */
  private hasInFlight(active: ActiveResearch): boolean {
    for (const submission of active.submissions.values()) {
      if (submission.state === 'queued' || submission.state === 'running') return true;
    }
    return false;
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
    // 对话的页跟着对话走：拆除 / 删除之后，这条 thread 不再有几号页可继承（R81h）。
    // **只认整条 thread 的拆除**：给了账本身份的那一次（换会话时 `disposeThread` 带的就是它）
    // 不是「这条对话没了」—— 页还活着，下一条会话的研究照样该继承它。与 R46/R47 守的是同一条边界。
    if (ledger === undefined) this.threadTab.delete(threadId);
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
   *  否则一个顶到 1 MiB 的工件加上壳就装不进包络，而那份结果恰恰是重启后最需要交出去的。
   *
   *  交付的**账本投喂源**（`evidence`）在这一层定：它必须是工件里的 canonical，不是上面裁过的那一份
   *  （R81d）。每条交付最多读一次工件 —— 重启后那条路本来就要读它，读回来的字节直接当投喂源，
   *  不为了喂账本再读第二遍。 */
  private async deliverable(active: ActiveResearch, submission: XResearchSubmission,
    deliveryCallId: string): Promise<{ delivery: XResearchDelivery; evidence: XResearchResult } | null> {
    const { threadId, researchRunId } = active.record;
    const identity = {
      deliveryCallId, submissionId: submission.submissionId,
      submitCallId: submission.submitCallId, operation: submission.operation,
    };
    const artifacts = this.deps.artifacts(threadId, researchRunId);
    const held = active.results.get(submission.submissionId);
    if (held) {
      return {
        delivery: { ...identity, result: held },
        evidence: await this.canonicalFor(submission, held),
      };
    }
    // 工件写失败过：这份结果不在盘上，重启后它就不存在了（R20）。
    if (!submission.artifact) return null;
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
      // 同一份读回来的 canonical 既是交付字节的来源，也是账本的投喂源：一次读，两处用。
      return { delivery: { ...identity, result }, evidence: canonical };
    } catch (error) {
      logger.warn('x_research', 'could not read a delivered artifact', {
        threadId, researchRunId, submissionId: submission.submissionId, err: String(error),
      });
      return null;
    }
  }

  /** 账本吃的那一份观察记录（R81d）：工件里的 canonical，读一次。
   *  **没有工件就没有第二条路**：`persistence: 'failed'` 或旧交付没带 ref 时退回交付副本本身 ——
   *  那正是模型看到的东西，可引用面与改造前逐字相同（不静默放宽，也不凭空造观察）。
   *  工件在但读不回来（字节被改、chunk 缺、ref 不对）同样退回交付副本，并留一条日志：
   *  这一次的可引用面确实比工件窄，那是读失败的事实，不是裁切。 */
  private async canonicalFor(submission: XResearchSubmission,
    clipped: XResearchResult): Promise<XResearchResult> {
    if (!submission.artifact) return clipped;
    try {
      return await this.deps.artifacts(submission.threadId, submission.researchRunId)
        .read(submission.artifact);
    } catch (error) {
      logger.warn('x_research', 'could not read the delivered artifact for the ledger', {
        threadId: submission.threadId, researchRunId: submission.researchRunId,
        submissionId: submission.submissionId, err: String(error),
      });
      return clipped;
    }
  }

  /** 还没交付的清单：与 `deliverableSubmissions` / `counts.undelivered` 同一判据。
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
            if (tabId) {
              active.record.browserTabId = tabId;
              // 采集层写回的页也记到对话上：下一段研究（同一对话）从这里继承（R81h）。
              this.threadTab.set(active.record.threadId, tabId);
            } else {
              delete active.record.browserTabId;
              this.threadTab.delete(active.record.threadId);
            }
          },
        },
        onProgress: (event) => this.progress(active, submission, event),
      });
      // 交付优先用这一份：它就是 `settle` 写结论、并按包络额度裁过的那一份字节
      // （卡与交付出去的结果不许各自一套结论）。结论的原因在**收尾那一刻**取：采集层取消时
      // 照样返回一份结果，所以「跑完了」不等于「跑成功了」（见 `settle`）。
      const cause: 'cancelled' | 'interrupted' | null =
        active.disposed ? 'interrupted' : active.cancelRequested ? 'cancelled' : null;
      active.results.set(submission.submissionId, this.settle(active, submission, result, cause));
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

  /** 收尾：结果的行序就是请求的行序（采集循环按 query / target 顺序跑），工作项按同一个序展开。
   *
   *  `cause` 是「为什么停的」：采集层**不会在取消时抛出**，它把 `browser.cancelled` 映成
   *  `status: 'cancelled'` 的行**返回**（`xResearchSearch` 的 `failure` / `xResearchRead` 的 `halt`），
   *  于是这一轮一样会「跑完」。只看行数会把一段用户刚取消的研究写成 `done`（卡上读「完成
   *  （部分被取消）」），把一段被拆掉的会话写成「完成」—— 两种结论都与事实相反。所以结论由调用方
   *  给出的原因说了算（只要这一轮确实被中止过 —— 证据就是行上的 `cancelled`），行自己的结论照
   *  `concludeRow` 原样保留（§4.7「取消不抹掉观察过的事实」）。 */
  private settle(active: ActiveResearch, submission: XResearchSubmission,
    result: XResearchResult, cause: 'cancelled' | 'interrupted' | null): XResearchResult {
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
    // 「这一轮真的被中止过」的唯一证据在行上：采集层把被中止的行写成 `status: 'cancelled'`
    // （`xResearchSearch` 的 `failure` / `xResearchRead` 的 `halt` 都走这一支）。有这种行时结论由
    // 原因说了算；一行都没有说明这一轮根本没被中止 —— 取消 / 拆除只是恰好落在它收尾之后，
    // 那时把一份已经完整的结论改写成「取消」就等于抹掉已经观察到的事实（§4.7）。
    const aborted = rows.some((row) => row.status === 'cancelled');
    submission.state = cause !== null && aborted ? cause : (concluded ? 'done' : 'interrupted');
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
    this.transition(active, reason);
    await this.flush(active, submissions);
    return this.emit(active);
  }

  /** 只改内存里的那一份与要写的那两份记录，不碰磁盘 —— 「返回之后再落盘」的那条路要先做完这一步。 */
  private transition(active: ActiveResearch, reason?: string): void {
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
  }

  /** 把此刻内存里的 `record` 与给定的提交写到盘上。`wait` 把它放到返回**之后**（spec §4.5）。 */
  private async flush(active: ActiveResearch,
    submissions: readonly XResearchSubmission[]): Promise<void> {
    await this.deps.store.writeTask(active.record);
    for (const submission of submissions) await this.deps.store.writeSubmission(submission);
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
 *  的活账本 —— 反过来的话，排队的提交会在一个已经不存在的会话上起跑。
 *  给了账本身份时只等自己那份在跑的提交；删对话（目录随后就要删）走不带账本的那一条，
 *  它会排空整条 thread 链，迟到的那次落盘因此落在目录消失之前。 */
export async function disposeXResearchThread(threadId: string, ledger?: object): Promise<void> {
  await instance?.disposeThread(threadId, ledger);
}

/** 删对话：盘上的目录由 `XResearchTaskStore.removeThread` 删，这里淘汰内存缓存 ——
 *  删一条从没建过会话的对话走的正是这条路（没有 `disposeThread` 可走，缓存却可能还在）。 */
export function forgetXResearchThread(threadId: string): void {
  instance?.forget(threadId);
}
