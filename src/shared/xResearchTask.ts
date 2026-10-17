// 「研究 → 提交 → 工作项」三层身份的最小形状（spec §4.1、§4.4），加上研究级快照与它的投影（§5.3）。
//
// `status` / `stopReason` 的取值就是采集层实际写出来的那两个联合类型：抄一份到这里
// 会让两份词表各自漂移（卡片上一个不认识的词，任何测试都不会红）。两个词表放在
// `./xResearchStatus`（采集层的 `src/main/x/xResearchTypes.ts` 从那里 re-export 同一个声明）。
import type { XResearchStatus, XStopReason } from './xResearchStatus';
import type { XArtifactRef } from './xArtifactRef';
import type { XReportRunScopeFacts, XReportScopeFacts } from './xReportScopeFacts';

/** 研究段的状态词。`interrupted` 只在盘上还留着未收尾的工作时出现（§4.4 的崩溃诚实性）。 */
export type XResearchTaskState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type XResearchSection = 'search' | 'read';

/** 工作项的实时阶段：搜索行取自 `searchX` 的 stage，读取行取自 `XReadStage.current`，
 *  外加排队与收尾。它只活在任务侧，不进观察结果（§5.4「phase 不进 row」）。
 *  `scrolling` 是搜索行的「正在滚下一页」，`action` 是读取行的「正在点一次动作」（展开正文 /
 *  进入文章 / 展开回复）—— 两者都是采集层真实存在的 stage，不合并成一个词。 */
export type XResearchWorkState =
  | 'queued' | 'navigating' | 'collecting' | 'waiting' | 'scrolling' | 'action' | 'stopped';

export type XResearchWorkItem = {
  workItemId: string;
  section: XResearchSection;
  label: string;
  product: 'Top' | 'Latest' | null;
  state: XResearchWorkState;
  phaseDetail: 'root' | 'article' | 'return' | 'discussion' | null;
  status: XResearchStatus | null;
  stopReason: XStopReason | null;
  reason: string | null;
  posts: number;
  omitted: number;
  pages: number;
  hasRoot: boolean;
  replies: number;
  article: 'not_requested' | 'pending' | 'entry' | 'body' | 'failed';
  scrolls: number;
  expandActions: number;
};

/** 一次提交的工作单位：一组 query（search）或一组目标（read）。
 *  `deliveredAt` / `deliveryCallId` 是「交付过没有」的权威（跨重启一致，§4.5）。 */
export type XResearchSubmission = {
  version: 1;
  submissionId: string;
  researchRunId: string;
  threadId: string;
  submitCallId: string;
  batchId: string;
  runId: string;
  operation: 'search' | 'read';
  objective: string;
  state: 'queued' | 'running' | 'done' | 'cancelled' | 'interrupted';
  budget: { scrolls: number; expandActions: number };
  usage: { posts: number; scrolls: number; expandActions: number };
  workItems: XResearchWorkItem[];
  createdAt: string;
  endedAt: string | null;
  /** 这份结果的工件（R20：结果只按今天的工件格式落一次，不另写 canonical 副本）。
   *  重启后的交付靠它把结果读回来；工件写失败过的那一份没有这个字段 —— 那份结果只在内存里可交付。 */
  artifact?: XArtifactRef;
  /** 收尾那一刻序列化算出来的 scope 事实（R24）：工件里是序列化之前的 canonical，只有这里存着
   *  这两份。重启后的交付把它们补回结果再序列化，卡与交付说的仍是同一套事实。 */
  reportScopeFacts?: XReportScopeFacts;
  reportRunScopeFacts?: XReportRunScopeFacts;
  deliveredAt?: string;
  deliveryCallId?: string;
};

/** 一段研究的索引，落在 `task.json`。故意小：工作项在 `submission-*.json`，结果在 `canonical-*.json`。 */
export type XResearchTaskRecord = {
  version: 1;
  researchRunId: string;
  threadId: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  state: XResearchTaskState;
  stateReason?: string;
  browserTabId?: string;
  submissionIds: string[];
};

/** 研究级快照：卡片与 `xResearch.taskGet` / `taskList` 的唯一数据源（spec §5.3）。
 *  里面每个数字都是工作项字段的累加，没有百分比、剩余时间或任何估算。 */
