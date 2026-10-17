// 二十个目标的资源压力（每条都带 N 个 Article 缺口）走完整条新链路：`submit` → 队列 → runner →
// 工件落盘 → `wait` 交付（1 MiB 定点）→ 交付后入账 → 恢复链。
// 旧工具那条用例的移植：判据一条不少，只是入口从「一次执行」换成「提交 + 等待交付」。
import { expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { fixture, post, readHtml } from '../../test-support/xResearchFixture';
import * as reader from './xResearchRead';
import { createXResearchRunner } from './xResearchRunner';
import { XResearchScopeLedger } from './xResearchScopeFacts';
import { XResearchEvidence } from './xResearchEvidence';
import { hydrateXResearchBranch } from './xResearchBranch';
import { XResearchTaskService } from './xResearchTaskService';
import { XResearchTaskStore } from './xResearchTaskStore';
import type { XResearchDeliveryEnvelope } from './xResearchTaskShell';
import type { XResearchResult } from './xResearchTypes';
import { createXResearchTools } from '../agent/xResearchTools';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'x-gaps-'));
  roots.push(dir);
  return dir;
}

const entry = (details: unknown, toolCallId: string) => ({
  type: 'message', message: {
    role: 'toolResult', toolName: 'x_research', toolCallId, isError: false, details,
  },
});

/** 真 service + 真 runner + 假采集边界（只把 `readX` 换成压力夹具）：交付、落盘、入账都是真的。 */
function harness(f: ReturnType<typeof fixture>, ledger: XResearchEvidence) {
  const threadId = randomUUID();
  const artifacts = tempXArtifactStore();
  const scope = new XResearchScopeLedger();
  const observed: XResearchResult[] = [];
  const store = new XResearchTaskStore(root());
  const service = new XResearchTaskService({
    store,
    runWork: createXResearchRunner({
      browserFor: () => f.context.browser,
      contextFor: () => ({
        sources: ledger.sources, scopePrior: (runId) => scope.prior(runId), currentRunId: () => 'run',
      }),
      artifacts: () => artifacts,
    }),
    onUpdate: () => undefined,
    artifacts: () => artifacts,
  });
  const tool = createXResearchTools({
    service, threadId, projectRoot: '/projects/x', currentRunId: () => 'run',
    observeDelivery: (result) => { observed.push(result); ledger.observe(result); },
  });
  /** 一次提交 + 一次交付。`wait` 一次只交一份，所以这里必须等这一份交完再发下一次。 */
  const run = async (args: Record<string, unknown>, ids: { submit: string; wait: string }) => {
    const submitted = (await tool.execute(ids.submit, { action: 'submit', ...args } as never,
      undefined, undefined, {} as never)).details as XResearchDeliveryEnvelope;
    const delivered = (await tool.execute(ids.wait, {
      action: 'wait', researchRunId: submitted.researchRunId,
    } as never, undefined, undefined, {} as never)).details as XResearchDeliveryEnvelope;
    if (!delivered.delivery) throw new Error('expected a delivered result');
    return delivered;
  };
  return { run, artifacts, observed, store, threadId };
}

