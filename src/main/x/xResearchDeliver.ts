// 交付：一次 `wait` 给出该 run 所有已收尾、未交付的结果（`deliveries` 一条一个元素），外面包一层
// 壳，整包重新量到 1 MiB 的定点（spec §4.5、§5.2）。
//
// 壳是 main↔模型 transcript 的协议面（`./xResearchTaskShell`）：`kind` / `action` / `researchRunId` /
// `status` 这四个键渲染层锚定与 transcript 解析都只认它们，包络再紧也不许省。可省的是**模型可见性**：
// 快照的行明细（卡片走 RPC，不受影响）先让位，然后是 `undelivered` 清单 —— 快照里的
// `counts.undelivered` 还在，模型据此再 `wait` 一次即可；再然后是把快照省到只剩数字类事实；
// 最后（R25）才省结果自己的省略账本（`metadataOmissions` → `contentMetadataOmissions` →
// `reportScopeFacts`）。四个协议键与结果本身一律不动，省了账本就置 `delivery.truncated`。
//
// `delivery` 在交付路径上不动（控制器裁决 T5/B'）：一份结果在**收尾时**就按量出来的包络额度裁好，
// 交付只是把它装进壳。这样同一份提交只有一份裁过的副本 —— 工件里是完整 canonical，交付的是
// `settle` 写结论用的那一份，卡与交付永远说同一件事（`clipForEnvelope`）。
//
// 两个字节数说的不是同一件事，别混：**裁切读的是整包实测**（`clipForEnvelope` 里
// `measuredBytes(envelopeOf(...))`，判据是壳 + 结果在模型眼里真的占多少）；而
// `delivery.result.budgetUsage.outputBytes` 在交付这一层由 `stampEnvelopeBytes` 盖成**整包**的字节数，
// 只是给模型看的一个读数，没有任何裁切闸读它（结果自己序列化时那个数按投影后的文本算，
// 会比整包小一块 —— 拿它当闸就是少裁）。
import { serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
import { X_RESEARCH_MAX_OUTPUT_BYTES, type XResearchResult } from './xResearchTypes';
import type {
  XResearchDelivery, XResearchDeliveryEnvelope, XResearchInspectPage,
} from './xResearchTaskShell';
import type { XResearchSubmission, XResearchTaskSnapshot } from '../../shared/xResearchTask';

/** 一次 `wait` 要交付的清单：该 run 下**所有**「已收尾、未交付」的提交，按 `createdAt` 升序。
 *
 *  同一毫秒的两条按 `submissionId` 定序，与 `listSubmissions` 的排序是同一个比较器 —— 否则
 *  同一个盘的两次读取会给出两种先后。这里只回答「该轮到谁、按什么顺序」，不回答「拿不拿得到」：
 *  结果在内存里还是在工件里（重启后）由服务判，连工件 ref 都没有的那一份同样算「没交付」——
 *  它不该被悄悄跳过，也不该被假装交付过。
 *
 *  「已收尾」= `endedAt != null`；「未交付」= 没有真时间戳 —— 盘上的 `deliveredAt: null` 是
 *  store 直接 `JSON.parse` 出来的空值，它仍然是没交付（与快照 `counts.undelivered` 同一判据）。 */
export function deliverableSubmissions(
  submissions: readonly XResearchSubmission[],
): XResearchSubmission[] {
  return submissions
    .filter((submission) => submission.endedAt != null && !submission.deliveredAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)
      || a.submissionId.localeCompare(b.submissionId));
}

export type XResearchEnvelopeInput = {
  researchRunId: string;
  snapshot: XResearchTaskSnapshot;
  /** 这一轮交付的结果，一条一个元素；没有可交付的（队列空了 / 结果都不在了）就是空数组。 */
  deliveries: readonly XResearchDelivery[];
  undelivered: XResearchDeliveryEnvelope['undelivered'];
  action: XResearchDeliveryEnvelope['action'];
  /** `inspect` 的那一页：也算进整包字节 —— 模型看到的一切都在同一次测量里。 */
  inspect?: XResearchInspectPage;
};

/** 交付身份里除那一份结果以外的部分：收尾时就全知道，只有 `deliveryCallId` 要等 `wait` 那一轮。 */
export type XResearchDeliveryIdentity = {
  researchRunId: string;
  snapshot: XResearchTaskSnapshot;
  submissionId: string;
  submitCallId: string;
  operation: 'search' | 'read';
};

/** 整包的字节数：`content` + `details` 一起量。模型看到的是整包，不是只有 `details`，
 *  所以定点也必须按整包算（`xResearchToolResult` 与 `measure` 是同一把尺子）。 */
function measuredBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return Buffer.byteLength(JSON.stringify(xResearchToolResult({ result: value, text })), 'utf8');
}

function envelopeOf(input: XResearchEnvelopeInput): XResearchDeliveryEnvelope {
  return {
    kind: 'x_research',
    action: input.action,
    researchRunId: input.researchRunId,
    status: input.snapshot.state,
    snapshot: input.snapshot,
    ...(input.deliveries.length ? { deliveries: [...input.deliveries] } : {}),
    ...(input.inspect ? { inspect: input.inspect } : {}),
    ...(input.undelivered?.length ? { undelivered: input.undelivered } : {}),
  };
}

/** 包络紧的时候快照的形状：行明细让位，其余（协议键、counts、usage、预算、objective）都留着。 */
function tightSnapshot(snapshot: XResearchTaskSnapshot): XResearchTaskSnapshot {
  return { ...snapshot, search: [], read: [] };
}

/** 定点：把整包字节数盖在每条 `deliveries[i].result.budgetUsage.outputBytes` 上，反复量到稳定 ——
 *  字节数写着它自己，多一位数就会再变一次（与 `measure` 同一个循环，不设上限地收敛）。
 *  一份交付的读数说的是**它到达时那一整包**（壳 + 快照 + 本轮全部交付），不是它自己的大小；
 *  同一轮交付的每一条因此带着同一个数。 */
function stampEnvelopeBytes(envelope: XResearchDeliveryEnvelope): number {
  for (;;) {
    const bytes = measuredBytes(envelope);
    const results = (envelope.deliveries ?? []).map((delivery) => delivery.result);
    if (results.every((result) => result.budgetUsage.outputBytes === bytes)) return bytes;
    for (const result of results) result.budgetUsage.outputBytes = bytes;
  }
}

/** 这一包在 1 MiB 的定点之内吗：服务靠它决定还能不能再塞一份（量法与 `deliverEnvelope` 同一把尺子）。
 *  它会把整包字节数盖到试装的那几条结果上；没装下的那一条随后会由下一次交付重新盖。 */
export function fitsDeliveryEnvelope(input: XResearchEnvelopeInput): boolean {
  return stampEnvelopeBytes(envelopeOf(input)) <= X_RESEARCH_MAX_OUTPUT_BYTES;
}

/** 一次 `wait` 的壳占多少字节：协议键 + 快照按紧的形状 + 交付身份（不含结果）。
 *  量出来的数就是这份结果能用的**额度**的下限 —— 没有写死的壳大小。 */
function shellBytes(identity: XResearchDeliveryIdentity): number {
  return measuredBytes({
    kind: 'x_research', action: 'wait',
    researchRunId: identity.researchRunId, status: identity.snapshot.state,
    snapshot: tightSnapshot(identity.snapshot),
    delivery: {
      // 这一轮 `wait` 的 callId 到交付时才知道：拿这次提交的 `submitCallId` 占位 —— 同一份
      // transcript 里的同一类 id，比写死一个长度更接近实际。差额由 `deliverEnvelope` 的最后一档省兜住。
      deliveryCallId: identity.submitCallId,
      submissionId: identity.submissionId,
      submitCallId: identity.submitCallId,
      operation: identity.operation,
    },
  });
}

/** 控制器裁决（T5，B'）：**收尾时**按量出来的包络额度把交付副本裁一次，交付路径不再裁第二次。
 *  装得下就原样交付（今天那份字节不因为包络而重新序列化）；装不下就按同一套省略机制再裁，
 *  额度靠整包实测校正 —— 壳的标点与文本转义和「结果的包裹」不是逐字节可加的。 */
export function clipForEnvelope(identity: XResearchDeliveryIdentity & { result: XResearchResult }): XResearchResult {
  let budget = X_RESEARCH_MAX_OUTPUT_BYTES - shellBytes(identity);
  let delivered = identity.result;
  // 定点循环，不靠闭式解：额度是按「壳 + 结果」量出来的，而结果自己的字节数写着它自己
  // （`outputBytes` 盖的是整包字节），两者互相影响 —— 只差个位数到几十字节的量，一两轮就收敛。
  // 取不到就停手：交付侧还会把快照省到只剩数字类事实，最后那一步才是硬失败。
  //
  // 判据只认**整包实测**，不读 `budgetUsage.outputBytes`：那个数说的是序列化那一刻按
  // `content.text`（过 1 MiB 时是投影后的文本）量出来的字节，而交付壳的文本是把整份结果
  // 原样放进去的 —— 投影过的结果因此会少报出投影省下的那一块，拿它当闸就会漏过 1 MiB
  // （二十个目标各带五百个 Article 缺口那一档实测差 1.9 KB）。
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const over = measuredBytes(envelopeOf({
      ...identity, action: 'wait', undelivered: [], deliveries: [{
        deliveryCallId: identity.submitCallId, submissionId: identity.submissionId,
        submitCallId: identity.submitCallId, operation: identity.operation, result: delivered,
      }],
    })) - X_RESEARCH_MAX_OUTPUT_BYTES;
    if (over <= 0) return delivered;
    // 多扣 1 字节：每轮都必须真的少放一点东西，否则同一份额度会原地打转。
    budget -= over + 1;
    delivered = serializeXResearchResult(delivered, undefined, budget).result;
  }
  return delivered;
}

