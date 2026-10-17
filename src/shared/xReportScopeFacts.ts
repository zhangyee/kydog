// 一次调用 / 一段研究的 scope 事实（`XReportScopeFacts` / `XReportRunScopeFacts`）。
//
// 它们由序列化时（`src/main/x/xResearchOutput.ts`）算出来，同时要跟着**提交记录**落盘：
// 工件里是序列化之前的 canonical，重启后的交付只有从提交记录里才能把这两份事实补回去
// （R24）。提交记录是 shared 的类型，而 shared 被 preload / 渲染层引用，反向 import main
// 是分层倒置，所以这两个纯数据形状归 shared 所有（先例是 `./xArtifactRef` 与
// `./xResearchStatus`）。`src/main/x/xResearchTypes.ts` 从本文件 re-export，采集层与
// 序列化那批 import 一行不用改。它们只数事实，不带来源或引用权威。
import type { XResearchStatus, XStopReason } from './xResearchStatus';

/** Exact counts for this one serialized tool call. Unknown reason values include
 * absent reasons and unclassified text; they must never become report prose. */
export interface XReportScopeFacts {
  version: 1;
  operation: 'search' | 'read';
  reasonSource: 'barrier.reason' | 'reason';
  totalRows: number;
  statusCounts: Partial<Record<XResearchStatus, number>>;
  stopReasonCounts: Partial<Record<XStopReason, number>>;
  reasonCounts: Record<string, number>;
  replyScopeCounts: Partial<Record<'unknown'|'ui_scope_end_observed'|'cursor_exhausted', number>>;
}
/** Distinct actual calls on the current branch/run; no source or citation authority. */
export interface XReportRunScopeFacts {
  version: 1;
  runId: string;
  callCount: number;
  unavailableCallCount: number;
  search: XReportScopeFacts;
  read: XReportScopeFacts;
}
