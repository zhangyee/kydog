// 采集结果的「状态」与「停止原因」两个词表。
//
// 它们同时被采集层（`src/main/x/*`）和 shared 层的任务投影（`./xResearchTask`）用到，
// 所以归 shared 所有：shared 被 preload / 渲染层引用，反向 import main 是分层倒置。
// `src/main/x/xResearchTypes.ts` 从本文件 re-export，采集层原来那批 import 一行不用改。

/** v2 observations describe rendered UI facts, never platform-wide completeness. */
export type XResearchStatus = 'observed' | 'partial' | 'explicit_empty' | 'auth_required' | 'action_required' | 'rate_limited' | 'access_denied' | 'unavailable' | 'cancelled' | 'failed';

export type XStopReason = 'explicit_ui_end' | 'cursor_exhausted' | 'source_unavailable' | 'budget_reached' | 'action_failed' | 'navigation_failed' | 'identity_unproven' | 'wait_timeout' | 'access_barrier' | 'cancelled' | 'agent_stopped';