export type XResearchTaskSnapshot = {
  researchRunId: string;
  threadId: string;
  revision: number;
  /** 生命周期取 `record.state`：它是唯一权威（唯一写者是任务 service，恢复时由它写 `interrupted`）。
   *  `counts` 是按**工作项**分桶的，两者可以不一致 —— 状态词取这里，桶只喂行内数字（「失败 2」）。 */
  state: XResearchTaskState;
  stateReason?: string;
  createdAt: string;
  updatedAt: string;
  /** 卡头那句话：这段研究**最初**一次提交要回答的问题（R10 / spec §5.3）——
   *  后续提交只是往同一段研究里追加步骤，拿最新一次会让卡头在运行中换题。 */
  objective: string;
  browserTabId?: string;
  counts: {
    submissions: number;
    queued: number;
    running: number;
    done: number;
    failed: number;
    cancelled: number;
    interrupted: number;
    posts: number;
    replies: number;
    articles: number;
    undelivered: number;
    /** 按段分开的进度（spec §5.3 的「读取 2/20 个目标」）：`*Done` 是这一段**收尾**了的行数
     *  （成功、失败、取消、中断都算收尾），`*Total` 是这一段的 `search` / `read` 行数。
     *  分子故意不是「成功数」：2 成功 + 2 失败收尾的研究若说「读取 2/4」，读者会以为还有两个目标
     *  在跑，而成功与否另有 `done` / `failed` 两个桶交代。
     *  卡片直接读这四个数，不拿 `read.length` 冒充「已读」——运行中那样读会被读成「20 个都读完了」。 */
    searchDone: number;
    searchTotal: number;
    readDone: number;
    readTotal: number;
  };
  budget: { scrolls: number; expandActions: number };
  usage: { posts: number; scrolls: number; expandActions: number };
  search: XResearchWorkItem[];
  read: XResearchWorkItem[];
};

/** 判定「这一行收尾了、且是源侧拒绝/失败」（spec §5.3 的「有失败」判据）。
 *  `inspect` 的 `failures` 视图用同一个集合：两个读者各写一份，迟早各自漂移。 */
export const X_RESEARCH_FAILURE_STATUSES: ReadonlySet<XResearchStatus> = new Set([
  'failed', 'unavailable', 'access_denied', 'auth_required', 'rate_limited', 'action_required',
]);

/** 研究状态。顺序就是优先级（spec §5.3 的卡状态表 + §4.4 的中断诚实性）：
 *  中断 > 取消 > 进行中 > 有失败 > 完成。
 *
 *  调用方保证传入的列表非空（`record.submissionIds` 非空却读不出任何 submission 时，
 *  由 service 写 `interrupted`，不要调用本函数）；`[]` 落出的 `completed` 不是结论。 */
export function xResearchTaskState(submissions: readonly XResearchSubmission[]): XResearchTaskState {
  // 盘上还留着未收尾的工作 → 进程被杀过，任何「最新」的说法都是假的。
  if (submissions.some((submission) => submission.state === 'interrupted')) return 'interrupted';
  // 取消是用户下的动作：只有整段研究都被取消才算取消，否则它可能已有成功的工作。
  if (submissions.length > 0 && submissions.every((submission) => submission.state === 'cancelled')) {
    return 'cancelled';
  }
  if (submissions.some((submission) => submission.state === 'queued' || submission.state === 'running')) {
    return 'running';
  }
  for (const submission of submissions) {
    if (submission.workItems.some((item) => item.status !== null && X_RESEARCH_FAILURE_STATUSES.has(item.status))) {
      return 'failed';
    }
  }
  return 'completed';
}

type XResearchWorkItemBucket = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** 工作项落进且只落进一个桶：先按阶段分「还没开始 / 在飞」，收尾的再按状态结论分。
 *  状态那一支是穷举的 switch —— `XResearchStatus` 将来多一个取值，这里会编译失败，
 *  逼人先决定它属于哪个桶，而不是静悄悄落进「取消」。 */
function workItemBucket(item: XResearchWorkItem): XResearchWorkItemBucket {
  if (item.state === 'queued') return 'queued';
  if (item.state !== 'stopped') return 'running';
  switch (item.status) {
    case 'observed':
    case 'partial':
    case 'explicit_empty':
      return 'done';
    case 'failed':
    case 'unavailable':
    case 'access_denied':
    case 'auth_required':
    case 'rate_limited':
    case 'action_required':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case null:
      // 收尾了却没有任何状态结论：进程被杀留下的那一类，照 §4.4 说「中断」，不猜成失败或成功。
      return 'interrupted';
  }
}

