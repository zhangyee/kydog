// 只放「研究 → 提交 → 工作项」三层身份的最小形状（spec §4.1、§4.4）。
// 快照、交付壳与投影函数在后续任务里往这个文件上补，字段名不动。
//
// `status` / `stopReason` 的取值就是采集层实际写出来的那两个联合类型：抄一份到这里
// 会让两份词表各自漂移（卡片上一个不认识的词，任何测试都不会红）。这里只做 type-only
// import，编译后被抹掉，渲染层打包不会因此把主进程代码拉进来。
import type { XResearchStatus, XStopReason } from '../main/x/xResearchTypes';

/** 研究段的状态词。`interrupted` 只在盘上还留着未收尾的工作时出现（§4.4 的崩溃诚实性）。 */
export type XResearchTaskState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type XResearchSection = 'search' | 'read';

/** 工作项的实时阶段：搜索行取自 `searchX` 的 stage，读取行取自 `XReadStage.current`，
 *  外加排队与收尾。它只活在任务侧，不进观察结果（§5.4「phase 不进 row」）。 */
export type XResearchWorkState =
  | 'queued' | 'navigating' | 'collecting' | 'waiting' | 'scrolling' | 'stopped';

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
