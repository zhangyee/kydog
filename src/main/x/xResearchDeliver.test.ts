import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fixture, post, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import type {
  XResearchSubmission, XResearchTaskSnapshot, XResearchWorkItem,
} from '../../shared/xResearchTask';
import type { XResearchArtifactStore } from './xResearchArtifacts';
import { serializeXResearchResult, xResearchToolResult } from './xResearchOutput';
import { searchX } from './xResearchSearch';
import { clipForEnvelope, deliverableSubmissions, deliverEnvelope } from './xResearchDeliver';
import type { XResearchDelivery } from './xResearchTaskShell';
import type { XReportRunScopeFacts } from '../../shared/xReportScopeFacts';
import { XResearchTaskService, type XResearchRunWork } from './xResearchTaskService';
import { XResearchTaskStore } from './xResearchTaskStore';
import { logger } from '../log';
import { X_RESEARCH_MAX_OUTPUT_BYTES, type XResearchResult } from './xResearchTypes';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xdeliver-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  // wait() returns before its delivery mark is persisted; drain the service before deleting its store.
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workItem(over: Partial<XResearchWorkItem> = {}): XResearchWorkItem {
  return {
    workItemId: randomUUID(), section: 'search', label: 'Qwen3.8 27B', product: 'Top',
    state: 'stopped', phaseDetail: null, status: 'observed', stopReason: 'cursor_exhausted',
    reason: null, posts: 87, omitted: 0, pages: 1, hasRoot: false, replies: 0,
    article: 'not_requested', scrolls: 4, expandActions: 0, ...over,
  };
}

/** 一份研究快照：行明细随用例给，其余数字都由工作项累加（与投影同一套事实）。 */
function snapshot(over: Partial<XResearchTaskSnapshot> = {}): XResearchTaskSnapshot {
  const search = over.search ?? [workItem()];
  return {
    researchRunId: 'research-1', threadId: 'thread-1', revision: 3, state: 'completed',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:01.000Z',
    objective: 'Qwen3.8 27B 量化版在 agentic 任务上的实际表现',
    counts: {
      submissions: 1, queued: 0, running: 0, done: search.length, failed: 0, cancelled: 0,
      interrupted: 0, posts: 87, replies: 0, articles: 0, undelivered: 0,
      searchDone: search.length, searchTotal: search.length, readDone: 0, readTotal: 0,
    },
    budget: { scrolls: 500, expandActions: 0 },
    usage: { posts: 87, scrolls: 4, expandActions: 0 },
    search, read: [], ...over,
  };
}

function submission(over: Partial<XResearchSubmission> = {}): XResearchSubmission {
  return {
    version: 1, submissionId: randomUUID(), researchRunId: 'research-1', threadId: 'thread-1',
    submitCallId: randomUUID(), batchId: 'xbatch_1', runId: 'run-1', operation: 'search',
    objective: 'Qwen3.8 27B 量化版在 agentic 任务上的实际表现', state: 'done',
    budget: { scrolls: 500, expandActions: 0 }, usage: { posts: 87, scrolls: 4, expandActions: 0 },
    workItems: [workItem()], createdAt: '2026-10-16T00:00:00.000Z',
    endedAt: '2026-10-16T00:01:00.000Z', ...over,
  };
}

/** 一份真实的采集结果（走采集层，不是手搓的 DTO）：交付量的是整包字节，形状得是真的。 */
async function realResult(pad = 0): Promise<XResearchResult> {
  const result = await searchX(searchInput, fixture([searchHtml(post())]).context);
  for (const row of result.queries) {
    for (const body of row.posts) {
      if (!pad) continue;
      body.text = 'a'.repeat(pad);
      body.truncation = { returned: pad, totalKnown: pad, truncated: false };
    }
  }
  return result;
}

async function resultOf(pad = 0): Promise<XResearchResult> {
  return serializeXResearchResult(await realResult(pad)).result;
}

async function deliveryOf(pad = 0, deliveryCallId = 'call-wait'): Promise<XResearchDelivery> {
  return {
    deliveryCallId, submissionId: 'submission-1', submitCallId: 'call-submit',
    operation: 'search', result: await resultOf(pad),
  };
}

