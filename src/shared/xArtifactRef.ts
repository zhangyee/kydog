// 工件的身份（`XArtifactRef`）：不透明目录 id + 校验和 + 归属那一次调用。
//
// 它同时出现在交付出去的结果（采集层的 `XResearchResult.artifact`）和**提交记录**
// （`./xResearchTask` 的 `XResearchSubmission.artifact`）里 —— 后者是重启后把结果从工件读回来的
// 唯一依据（R20：结果只按今天的工件格式落一次）。提交记录是 shared 的类型，而 shared 被 preload /
// 渲染层引用，反向 import main 是分层倒置，所以这个纯数据形状归 shared 所有。
// `src/main/x/xResearchTypes.ts` 从本文件 re-export，采集层原来那批 import 一行不用改。
export interface XArtifactRef {
  version: 1;
  directoryId: string;
  manifest: 'manifest.json';
  sha256: string;
  bytes: number;
  runId: string;
  callId: string;
  batchId: string;
  operation: 'search' | 'read';
}