export function xResearchTaskSnapshot(record: XResearchTaskRecord,
  submissions: readonly XResearchSubmission[]): XResearchTaskSnapshot {
  const workItems = submissions.flatMap((submission) => submission.workItems);
  const counts = {
    submissions: submissions.length,
    queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, interrupted: 0,
    posts: 0, replies: 0, articles: 0, undelivered: 0,
    searchDone: 0, searchTotal: 0, readDone: 0, readTotal: 0,
  };
  // 段内还没收尾的行数（排队 + 在飞），收尾数由「总数 − 它」算出来 —— 见循环后的那两行。
  const sectionPending: Record<XResearchSection, number> = { search: 0, read: 0 };
  for (const item of workItems) {
    const bucket = workItemBucket(item);
    counts[bucket] += 1;
    // 段内进度仍只用 `workItemBucket` 这一份分桶，不另写「算不算收尾」的规则：收尾 = 不在这两个桶里。
    // 分母只认这两段：store 把盘上的 JSON 直接 `as XResearchTaskRecord` 落类型，第三种 `section`
    // 到不了类型层。那种行不落进任何一段 —— 它本来也不会成为一行（快照两段都按这两个词过滤），
    // 所以两个分母都不该动。曾经这里的分母是 `else`：一个坏值会胀大读取的分母、又永远不出现，
    // `sectionPending[那个值]` 还算出一个 NaN。
    const section: XResearchSection | null =
      item.section === 'search' || item.section === 'read' ? item.section : null;
    if (section === 'search') counts.searchTotal += 1;
    else if (section === 'read') counts.readTotal += 1;
    if (section !== null && (bucket === 'queued' || bucket === 'running')) sectionPending[section] += 1;
    // `posts` 只由 search 工作项填写；read 工作项恒为 0，否则卡头会双计（§5.4 的「收 N 帖」
    // 就是搜索行的去重帖数）。按 section 过滤而不是信任那个 0：将来 read 行填了 posts，
    // 卡头也不会多出一个「读取也收了 N 帖」的数字。
    if (item.section === 'search') counts.posts += item.posts;
    counts.replies += item.replies;
    if (item.article === 'body') counts.articles += 1;
  }
  // 段内的分子是**收尾**了的行数，不是「成功了几行」：2 成功 + 2 失败收尾的研究若说「读取 2/4」，
  // 读者会以为还有两个目标在跑，而卡上「失败 N」已经把那两行交代过了。分母仍只是这一段的行数，
  // 所以分子恒 ≤ 分母。`counts.done` 仍只装成功那一桶 —— 别的读者按它读，口径不动。
  counts.searchDone = counts.searchTotal - sectionPending.search;
  counts.readDone = counts.readTotal - sectionPending.read;
  // 「没交付」只算已经收尾、盘上还没有交付标记的提交：还在跑的提交压根没有结果可交付，
  // 算进去会让卡上那个数字变成对未来的估算。两处都按「空值」判而不是逐字比 `null` / `undefined`：
  // store 直接 `JSON.parse(...) as XResearchSubmission`，只有真时间戳才算交付过（`deliveredAt: null`
  // 仍是没交付），缺 `endedAt` 的是还没收尾。
  counts.undelivered = submissions.filter(
    (submission) => submission.endedAt != null && !submission.deliveredAt,
  ).length;
  const usage = { posts: counts.posts, scrolls: 0, expandActions: 0 };
  const budget = { scrolls: 0, expandActions: 0 };
  for (const item of workItems) {
    usage.scrolls += item.scrolls;
    usage.expandActions += item.expandActions;
  }
  // 预算按提交时各自声明的上限相加：一次研究可以追加多次提交，每一份的额度都是真的。
  for (const submission of submissions) {
    budget.scrolls += submission.budget.scrolls;
    budget.expandActions += submission.budget.expandActions;
  }
  return {
    researchRunId: record.researchRunId,
    threadId: record.threadId,
    revision: record.revision,
    // 生命周期由 task.json 说了算（唯一写者是任务 service，恢复时由它写 `interrupted`）；
    // `xResearchTaskState` 是 service 做这个决定时用的那把尺子，不是投影里的第二份真相。
    state: record.state,
    stateReason: record.stateReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    objective: submissions[0]?.objective ?? '', // R10 / spec §5.3：最早一次提交，`[]` 时为空串
    browserTabId: record.browserTabId,
    counts,
    budget,
    usage,
    search: workItems.filter((item) => item.section === 'search'),
    read: workItems.filter((item) => item.section === 'read'),
  };
}