/** 壳 + 快照 + 这一轮的全部结果，量到 1 MiB 以内再交给工具层。 */
export function deliverEnvelope(input: XResearchEnvelopeInput): {
  content: { type: 'text'; text: string }[];
  details: XResearchDeliveryEnvelope;
} {
  const envelope = envelopeOf(input);
  let bytes = stampEnvelopeBytes(envelope);
  if (bytes > X_RESEARCH_MAX_OUTPUT_BYTES) {
    // 行明细是给模型看进度用的：它与卡片（走 RPC 的快照）不是同一份数据，省它不丢卡上的事实。
    envelope.snapshot = tightSnapshot(input.snapshot);
    bytes = stampEnvelopeBytes(envelope);
  }
  if (bytes > X_RESEARCH_MAX_OUTPUT_BYTES && envelope.undelivered) {
    delete envelope.undelivered;
    bytes = stampEnvelopeBytes(envelope);
  }
  if (bytes > X_RESEARCH_MAX_OUTPUT_BYTES) {
    // 最后一档：快照只剩数字类事实（spec §4.5「快照其余字段可按包络预算省略」）。走到这里说明
    // 收尾量出来的额度被这一轮 `wait` 的 id 长度（或之后又追加的提交）撑破了；省掉的仍是
    // 模型可见性，卡片走 RPC，一个字都不少。
    const minimal = { ...envelope.snapshot, search: [], read: [], objective: '' };
    delete minimal.browserTabId;
    delete minimal.stateReason;
    envelope.snapshot = minimal;
    bytes = stampEnvelopeBytes(envelope);
  }
  if (bytes > X_RESEARCH_MAX_OUTPUT_BYTES) {
    // 快照已经没有可省的文本之后：省结果自己的省略账本（控制器裁决 R25）。顺序固定为
    // `metadataOmissions` → `contentMetadataOmissions` → `reportScopeFacts`，每省一项重新量；
    // 省的是「账本怎么写的」，不是「东西没少」—— 交付记录必须跟着说裁过。
    // 正常情况下服务已经把包塞在 1 MiB 之内；走到这里的只会是「一份就装不下」的那条（与改造前
    // 同一条路），此时逐条省到装下为止。
    for (const delivery of envelope.deliveries ?? []) {
      if (bytes <= X_RESEARCH_MAX_OUTPUT_BYTES) break;
      const delivered = delivery.result;
      const shedders: ReadonlyArray<() => void> = [
        () => { delete delivered.metadataOmissions; },
        () => { delete delivered.contentMetadataOmissions; },
        () => { delete delivered.reportScopeFacts; },
      ];
      for (const shed of shedders) {
        if (bytes <= X_RESEARCH_MAX_OUTPUT_BYTES) break;
        shed();
        // 账本让了位，交付就不能再说自己是完整的那一份（`persistence: 'failed'` 那类没有采集
        // 收尾的结果本来就没有这个字段，不在这里凭空造一个）。
        if (delivered.delivery) delivered.delivery.truncated = true;
        bytes = stampEnvelopeBytes(envelope);
      }
    }
  }
  if (bytes > X_RESEARCH_MAX_OUTPUT_BYTES) {
    throw new Error(
      `x_research: the delivery envelope exceeds the 1 MiB tool-result budget (${bytes} bytes)`,
    );
  }
  // `details` 与 `content` 是同一份字节的两种写法：壳里的快照与工作项与任务内存**共享对象**，
  // 而任务在工具返回之后还会继续推进（R22 的同一个隐患）—— 从同一份文本反解，工具结果才不会
  // 事后改口（`submit` 返回的「排队中」不会在几分钟后变成「已完成」）。
  const text = JSON.stringify(envelope);
  return { content: [{ type: 'text', text }], details: JSON.parse(text) as XResearchDeliveryEnvelope };
}