describe('deliverableSubmissions', () => {
  it('lists every settled-undelivered submission in createdAt order', () => {
    const first = submission({ createdAt: '2026-10-16T00:00:00.000Z' });
    const second = submission({ createdAt: '2026-10-16T00:01:00.000Z' });
    const third = submission({ createdAt: '2026-10-16T00:02:00.000Z' });
    const delivered = submission({
      createdAt: '2026-10-15T23:59:00.000Z', deliveredAt: '2026-10-16T00:02:00.000Z',
    });
    // 已交付的那份跳过，剩下的按提交顺序（不是数组顺序）全交出去。
    expect(deliverableSubmissions([third, delivered, first, second])
      .map((item) => item.submissionId)).toEqual([first.submissionId, second.submissionId, third.submissionId]);
    expect(deliverableSubmissions([delivered])).toEqual([]);
  });

  it('never delivers a queued or running submission', () => {
    expect(deliverableSubmissions([
      submission({ state: 'queued', endedAt: null }),
      submission({ state: 'running', endedAt: null }),
    ])).toEqual([]);
  });

  it('counts a null deliveredAt as not delivered', () => {
    // store 直接 `JSON.parse` 落盘的那一份：只有真时间戳才算交付过（`null` 仍是没交付）。
    const stored = submission({ deliveredAt: null as unknown as string });
    expect(deliverableSubmissions([stored])).toEqual([stored]);
  });

  it('orders two submissions created in the same millisecond deterministically', () => {
    const older = submission({ createdAt: '2026-10-16T00:00:00.000Z' });
    const newer = submission({ createdAt: '2026-10-16T00:00:00.000Z' });
    // 同一毫秒的两条：与 `listSubmissions` 同一个第二键，两次读取给出同一个先后。
    const expected = [older, newer].sort((a, b) => a.submissionId.localeCompare(b.submissionId))
      .map((item) => item.submissionId);
    expect(deliverableSubmissions([newer, older]).map((item) => item.submissionId)).toEqual(expected);
    expect(deliverableSubmissions([older, newer]).map((item) => item.submissionId)).toEqual(expected);
  });
});

