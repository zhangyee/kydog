// `x_research` 工具结果的壳（spec §4.5）。
//
// 它只活在主进程：Task 5 造它、工具把它当 `details` 返回、恢复链从此处取 `delivery.result` 喂证据账本。
// 渲染层靠解析工具输出的 JSON（`kind` / `action` / `researchRunId`）锚定卡片，从不需要这个类型 ——
// 而 `XResearchResult` 是采集层的类型（`./xResearchTypes`），所以壳归 main，不进 shared：
// shared 被 preload / 渲染层引用，反向依赖 main 是分层倒置。快照（渲染层契约）才在 shared。
import type { XResearchSubmission, XResearchTaskSnapshot, XResearchTaskState } from '../../shared/xResearchTask';
import type { XResearchResult } from './xResearchTypes';

/** 一次交付：哪一份提交的结果，以及那一份结果本身（与旧工具结果同形，1 MiB 裁剪不变）。
 *  `result.budgetUsage.outputBytes` 在这里盖的是**整个包络**（壳 + 快照 + 这份结果）的字节数，
 *  不再是这一份结果自己的大小 —— 壳也要占字节，定点只能按模型看到的那一整包算（有意为之，
 *  Task 9 读这个字段当这一轮的输出用量）。 */
export type XResearchDelivery = {
  deliveryCallId: string;
  submissionId: string;
  submitCallId: string;
  operation: 'search' | 'read';
  result: XResearchResult;
};

/** `inspect` 的一页（spec §4.5）。它**不是交付**：只是把同一批记录按 view 分页给模型看，
 *  不喂证据账本（「可引用 = 已交付」）—— 所以 `items` 是 `unknown[]`：壳只保证它是分页的载荷，
 *  具体行形状归任务 service（`XResearchInspectItem`），壳不反向依赖采集层的行类型。 */
export type XResearchInspectPage = {
  view: 'rows' | 'deliveries' | 'failures';
  items: unknown[];
  nextCursor?: string;
};

/** 工具结果的外壳。`kind` / `action` / `researchRunId` / `status` 是协议面（渲染层锚定与
 *  transcript 解析都只认它们），快照其余字段可以按包络预算省略，这四个键不许省。 */
/** 工具结果 `details` 里那一份结果：壳（下面这个类型）取 `delivery.result`，改造前的平铺 details
 *  原样返回。`null` = 这个壳没有结果（`submit` / `inspect` / `cancel`）—— 它没有可入账、可恢复、
 *  可引用的东西，也不走旧路径。
 *
 *  下面三个函数是账本（`./xResearchEvidence`）、范围账本（`./xResearchScopeFacts`）与恢复链
 *  （`./xResearchBranch`）共同的壳判据。以前账本那两处各抄一份，漂移之后一份壳能借另一份提交的
 *  结果入账 —— 所以放在壳自己的文件里，只有一份。 */
export function deliveryResult(details: unknown): unknown | null {
  if (!details || typeof details !== 'object') return details;
  const value = details as { kind?: unknown; delivery?: { result?: unknown } };
  return value.kind === 'x_research' ? value.delivery?.result ?? null : details;
}

/** 这条工具结果属于哪一轮调用：平铺 details 说的是自己的 `callId`，壳说的是**交付**那一轮
 *  （`delivery.deliveryCallId`）—— 壳里 `result.callId` 是**提交**那一轮，拿它比 `toolCallId`
 *  永远不相等。 */
export function resultCallId(details: unknown): unknown {
  if (!details || typeof details !== 'object') return null;
  const value = details as {
    kind?: unknown; callId?: unknown; delivery?: { deliveryCallId?: unknown };
  };
  return value.kind === 'x_research' ? value.delivery?.deliveryCallId ?? null : value.callId ?? null;
}

/** 壳自己的两轮也得对得上：`result.callId` 是提交那一轮，必须等于壳记下的 `submitCallId`。
 *  只认「交付那一轮」的话，一份壳能借另一份提交的结果入账 / 恢复 / 绑标签页。平铺 details
 *  没有这层壳，放行。 */
export function shellChainValid(details: unknown): boolean {
  if (!details || typeof details !== 'object') return true;
  const value = details as {
    kind?: unknown;
    delivery?: { submitCallId?: unknown; result?: { callId?: unknown } | null };
  };
  if (value.kind !== 'x_research') return true;
  const delivery = value.delivery;
  return delivery?.result?.callId === delivery?.submitCallId;
}

export type XResearchDeliveryEnvelope = {
  kind: 'x_research';
  action: 'submit' | 'wait' | 'inspect' | 'cancel';
  researchRunId: string;
  status: XResearchTaskState;
  snapshot: XResearchTaskSnapshot;
  delivery?: XResearchDelivery;
  inspect?: XResearchInspectPage;
  undelivered?: Array<{
    submissionId: string;
    operation: 'search' | 'read';
    objective: string;
    state: XResearchSubmission['state'];
  }>;
};