it.each([500, 1000])('delivers twenty targets with %i Article gaps through persistence and the live ledger', async count => {
  const f = fixture([readHtml(post('1000000', 'ReadAuthor', 'ordinary earlier body'))]);
  const ledger = new XResearchEvidence('/tmp', () => 'run');
  const { run, artifacts, observed, store, threadId } = harness(f, ledger);
  const baseline = await run({
    read: {
      objective: 'baseline', targets: [{ url: 'https://x.com/ReadAuthor/status/1000000' }],
      includeArticle: false, includeReplies: false,
    },
  }, { submit: 'baseline-submit', wait: 'baseline-wait' });
  expect(ledger.guard('/tmp/report.md', '[source](https://x.com/ReadAuthor/status/1000000)')).toBeUndefined();
  // Resource-pressure derivation at the collector boundary: unchanged supported
  // gap shape, twenty distinct targets, empty-body carriers retained as gaps.
  const spy = vi.spyOn(reader, 'readX').mockImplementationOnce(async (input, context) => {
    expect(input.read.maxRepliesPerPost).toBe(count);
    const result = reader.readResult(input, context); result.status = 'partial';
    result.targets.forEach((row, t) => {
      row.status = 'partial'; row.reason = 'reply_budget_reached'; row.stopReason = 'budget_reached';
      row.collectionStop = { status: 'partial', reason: row.reason, stopReason: row.stopReason };
      row.budgetUsage.distinctEntries = count; row.sampleTruncation = { observed: count, sampled: count, omitted: 0 };
      row.budgetBinding = [{ dimension: 'replies', used: count, limit: count, origin: count === 500 ? 'default' : 'explicit' }];
      row.replies.scope.stopReason = 'budget_reached';
      row.unscopedPosts = {
        observations: [],
        collection: { kind: 'network', provenance: { leaseId: 'lease' + t, requestRef: 'request' + t, navigationId: 'nav', documentEpoch: 1, routeRevision: 0, navigationSequence: 1, operation: 'TweetDetail', observedAt: '2026-10-16T00:00:00Z' } },
        inventory: { scope: 'collection', observed: count, retained: 0, omitted: count, sourceInventoryTruncated: false, excludedNestedQuotes: 0 },
        previewGaps: Array.from({ length: count }, (_, i) => ({
          sourceUrl: `https://x.com/ReadAuthor/status/${1000000 + t * 1000 + i}`, unresolved: 1,
        })),
      };
    });
    return result;
  });
  let delivered: XResearchDeliveryEnvelope;
  try {
    delivered = await run({
      read: {
        objective: 'gap pressure',
        targets: Array.from({ length: 20 }, (_, i) => ({ url: `https://x.com/ReadAuthor/status/${9000 + i}` })),
        includeArticle: false, includeReplies: true,
        ...(count === 1000 ? { maxRepliesPerPost: 1000 } : {}),
      },
    }, { submit: 'gaps-submit', wait: 'gaps-wait' });
  } finally { spy.mockRestore(); }
  // 模型看到的是整包（壳 + 快照 + 结果）：定点就是这一整包。
  expect(Buffer.byteLength(JSON.stringify(delivered))).toBeLessThanOrEqual(1048576);
  const details = delivered.delivery!.result;
  expect(details.delivery).toMatchObject({ persistence: 'saved', truncated: true, articleObligationCoverage: 'not_inline' });
  expect(details.artifact).toBeTruthy();
  // 入过账的就是这一份（`callId` 是提交那一轮，由 service 铸；交付那一轮在壳上）。
  // 判据取**盘上的提交记录**：壳与账本自己对比对不出来一个整体写歪的 id。
  const stored = (await store.listSubmissions(threadId, delivered.researchRunId))
    .find(submission => submission.objective === 'gap pressure');
  if (!stored) throw new Error('expected the persisted gaps submission');
  expect(observed.at(-1)?.callId).toBe(stored.submitCallId);
  expect(observed.at(-1)?.batchId).toBe(stored.batchId);
  expect(delivered.delivery!.submitCallId).toBe(stored.submitCallId);
  // 工件里是完整的 canonical：二十条目标的缺口数一个都没少，而交付副本照 1 MiB 裁过。
  const saved = await artifacts.read(details.artifact!);
  if (saved.operation !== 'read' || details.operation !== 'read') throw Error('read');
  expect(saved.targets.map(r => r.unscopedPosts!.previewGaps.length)).toEqual(Array(20).fill(count));
  for (const [i, row] of details.targets.entries()) {
    expect(row.collectionStop).toEqual(saved.targets[i].collectionStop);
    expect(row.sampleTruncation).toEqual(saved.targets[i].sampleTruncation);
    expect(row.budgetBinding).toEqual(saved.targets[i].budgetBinding);
    expect(row.unscopedPosts!.inventory).toEqual(saved.targets[i].unscopedPosts!.inventory);
    if (row.unscopedPosts!.previewGaps.length < count) expect(details.delivery!.omittedFields).toContain(`targets.${i}.unscopedPosts.previewGaps`);
  }
  // 交付副本自己就是一个稳定的字节：它已经被序列化过（再序列化会按它自己的
  // `outputBytes`（整包字节）重新量，那不是「同一份事实」），所以只钉往返不变。
  expect(JSON.parse(JSON.stringify(details))).toEqual(details);
  // 交付副本把部分目标的 previewGaps 省了（省略账本逐条说了出来）：这些缺口身份从没到过模型
  // 眼里，账本吃的就是交付的那一份，所以也不凭一张没交付的清单挡引用（spec §4.5「可引用 = 已交付」）。
  // 两个方向都钉：真裁了就必须声明，没裁就不许声明（否则「声明」不再是可核对的事实）。
  const declaredGaps = (index: number) => details.delivery!.omittedFields
    .includes(`targets.${index}.unscopedPosts.previewGaps`);
  expect(details.targets.filter((_, index) => declaredGaps(index)).length).toBeGreaterThan(0);
  for (const [index, row] of details.targets.entries()) {
    expect(declaredGaps(index)).toBe(row.unscopedPosts!.previewGaps.length < count);
  }
  expect(ledger.guard('/tmp/report.md', '[source](https://x.com/ReadAuthor/status/1000000)')).toBeUndefined();
  const branch = [entry(baseline, 'baseline-wait'), entry(delivered, 'gaps-wait')];
  const restored = await hydrateXResearchBranch(branch, artifacts);
  expect(restored.failures).toEqual([]);
  // 恢复链读的是工件里的**完整** canonical：缺口身份回到账本，同一条父帖引用被挡住。
  const fresh = new XResearchEvidence('/tmp', () => 'run'); fresh.restore(restored.entries);
  expect(() => fresh.guard('/tmp/report.md', '[source](https://x.com/ReadAuthor/status/1000000)')).toThrow(/inventory/);
  // Every unavailable-artifact route must retain the unknown-obligation block.
  for (const failure of ['missing', 'corrupt', 'failed_write', 'no_ref'] as const) {
    const unavailable = structuredClone(delivered);
    if (failure === 'corrupt') await fs.writeFile(artifacts.displayPath(details.artifact!), '{}');
    if (failure === 'missing') await fs.rm(artifacts.displayPath(details.artifact!));
    if (failure === 'failed_write') {
      delete unavailable.delivery!.result.artifact;
      unavailable.delivery!.result.delivery!.persistence = 'failed';
      unavailable.delivery!.result.delivery!.failureCode = 'write';
    }
    if (failure === 'no_ref') delete unavailable.delivery!.result.artifact;
    fresh.restore((await hydrateXResearchBranch([entry(baseline, 'baseline-wait')], artifacts)).entries);
    expect(fresh.guard('/tmp/report.md', '[source](https://x.com/ReadAuthor/status/1000000)')).toBeUndefined();
    const missing = await hydrateXResearchBranch(
      [entry(baseline, 'baseline-wait'), entry(unavailable, 'gaps-wait')], artifacts);
    expect(missing.failures).toHaveLength(1); fresh.restore(missing.entries);
    expect(() => fresh.guard('/tmp/report.md', '[source](https://x.com/ReadAuthor/status/1000000)')).toThrow(/Article|artifact|coverage/);
  }
});