describe('deliverEnvelope', () => {
  it('counts the whole envelope against the 1 MiB fixed point', async () => {
    const { details } = deliverEnvelope({
      researchRunId: 'research-1', snapshot: snapshot(), deliveries: [await deliveryOf(120_000)],
      undelivered: [], action: 'wait',
    });
    // 模型看到的是整包（content + details），不是只有 details：定点必须量整包。
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult({ result: details, text: JSON.stringify(details) })), 'utf8'))
      .toBe(details.deliveries![0]!.result.budgetUsage.outputBytes);
    expect(details.deliveries![0]!.result.budgetUsage.outputBytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
  });

  it('keeps the protocol keys when the envelope has to shrink', async () => {
    // 快照自己就有几百 KB：行明细先让位（省的是模型可见性，卡片走 RPC 不受影响）。
    const big = snapshot({
      search: [workItem({ reason: 'x'.repeat(600_000) }), workItem({ label: 'second' })],
    });
    const { details } = deliverEnvelope({
      researchRunId: 'research-1', snapshot: big, deliveries: [await deliveryOf()], undelivered: [],
      action: 'wait',
    });
    expect(details.snapshot.search).toEqual([]);
    expect(details.snapshot.read).toEqual([]);
    // 四个协议键与快照的数字类事实都不许省。
    expect(details).toMatchObject({
      kind: 'x_research', action: 'wait', researchRunId: 'research-1', status: 'completed',
    });
    expect(details.snapshot.counts).toEqual(big.counts);
    expect(details.snapshot.objective).toBe(big.objective);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult({ result: details, text: JSON.stringify(details) })), 'utf8'))
      .toBe(details.deliveries![0]!.result.budgetUsage.outputBytes);
  });

  it('sheds the snapshot rows before the undelivered list', async () => {
    const many = Array.from({ length: 100 }, () => ({
      submissionId: randomUUID(), operation: 'search' as const,
      objective: 'y'.repeat(2_000), state: 'done' as const,
    }));
    // 只让快照的行明细让位就够装进 1 MiB：`undelivered` 必须原样留着。
    // 若两档顺序反过来（先省清单），清单会先被丢掉、行明细却还占着地方 —— 这条用例就会红。
    const big = snapshot({
      search: [workItem({ reason: 'x'.repeat(900_000) }), workItem({ label: 'second' })],
      counts: { ...snapshot().counts, undelivered: 100 },
    });
    const { details } = deliverEnvelope({
      researchRunId: 'research-1', snapshot: big, deliveries: [await deliveryOf()], undelivered: many,
      action: 'wait',
    });
    expect(details.snapshot.search).toEqual([]);
    // 只省行明细就够时，清单必须原样留着；先省清单的写法会让这里空掉。
    expect(details.undelivered).toHaveLength(many.length);
    expect(details.undelivered?.[many.length - 1]).toMatchObject({
      objective: many[many.length - 1]!.objective,
    });
    expect(details.snapshot.counts.undelivered).toBe(100);
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult({ result: details, text: JSON.stringify(details) })), 'utf8'))
      .toBe(details.deliveries![0]!.result.budgetUsage.outputBytes);
  });

  it('sheds the result ledgers only after the snapshot is minimal', async () => {
    // 收尾额度被这一轮 `wait` 的长 id 撑破、快照已无可省文本时（控制器裁决 R25）：
    // 按 metadataOmissions → contentMetadataOmissions → reportScopeFacts 省结果自己的省略账本。
    const result = await resultOf(480_000);
    result.delivery = {
      truncated: false, omittedObservations: 0, omittedFields: [], artifactPath: null,
      persistence: 'failed',
    };
    result.metadataOmissions = Array.from(
      { length: 800 }, (_, index) => `queries.0.field.${index}`.padEnd(120, 'x'));
    // 账本真在夹具里（不能靠一个空数组把下面的「省掉了」假绿）：
    expect(result.metadataOmissions).toHaveLength(800);
    const { details } = deliverEnvelope({
      researchRunId: 'research-1', snapshot: snapshot({ objective: 'o'.repeat(2_000) }),
      deliveries: [{
        deliveryCallId: 'toolu_01Wxyz'.repeat(4), submissionId: 'submission-1',
        submitCallId: 'call-submit', operation: 'search', result,
      }],
      undelivered: [], action: 'wait',
    });
    const bytes = Buffer.byteLength(JSON.stringify(xResearchToolResult(
      { result: details, text: JSON.stringify(details) })), 'utf8');
    expect(bytes).toBe(details.deliveries![0]!.result.budgetUsage.outputBytes);
    expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(details.deliveries![0]!.result.metadataOmissions).toBeUndefined();
    // 账本让了位，交付就不许再说自己是完整的那一份。
    expect(details.deliveries![0]!.result.delivery?.truncated).toBe(true);
    expect(details.snapshot.objective).toBe('');
  });

  it('sheds the snapshot down to its numbers when the shell alone is over', async () => {
    // 交付副本在收尾时已经按额度裁过；这里让壳变胖（这一轮 `wait` 的 id 比占位用的长、
    // 之后又追加过提交），看最后一档省的是不是快照的文本事实，而不是那份结果。
    const identity = {
      researchRunId: 'research-1', snapshot: snapshot(), submissionId: 'submission-1',
      submitCallId: 'call-submit', operation: 'search' as const,
    };
    const clipped = clipForEnvelope({ ...identity, result: await resultOf(520_000) });
    const out = deliverEnvelope({
      researchRunId: 'research-1', snapshot: snapshot({ objective: 'x'.repeat(2_000) }),
      deliveries: [{
        deliveryCallId: 'toolu_01Wxyz'.repeat(4), submissionId: identity.submissionId,
        submitCallId: identity.submitCallId, operation: identity.operation, result: clipped,
      }],
      undelivered: [], action: 'wait',
    });
    const bytes = Buffer.byteLength(JSON.stringify(xResearchToolResult(
      { result: out.details, text: out.content[0]!.text })), 'utf8');
    expect(bytes).toBe(out.details.deliveries![0]!.result.budgetUsage.outputBytes);
    expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(out.details.snapshot.objective).toBe('');
    expect(out.details.snapshot.search).toEqual([]);
    expect(out.details).toMatchObject({
      kind: 'x_research', action: 'wait', researchRunId: 'research-1', status: 'completed',
    });
  });

  it('delivers a wait with nothing to hand out', () => {
    const { details, content } = deliverEnvelope({
      researchRunId: 'research-1', snapshot: snapshot({ state: 'running' }), deliveries: [],
      undelivered: [{ submissionId: 'submission-2', operation: 'read', objective: '读这篇', state: 'running' }],
      action: 'wait',
    });
    expect(details.deliveries).toBeUndefined();
    expect(details.undelivered).toEqual([
      { submissionId: 'submission-2', operation: 'read', objective: '读这篇', state: 'running' },
    ]);
    // `content` 就是模型读的那一份：它必须逐字等于 `details`（一个字都不能只在一边）。
    expect(JSON.parse(content[0]?.text ?? 'null')).toEqual(details);
  });
});

