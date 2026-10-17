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
import { xResearchTaskSnapshot, xResearchTaskState } from '../../shared/xResearchTask';
import type { XResearchTaskStore } from './xResearchTaskStore';
import type {
  XArticleFacts, XReadObservation, XReadRequest, XResearchResult, XSearchObservation, XSearchRequest,
} from './xResearchTypes';
import type { XBudgetPolicy } from './xResearchBudget';
import type { XResearchProgressEvent } from './xResearchSearch';

/** 进度事件归采集层（它知道自己在哪一段）：任务侧只消费，不另写一份形状。 */
export type { XResearchProgressEvent };

export type XResearchTaskOwner = { threadId: string; runId: string; projectRoot: string };

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

/** 一个研究在本进程里的活状态。盘上只有落盘边界那一刻的副本，实时数字只在这里。 */
type ActiveResearch = {
  record: XResearchTaskRecord;
  submissions: Map<string, XResearchSubmission>;
  controller: AbortController;
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
      controller: new AbortController(),
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
      controller: new AbortController(),
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
    const active = opened ?? this.create(owner, researchRunId);
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
      active.record.submissionIds.pop();
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
    for (;;) {
      const chain = this.chains.get(threadId);
      if (!chain) return;
      await chain.catch(() => undefined);
      if (this.chains.get(threadId) === chain) return;
    }
  }

  /** 每个 thread 一条尾链：x 的风控与「一个 thread 一个标签页」都要求串行（spec §4.3）。 */
  private enqueue(active: ActiveResearch, submission: XResearchSubmission, work: XResearchWorkRequest): void {
    const threadId = active.record.threadId;
    const prior = this.chains.get(threadId) ?? Promise.resolve();
    // 一条链上的失败不许卡住后续提交：`run` 自己吞掉工作体的异常，这里再兜一次。
    const run = prior.catch(() => undefined).then(() => this.run(active, submission, work));
    this.chains.set(threadId, run);
    const release = (): void => { if (this.chains.get(threadId) === run) this.chains.delete(threadId); };
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
      this.settle(submission, result);
    } catch (err) {
      // 工作体抛出 = 这一轮没有结果。没有结果就没有任何行结论（见 `interrupt`）。
      // 先留一条诊断：抛出被收在这里，日志是它唯一露面的地方。
      logger.warn('x_research', 'work body threw', {
        threadId: active.record.threadId, researchRunId: active.record.researchRunId,
        submissionId: submission.submissionId, err: String(err),
      });
      this.interrupt(submission);
    }
    await this.persist(active, [submission]);
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
  private settle(submission: XResearchSubmission, result: XResearchResult): void {
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
  }

  /** 没有结果的工作项停在这里：`state: 'stopped'` + `status: null` 就是「中断」在投影里的形状。 */
  private interrupt(submission: XResearchSubmission): void {
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
   *  `reason` 只给「不是投影推出来的」那一个结论用（进程重启后的修复）。 */
  private async persist(active: ActiveResearch,
    submissions: readonly XResearchSubmission[] = [],
    reason?: string): Promise<XResearchTaskSnapshot> {
    active.record.revision += 1;
    active.record.updatedAt = this.now();
    const settled = this.project(active);
    active.record.state = settled.state;
    const stateReason = reason ?? settled.reason;
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
   *  （Task 2 的调用方约定）。 */
  private project(active: ActiveResearch): { state: XResearchTaskState; reason?: string } {
    const submissions = [...active.submissions.values()];
    if (!submissions.length || submissions.length !== active.record.submissionIds.length) {
      return { state: 'interrupted', reason: 'submission_unreadable' };
    }
    return { state: xResearchTaskState(submissions) };
  }
}