describe('XResearchTaskService.wait', () => {
  const owner = (): { threadId: string; runId: string; projectRoot: string } =>
    ({ threadId: randomUUID(), runId: randomUUID(), projectRoot: '/projects/demo' });

  const searchWork = (): { search: typeof searchInput.search } => ({ search: searchInput.search });

  /** 走采集层的真结果：交付量的是整包字节，手搓 DTO 会让这个用例绿在一个假形状上。 */
  const realResult = async (): Promise<XResearchResult> => serializeXResearchResult(
    await searchX(searchInput, fixture([searchHtml(post())]).context)).result;

  function fakeArtifacts(result: (ref: unknown) => XResearchResult): {
    store: XResearchArtifactStore; reads: unknown[];
  } {
    const reads: unknown[] = [];
    return {
      reads,
      store: {
        write: async () => { throw new Error('not used'); },
        displayPath: () => '/artifacts/manifest.json',
        locate: async () => '/artifacts/manifest.json',
        read: async (ref) => { reads.push(ref); return structuredClone(result(ref)); },
      },
    };
  }

  it('delivers a small result byte-identically, without clipping it again', async () => {
    const store = new XResearchTaskStore(root());
    const artifacts = tempXArtifactStore();
    let settleCopy: XResearchResult | undefined;
    const runWork: XResearchRunWork = async () => {
      const result = await realResult();
      result.artifact = await artifacts.write(result);
      result.delivery = {
        truncated: false, omittedObservations: 0, omittedFields: [],
        artifactPath: artifacts.displayPath(result.artifact), persistence: 'saved',
      };
      settleCopy = result;
      return result;
    };
    const service = new XResearchTaskService({
      store, runWork, artifacts: () => artifacts, onUpdate: () => undefined,
    });
    const thread = owner();
    cleanups.push(() => service.disposeThread(thread.threadId));
    const submitted = await service.submit({ work: searchWork() }, thread);
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    const waited = await service.wait(thread.threadId, submitted.researchRunId, 'call-wait');
    // 装得下就原样交付：包络不许因为「要量字节」而重新序列化一份结果（那会多一份裁过的副本）。
    expect(waited.deliveries[0]!.result).toBe(settleCopy);
    // R24：序列化时算出来的 scope 事实要跟着提交记录落盘（重启后的交付只能从这里补回）。
    const stored = await store.readSubmission(
      thread.threadId, submitted.researchRunId, submitted.submissionId);
    expect(stored?.reportScopeFacts).toBeDefined();
    expect(stored?.reportScopeFacts).toEqual(waited.deliveries[0]!.result.reportScopeFacts);
  });

  it('delivers the in-memory copy when the artifact write failed', async () => {
    const store = new XResearchTaskStore(root());
    const artifacts = tempXArtifactStore();
    const runWork: XResearchRunWork = async () => {
      const result = await realResult();
      // 工件写失败（R20）：结果只在内存里，提交记录没有 ref —— 这一轮交付不许把它丢掉。
      result.delivery = {
        truncated: false, omittedObservations: 0, omittedFields: [], artifactPath: null,
        persistence: 'failed', failureCode: 'write',
      };
      return result;
    };
    const service = new XResearchTaskService({
      store, runWork, artifacts: () => artifacts, onUpdate: () => undefined,
    });
    const thread = owner();
    cleanups.push(() => service.disposeThread(thread.threadId));
    const submitted = await service.submit({ work: searchWork() }, thread);
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    const waited = await service.wait(thread.threadId, submitted.researchRunId, 'call-wait');
    expect(waited.deliveries[0]?.submissionId).toBe(submitted.submissionId);
    expect(waited.deliveries[0]?.result.delivery).toMatchObject({
      persistence: 'failed', artifactPath: null,
    });
    // 没有工件 ref 不等于不能交付：交付标记照写（内存里它已经交出去了）。落盘现在跟在返回之后
    // （spec §4.5 的顺序），所以这里等它落地。
    await vi.waitFor(async () => {
      const stored = await store.readSubmission(
        thread.threadId, submitted.researchRunId, submitted.submissionId);
      expect(stored?.artifact).toBeUndefined();
      expect(stored?.deliveredAt).toEqual(expect.any(String));
    });
  });

  it('fits a clipped result by clipping it once at settle, never again at delivery', async () => {
    const store = new XResearchTaskStore(root());
    const artifacts = tempXArtifactStore();
    let runnerCopy: XResearchResult | undefined;
    const runWork: XResearchRunWork = async () => {
      const result = await searchX(searchInput, fixture([searchHtml(post())]).context);
      for (const row of result.queries) for (const body of row.posts) {
        body.text = 'a'.repeat(600_000);
        body.truncation = { returned: 600_000, totalKnown: 600_000, truncated: false };
      }
      // 运行体按今天的预算（1 MiB 的工具结果）先裁一次 —— 这就是被包络挤掉的那一类结果。
      runnerCopy = serializeXResearchResult(result).result;
      return runnerCopy;
    };
    const service = new XResearchTaskService({
      store, runWork, artifacts: () => artifacts, onUpdate: () => undefined,
    });
    const thread = owner();
    cleanups.push(() => service.disposeThread(thread.threadId));
    const submitted = await service.submit({ work: searchWork() }, thread);
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    const waited = await service.wait(thread.threadId, submitted.researchRunId,
      'call-wait-0000000000000000000000000000');
    const envelope = deliverEnvelope({
      researchRunId: submitted.researchRunId, snapshot: waited.snapshot,
      deliveries: waited.deliveries, undelivered: waited.undelivered, action: 'wait',
    });
    const bytes = Buffer.byteLength(JSON.stringify(xResearchToolResult(
      { result: envelope.details, text: envelope.content[0]!.text })), 'utf8');
    expect(bytes).toBe(envelope.details.deliveries![0]!.result.budgetUsage.outputBytes);
    expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    // 收尾时已经裁过：交付的那一份不是运行体那份字节（省掉的内容都记在 `delivery` 上）。
    expect(waited.deliveries[0]!.result).not.toBe(runnerCopy);
    expect(waited.deliveries[0]!.result.delivery?.truncated).toBe(true);
    // settle 时已经按**包络实测**裁到位，交付层无需再省快照（行明细照旧留给模型看）。
    // 本条原先断的是反对面：那时裁切按结果的投影字节记账，交付必须再省一次快照才装得下 ——
    // 那份少报的字节正是 `clipForEnvelope` 的记账错误，Task 9 把它改成按整包实测。
    expect(envelope.details.snapshot.search).toHaveLength(1);
  });

  it('hands out every settled-undelivered submission in one wait, in submission order, never twice', async () => {
    const store = new XResearchTaskStore(root());
    const artifacts = tempXArtifactStore();
    // 工作体把结果落成工件（R20：只按今天的格式落一次），提交记录因此带上 ref。
    const runWork: XResearchRunWork = async () => {
      const result = await realResult();
      result.artifact = await artifacts.write(result);
      result.delivery = {
        truncated: false, omittedObservations: 0, omittedFields: [],
        artifactPath: artifacts.displayPath(result.artifact), persistence: 'saved',
      };
      return result;
    };
    let tick = 0;
    const service = new XResearchTaskService({
      store, runWork, artifacts: () => artifacts, onUpdate: () => undefined,
      now: () => new Date(Date.UTC(2026, 9, 16) + (tick++) * 1000).toISOString(),
    });
    const thread = owner();
    cleanups.push(() => service.disposeThread(thread.threadId));
    const first = await service.submit({ work: searchWork() }, thread);
    const second = await service.submit(
      { researchRunId: first.researchRunId, work: searchWork() }, thread);

    const a = await service.wait(thread.threadId, first.researchRunId, 'call-wait-1');
    // 一次 `wait` 把两份都交出去，顺序是提交顺序；两条各自带着这一轮的身份。
    expect(a.deliveries.map((delivery) => delivery.submissionId))
      .toEqual([first.submissionId, second.submissionId]);
    expect(a.deliveries.map((delivery) => delivery.deliveryCallId))
      .toEqual(['call-wait-1', 'call-wait-1']);
    expect(a.undelivered).toEqual([]);
    expect(a.snapshot.counts.undelivered).toBe(0);

    // 正控：第二次 `wait` 一份都不重复交付。
    expect(await service.wait(thread.threadId, first.researchRunId, 'call-wait-2'))
      .toMatchObject({ deliveries: [], undelivered: [] });

    // 交付标记是权威（spec §4.5）：盘上记着哪一轮交付过，重启后据此不再交付第二次。
    // 标记的落盘跟在返回之后，所以这里等它写完（等不到才是缺陷）——每一条都得有。
    await vi.waitFor(async () => {
      for (const item of [first, second]) {
        expect(await store.readSubmission(
          thread.threadId, first.researchRunId, item.submissionId)).toMatchObject({
          deliveredAt: expect.any(String), deliveryCallId: 'call-wait-1',
          artifact: expect.objectContaining({ version: 1 }),
        });
      }
    });
    expect(await service.wait(thread.threadId, first.researchRunId, 'call-wait-3'))
      .toMatchObject({ deliveries: [], undelivered: [] });
  });

  it('stops packing at the 1 MiB envelope and leaves the rest for the next wait', async () => {
    // 六份各约 150 KB 的结果：三份装得下，第四份装不下（`content` 与 `details` 各算一次，
    // 与既有 1 MiB 口径相同）。判据读的是**序列化后的整包**，不是估算。
    const store = new XResearchTaskStore(root());
    const artifacts = tempXArtifactStore();
    const runWork: XResearchRunWork = async () => {
      const result = await searchX(searchInput, fixture([searchHtml(post())]).context);
      for (const row of result.queries) {
        for (const body of row.posts) {
          body.text = 'a'.repeat(140_000);
          body.truncation = { returned: 140_000, totalKnown: 140_000, truncated: false };
        }
      }
      result.artifact = await artifacts.write(result);
      result.delivery = {
        truncated: false, omittedObservations: 0, omittedFields: [],
        artifactPath: artifacts.displayPath(result.artifact), persistence: 'saved',
      };
      return result;
    };
    let tick = 0;
    const service = new XResearchTaskService({
      store, runWork, artifacts: () => artifacts, onUpdate: () => undefined,
      now: () => new Date(Date.UTC(2026, 9, 16) + (tick++) * 1000).toISOString(),
    });
    const thread = owner();
    cleanups.push(() => service.disposeThread(thread.threadId));
    const first = await service.submit({ work: searchWork() }, thread);
    for (let index = 1; index < 6; index += 1) {
      await service.submit({ researchRunId: first.researchRunId, work: searchWork() }, thread);
    }
    await service.whenIdle(thread.threadId, first.researchRunId);

    const a = await service.wait(thread.threadId, first.researchRunId, 'call-wait-1');
    expect(a.deliveries.length).toBeGreaterThan(0);
    expect(a.deliveries.length).toBeLessThan(6);
    expect(a.undelivered).toHaveLength(6 - a.deliveries.length);
    expect(a.snapshot.counts.undelivered).toBe(a.undelivered.length);
    const envelope = deliverEnvelope({
      researchRunId: first.researchRunId, snapshot: a.snapshot,
      deliveries: a.deliveries, undelivered: a.undelivered, action: 'wait',
    });
    const bytes = Buffer.byteLength(JSON.stringify(xResearchToolResult(
      { result: envelope.details, text: envelope.content[0]!.text })), 'utf8');
    // 这一包真的在 1 MiB 之内；而再多装一份就装不下（下一条 `wait` 交出的那批合起来超了）。
    expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);

    const b = await service.wait(thread.threadId, first.researchRunId, 'call-wait-2');
    expect(b.deliveries).toHaveLength(a.undelivered.length);
    expect(b.undelivered).toEqual([]);
    expect(b.snapshot.counts.undelivered).toBe(0);
    // 「再多一份就装不下」：把下一批的第一份加进第一批，同一把尺子量出来超过 1 MiB。
    const oneMore = { ...envelope.details, deliveries: [...a.deliveries, b.deliveries[0]!] };
    expect(Buffer.byteLength(JSON.stringify(xResearchToolResult({
      result: oneMore, text: JSON.stringify(oneMore),
    })), 'utf8')).toBeGreaterThan(X_RESEARCH_MAX_OUTPUT_BYTES);
  });

  it('marks every delivery in memory first, so a failed batch mark write still delivers once and never twice', async () => {
    // 盘上的标记写在返回**之后**（spec §4.5）：写失败只留在日志里，已经交出去的结果不被要回来；
    // 而同一进程的下一次 `wait` 看的是内存里的标记，不会再交一遍。整批的标记都已在内存里，
    // 即使落盘在第一笔就失败（`flush` 随后停止，第二笔根本没写）。
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let failMarkWrites = false;
    class MarkFailingStore extends XResearchTaskStore {
      markAttempts = 0;
      override async writeSubmission(submission: XResearchSubmission): Promise<void> {
        if (failMarkWrites && submission.deliveredAt !== undefined) {
          this.markAttempts += 1;
          throw new Error('disk full');
        }
        return super.writeSubmission(submission);
      }
    }
    const store = new MarkFailingStore(root());
    const artifacts = tempXArtifactStore();
    const runWork: XResearchRunWork = async () => {
      const result = await realResult();
      result.artifact = await artifacts.write(result);
      result.delivery = {
        truncated: false, omittedObservations: 0, omittedFields: [],
        artifactPath: artifacts.displayPath(result.artifact), persistence: 'saved',
      };
      return result;
    };
    const service = new XResearchTaskService({
      store, runWork, artifacts: () => artifacts, onUpdate: () => undefined,
    });
    const thread = owner();
    cleanups.push(() => service.disposeThread(thread.threadId));
    const submitted = await service.submit({ work: searchWork() }, thread);
    const second = await service.submit(
      { researchRunId: submitted.researchRunId, work: searchWork() }, thread);
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    failMarkWrites = true;
    const waited = await service.wait(thread.threadId, submitted.researchRunId, 'call-wait-1');
    // 结果照旧交出去：写盘失败不改事实；这一批的每一条都算交出过。
    expect(new Set(waited.deliveries.map((delivery) => delivery.submissionId)))
      .toEqual(new Set([submitted.submissionId, second.submissionId]));
    expect(waited.snapshot.counts.undelivered).toBe(0);
    // 落盘在第一笔就停了：第二笔没有尝试（内存标记不依赖它）。
    await vi.waitFor(() => expect(store.markAttempts).toBe(1));
    expect(warn).toHaveBeenCalledWith('x_research', 'could not persist the delivery mark',
      expect.objectContaining({
        submissionIds: expect.arrayContaining([submitted.submissionId, second.submissionId]),
      }));
    // 同一进程里不会再交一次：内存里的标记已经在了（盘上没有它们 —— 这正是重启后「再交一次」的窗口，
    // 那一次的重复写入由 `XResearchEvidence.observe` 的幂等兜底）。
    expect(await service.wait(thread.threadId, submitted.researchRunId, 'call-wait-2'))
      .toMatchObject({ deliveries: [], undelivered: [] });
    for (const item of [submitted, second]) {
      expect((await store.readSubmission(
        thread.threadId, submitted.researchRunId, item.submissionId))?.deliveredAt).toBeUndefined();
    }
  });

  it('reads the result back from the artifact when the process no longer holds it', async () => {
    const store = new XResearchTaskStore(root());
    const researchRunId = randomUUID();
    const thread = owner();
    const ref = {
      version: 1 as const, directoryId: randomUUID(), manifest: 'manifest.json' as const,
      sha256: 'a'.repeat(64), bytes: 1024, runId: 'run-1', callId: 'call-submit',
      batchId: 'xbatch_1', operation: 'search' as const,
    };
    const canonical = await realResult();
    // 收尾那一刻序列化算出来的 scope 事实（R24）：工件里是序列化之前的 canonical，没有这两份。
    const scopeFacts = canonical.reportScopeFacts;
    if (!scopeFacts) throw new Error('fixture must carry the serialized scope facts');
    const runFacts: XReportRunScopeFacts = {
      version: 1, runId: 'run-1', callCount: 1, unavailableCallCount: 0, search: scopeFacts,
      read: {
        version: 1, operation: 'read', reasonSource: 'reason', totalRows: 0,
        statusCounts: {}, stopReasonCounts: {}, reasonCounts: {}, replyScopeCounts: {},
      },
    };
    // 上一个进程留下的形状：提交已收尾、带工件 ref 与 scope 事实，内存里没有它（重启后）。
    const stored = submission({
      threadId: thread.threadId, researchRunId, artifact: ref,
      reportScopeFacts: scopeFacts, reportRunScopeFacts: runFacts,
      workItems: [workItem({ section: 'search' })],
    });
    await store.writeTask({
      version: 1, researchRunId, threadId: thread.threadId, projectRoot: thread.projectRoot,
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:01:00.000Z',
      revision: 2, state: 'completed', submissionIds: [stored.submissionId],
    });
    await store.writeSubmission(stored);
    const artifacts = fakeArtifacts(() => {
      const artifactCopy = structuredClone(canonical);
      delete artifactCopy.reportScopeFacts;
      delete artifactCopy.reportRunScopeFacts;
      return artifactCopy;
    });
    const service = new XResearchTaskService({
      store, runWork: realResult, artifacts: () => artifacts.store, onUpdate: () => undefined,
    });
    cleanups.push(() => service.disposeThread(thread.threadId));
    const waited = await service.wait(thread.threadId, researchRunId, 'call-wait');
    expect(artifacts.reads).toEqual([ref]);
    expect(waited.deliveries[0]).toMatchObject({
      deliveryCallId: 'call-wait', submissionId: stored.submissionId, operation: 'search',
    });
    // 读回来的结果照今天的预算裁一次再交付（工件里是完整 canonical）。
    expect(waited.deliveries[0]!.result.budgetUsage.outputBytes)
      .toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
    expect(waited.deliveries[0]!.result.delivery).toMatchObject({ persistence: 'saved' });
    // R24：提交记录里的 scope 事实被补回结果再序列化（工件里没有它们）。
    expect(waited.deliveries[0]!.result.reportScopeFacts).toEqual(scopeFacts);
    expect(waited.deliveries[0]!.result.reportRunScopeFacts).toEqual(runFacts);
  });

  it('clips a restarted result to the envelope budget, not to the whole 1 MiB', async () => {
    const store = new XResearchTaskStore(root());
    const researchRunId = randomUUID();
    const thread = owner();
    const ref = {
      version: 1 as const, directoryId: randomUUID(), manifest: 'manifest.json' as const,
      sha256: 'c'.repeat(64), bytes: 1_100_000, runId: 'run-3', callId: 'call-submit-3',
      batchId: 'xbatch_3', operation: 'search' as const,
    };
    // 工件里是完整 canonical：正文 600 000 字，和收尾裁切那条用例同一份夹具。
    const canonical = await searchX(searchInput, fixture([searchHtml(post())]).context);
    for (const row of canonical.queries) {
      for (const body of row.posts) {
        body.text = 'a'.repeat(600_000);
        body.truncation = { returned: 600_000, totalKnown: 600_000, truncated: false };
      }
    }
    const stored = submission({
      threadId: thread.threadId, researchRunId, artifact: ref, workItems: [workItem()],
    });
    await store.writeTask({
      version: 1, researchRunId, threadId: thread.threadId, projectRoot: thread.projectRoot,
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:01:00.000Z',
      revision: 2, state: 'completed', submissionIds: [stored.submissionId],
    });
    await store.writeSubmission(stored);
    const artifacts = fakeArtifacts(() => canonical);
    const service = new XResearchTaskService({
      store, runWork: realResult, artifacts: () => artifacts.store, onUpdate: () => undefined,
    });
    cleanups.push(() => service.disposeThread(thread.threadId));
    const waited = await service.wait(thread.threadId, researchRunId,
      'call-wait-0000000000000000000000000000');
    // 重启路径按**量出来的包络额度**裁（T5/B'）：不是整份 1 MiB 的预算。
    const wholeBudget = serializeXResearchResult(structuredClone(canonical))
      .result.budgetUsage.outputBytes;
    expect(waited.deliveries[0]!.result.budgetUsage.outputBytes).toBeLessThan(wholeBudget);
    // 整包实测落在 1 MiB 以内：壳也要字节，只按 1 MiB 裁结果会让这份提交永远交付不了。
    const envelope = deliverEnvelope({
      researchRunId, snapshot: waited.snapshot, deliveries: waited.deliveries,
      undelivered: waited.undelivered, action: 'wait',
    });
    const bytes = Buffer.byteLength(JSON.stringify(xResearchToolResult(
      { result: envelope.details, text: envelope.content[0]!.text })), 'utf8');
    expect(bytes).toBe(envelope.details.deliveries![0]!.result.budgetUsage.outputBytes);
    expect(bytes).toBeLessThanOrEqual(X_RESEARCH_MAX_OUTPUT_BYTES);
  });

  it('skips a settled submission whose result is gone instead of blocking the next one', async () => {
    const store = new XResearchTaskStore(root());
    const researchRunId = randomUUID();
    const thread = owner();
    const createdAt = '2026-10-16T00:00:00.000Z';
    const ref = {
      version: 1 as const, directoryId: randomUUID(), manifest: 'manifest.json' as const,
      sha256: 'b'.repeat(64), bytes: 2048, runId: 'run-2', callId: 'call-submit-2',
      batchId: 'xbatch_2', operation: 'search' as const,
    };
    // 工件写失败过 + 进程重启：最早的这一份收了尾却没有 ref，它没有结果可交付。
    const lost = submission({
      threadId: thread.threadId, researchRunId, state: 'interrupted',
      createdAt: '2026-10-16T00:00:00.000Z', endedAt: createdAt,
    });
    const kept = submission({
      threadId: thread.threadId, researchRunId, artifact: ref,
      createdAt: '2026-10-16T00:02:00.000Z',
    });
    await store.writeTask({
      version: 1, researchRunId, threadId: thread.threadId, projectRoot: thread.projectRoot,
      createdAt, updatedAt: createdAt, revision: 2, state: 'interrupted',
      submissionIds: [lost.submissionId, kept.submissionId],
    });
    await store.writeSubmission(lost);
    await store.writeSubmission(kept);
    const canonical = await realResult();
    const artifacts = fakeArtifacts(() => canonical);
    const service = new XResearchTaskService({
      store, runWork: realResult, artifacts: () => artifacts.store, onUpdate: () => undefined,
    });
    cleanups.push(() => service.disposeThread(thread.threadId));
    const waited = await service.wait(thread.threadId, researchRunId, 'call-wait');
    // 拿不到结果的那一份不许把队列堵死：后面那份照常交付。
    expect(artifacts.reads).toEqual([ref]);
    expect(waited.deliveries[0]?.submissionId).toBe(kept.submissionId);
    // 而它自己仍在清单里（如实说「没交付」），没有被假装成交付过。
    expect(waited.undelivered.map((item) => item.submissionId)).toEqual([lost.submissionId]);
    const persisted = await store.readSubmission(thread.threadId, researchRunId, lost.submissionId);
    expect(persisted?.deliveredAt).toBeUndefined();
  });
});
