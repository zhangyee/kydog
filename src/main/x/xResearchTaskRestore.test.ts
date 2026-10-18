import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, post, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { SKIP_WITHOUT_SYMLINK, SYMLINK_SKIP_REASON } from '../../test-support/symlinkCapability';
import type { XResearchTaskSnapshot } from '../../shared/xResearchTask';
import { createXResearchArtifactStore, type XResearchArtifactStore } from './xResearchArtifacts';
import { hydrateXResearchBranch } from './xResearchBranch';
import { XResearchEvidence } from './xResearchEvidence';
import { deliverEnvelope } from './xResearchDeliver';
import { serializeXResearchResult } from './xResearchOutput';
import { XResearchScopeLedger } from './xResearchScopeFacts';
import { searchX } from './xResearchSearch';
import type { XArtifactRef, XResearchResult } from './xResearchTypes';

const roots: string[] = [];
function root(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `x-restore-${prefix}-`));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(details: unknown, toolCallId: string): unknown {
  return { id: `entry-${toolCallId}`, type: 'message', message: {
    role: 'toolResult', toolName: 'x_research', toolCallId, isError: false, details,
  } };
}

const snapshot = (): XResearchTaskSnapshot => ({
  researchRunId: 'run', threadId: 'thread', revision: 1, state: 'completed',
  createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:01.000Z',
  objective: 'research',
  counts: {
    submissions: 1, queued: 0, running: 0, done: 1, failed: 0, cancelled: 0, interrupted: 0,
    posts: 2, replies: 0, articles: 0, undelivered: 0,
    searchDone: 0, searchTotal: 0, readDone: 0, readTotal: 0,
  },
  budget: { scrolls: 500, expandActions: 0 },
  usage: { posts: 2, scrolls: 0, expandActions: 0 },
  search: [], read: [],
});

type SearchResult = Extract<XResearchResult, { operation: 'search' }>;

/** 走一次采集层的真结果：两帖，第二帖只可能在工件里（交付副本按 1 MiB 裁过）。 */
async function twoPosts(): Promise<SearchResult> {
  return (await searchX(
    { ...searchInput, search: { ...searchInput.search, maxScrollsPerQuery: 0 } },
    fixture([searchHtml(post() + post('456', 'bob', 'second body'))]).context,
  )) as SearchResult;
}

/** 交付的那一份：再序列化一次就是工具结果里的副本（省略账本与 `budgetUsage` 定点由它盖）。 */
function deliveredCopy(full: SearchResult, artifact: XArtifactRef): SearchResult {
  return serializeXResearchResult({ ...full, artifact }).result as SearchResult;
}

function storeWith(task: string, legacy: string): XResearchArtifactStore {
  return createXResearchArtifactStore({ task, legacy });
}

/** `wait` 交付的壳：`deliveryCallId` 是这一轮 `wait` 的 callId，`submitCallId` 是提交那一轮（R20）。 */
function shell(input: {
  toolCallId: string;
  submitCallId: string;
  result: XResearchResult;
}): unknown {
  return deliverEnvelope({
    researchRunId: 'run', snapshot: snapshot(), action: 'wait', undelivered: [],
    deliveries: [{
      deliveryCallId: input.toolCallId, submissionId: 'submission-1',
      submitCallId: input.submitCallId, operation: input.result.operation,
      result: input.result,
    }],
  }).details;
}

it('restores a delivered result from the shell', async () => {
  const store = storeWith(root('task'), root('legacy'));
  const full = await twoPosts();
  const ref = await store.write(full);
  // 交付副本只有第一帖；工件里那份是完整的 canonical（R20）。
  const clipped = deliveredCopy(full, ref);
  clipped.queries[0].posts = clipped.queries[0].posts.slice(0, 1);
  const details = shell({ toolCallId: 'delivery-call', submitCallId: 'call', result: clipped });
  const hydrated = await hydrateXResearchBranch([entry(details, 'delivery-call')], store);
  expect(hydrated.failures).toEqual([]);
  const evidence = new XResearchEvidence('/tmp', () => 'run');
  evidence.restore(hydrated.entries);
  // 第二帖只在工件里：恢复出它就是证明账本吃的是 canonical，不是裁过的交付副本。
  expect(evidence.observations.map((o) => o.text)).toEqual(['original', 'second body']);
  const scope = new XResearchScopeLedger();
  scope.restore(hydrated.entries);
  // 壳里那次提交（submitCallId）已经入账；`withCurrent` 再加一次当前轮 → 2 次而不是 1 次。
  expect(scope.prior('run').withCurrent({ ...full, callId: 'next' })).toMatchObject({
    callCount: 2, unavailableCallCount: 0,
  });
  // 每次同步都会把整条分支重新恢复一遍：已经恢复过的那一份不许被说成「没落盘」。
  const again = await hydrateXResearchBranch(hydrated.entries, store);
  expect(again.failures).toEqual([]);
  expect(again.entries[0]).toMatchObject({ message: { details: { kind: 'x_research' } } });
  // R20 的完整性判据：交付那一轮对不上就不恢复，也进不了账本。
  const foreign = await hydrateXResearchBranch([entry(details, 'other-call')], store);
  expect(foreign.failures).toEqual([{ callId: 'other-call', reason: 'reference' }]);
  const foreignEvidence = new XResearchEvidence('/tmp', () => 'run');
  foreignEvidence.restore(foreign.entries);
  expect(foreignEvidence.observations).toEqual([]);
  // `result.callId` 必须是**提交**那一轮，不是随便哪一轮。
  const wrongSubmit = await hydrateXResearchBranch(
    [entry(shell({ toolCallId: 'delivery-call', submitCallId: 'other', result: clipped }), 'delivery-call')],
    store,
  );
  expect(wrongSubmit.failures).toEqual([{ callId: 'delivery-call', reason: 'reference' }]);
  // ref 与结果说的不是同一批（同一份壳、只改 `ref.batchId`）：引用不指向这份结果，不恢复，
  // 但要留下 `restoration` 标记 —— 不然那份工件凭空消失而没人说得出为什么。
  const wrongBatch = await hydrateXResearchBranch(
    [entry(shell({
      toolCallId: 'delivery-call', submitCallId: 'call',
      result: { ...clipped, artifact: { ...ref, batchId: 'other-batch' } },
    }), 'delivery-call')],
    store,
  );
  expect(wrongBatch.failures).toEqual([{ callId: 'delivery-call', reason: 'reference' }]);
  expect(wrongBatch.entries[0]).toMatchObject({ message: { details: { deliveries: [{ result: {
    restoration: { status: 'missing', reason: 'reference' },
  } }] } } });
});

it('still restores a hand-written single-delivery shell from an older transcript', async () => {
  // R81c 之前每一次 `wait` 写的是 `details.delivery`（单数）。旧会话必须照旧恢复：
  // 读侧同时认单数与平铺，新的 `deliveries` 只是模型看到的那一帧。
  const store = storeWith(root('task'), root('legacy'));
  const full = await twoPosts();
  const ref = await store.write(full);
  const clipped = deliveredCopy(full, ref);
  clipped.queries[0].posts = clipped.queries[0].posts.slice(0, 1);
  const legacy = {
    kind: 'x_research', action: 'wait', researchRunId: 'run', status: 'completed',
    snapshot: snapshot(),
    delivery: {
      deliveryCallId: 'delivery-call', submissionId: 'submission-1',
      submitCallId: 'call', operation: 'search', result: clipped,
    },
  };
  const hydrated = await hydrateXResearchBranch([entry(legacy, 'delivery-call')], store);
  expect(hydrated.failures).toEqual([]);
  // 恢复链把工件里的完整 canonical 写回旧形状（`delivery`），不擅自改写成新键。
  expect(hydrated.entries[0]).toMatchObject({ message: { details: { delivery: { result: {
    queries: [{ posts: [{ text: 'original' }, { text: 'second body' }] }],
  } } } } });
  const evidence = new XResearchEvidence('/tmp', () => 'run');
  evidence.restore(hydrated.entries);
  expect(evidence.observations.map((o) => o.text)).toEqual(['original', 'second body']);
  // 旧壳恢复后引用照旧可用：第二帖只在工件里（交付副本里被裁掉了），凭恢复出来的观察可引用。
  expect(evidence.guard('/tmp/report.md', '[source](https://x.com/bob/status/456)')).toBeUndefined();
  const scope = new XResearchScopeLedger();
  scope.restore(hydrated.entries);
  expect(scope.prior('run').withCurrent({ ...full, callId: 'next' })).toMatchObject({
    callCount: 2, unavailableCallCount: 0,
  });
});

it('still restores a flat pre-change toolResult', async () => {
  // 改造前的单根 store：旧 transcript 里的 ref 就是这种形态写下的。
  const store = createXResearchArtifactStore(root('flat'));
  const full = await twoPosts();
  const ref = await store.write(full);
  const projected = deliveredCopy(full, ref);
  projected.queries[0].posts = projected.queries[0].posts.slice(0, 1);
  const hydrated = await hydrateXResearchBranch([entry(projected, 'call')], store);
  expect(hydrated.failures).toEqual([]);
  // 平铺路径照旧：整份 details 换成工件里的 canonical。
  expect(hydrated.entries[0]).toMatchObject({ message: { details: {
    queries: [{ posts: [{ text: 'original' }, { text: 'second body' }] }],
  } } });
  const evidence = new XResearchEvidence('/tmp', () => 'run');
  evidence.restore(hydrated.entries);
  expect(evidence.observations.map((o) => o.text)).toEqual(['original', 'second body']);
  // 平铺的旧结果（改造前没有壳）恢复后同样可引用：工件里的第二帖照样授权。
  expect(evidence.guard('/tmp/report.md', '[source](https://x.com/bob/status/456)')).toBeUndefined();
  const scope = new XResearchScopeLedger();
  scope.restore(hydrated.entries);
  expect(scope.prior('run').withCurrent({ ...full, callId: 'next' })).toMatchObject({
    callCount: 2, unavailableCallCount: 0,
  });
});

it('reads an artifact written under the legacy root', async () => {
  const legacy = root('legacy'), task = root('task');
  const full = await twoPosts();
  // 改造前写下的工件：单根 store，写与读都在旧根（`<sessionsDir>/<sessionId>.x-research`）。
  const old = createXResearchArtifactStore(legacy);
  const ref = await old.write(full);
  expect(await storeWith(task, legacy).read(ref)).toEqual(await old.read(ref));
});

it('requires the legacy root in the object form', () => {
  // `legacy` 是必填项：对象写法漏掉它，`read` / `locate` 只会找任务根，旧根里的历史证据就此
  // 静默消失。这个闭包**不执行**，它钉的是类型 —— 这一行一旦不再报错，就是有人把它改回可选了。
  const construct = (): XResearchArtifactStore => {
    // @ts-expect-error 对象写法必须两个根都给
    return createXResearchArtifactStore({ task: root('task') });
  };
  expect(construct).toBeTypeOf('function');
});

it('locates an artifact that only exists under the legacy root', async () => {
  const legacy = root('legacy'), task = root('task');
  const old = createXResearchArtifactStore(legacy);
  const ref = await old.write(await twoPosts());
  const store = storeWith(task, legacy);
  // 这条同时证明两棵根真都被找了（`legacy` 是必填项的运行时判据）：旧根里那一份给出的是
  // 旧根下的路径，而且模型照着它能真的打开文件 —— 不是任务根下一个不存在的路径。
  const legacyPath = await store.locate(ref);
  expect(legacyPath).toBe(path.join(legacy, ref.directoryId, 'manifest.json'));
  expect((await fs.stat(legacyPath)).isFile()).toBe(true);
  // 翻面：同一份 ref 落在任务根时，定位给的是任务根下的路径。
  const taskRef = await store.write(await twoPosts());
  const taskPath = await store.locate(taskRef);
  expect(taskPath).toBe(path.join(task, taskRef.directoryId, 'manifest.json'));
  expect((await fs.stat(taskPath)).isFile()).toBe(true);
});

it('reads an artifact written under the task root', async () => {
  const task = root('task'), legacy = root('legacy');
  const store = storeWith(task, legacy);
  const full = await twoPosts();
  const ref = await store.write(full);
  // 写只有一根：任务根。
  expect(await fs.readdir(task)).toEqual([ref.directoryId]);
  expect(await fs.readdir(legacy)).toEqual([]);
  expect(await store.read(ref)).toEqual(await createXResearchArtifactStore(task).read(ref));
});

it('does not feed the ledger from a shell that lacks delivery', async () => {
  const store = storeWith(root('task'), root('legacy'));
  const full = await twoPosts();
  const ref = await store.write(full);
  const clipped = deliveredCopy(full, ref);
  const { details: withoutDelivery } = deliverEnvelope({
    researchRunId: 'run', snapshot: snapshot(), action: 'submit', deliveries: [], undelivered: [],
  });
  // 同一份壳带 delivery 时是喂账本的（正面对照），不带时一条都不许进。
  const fed = new XResearchEvidence('/tmp', () => 'run');
  fed.restore((await hydrateXResearchBranch(
    [entry(shell({ toolCallId: 'delivery-call', submitCallId: 'call', result: clipped }), 'delivery-call')],
    store,
  )).entries);
  expect(fed.observations.length).toBeGreaterThan(0);
  const unfed = new XResearchEvidence('/tmp', () => 'run');
  unfed.restore([entry(withoutDelivery, 'submit-call')]);
  expect(unfed.observations).toEqual([]);
  expect(unfed.sources.size).toBe(0);
  expect(unfed.legacyProjections).toEqual([]);
  const scope = new XResearchScopeLedger();
  scope.restore([entry(withoutDelivery, 'submit-call')]);
  expect(scope.prior('run').withCurrent({ ...full, callId: 'next' })).toMatchObject({
    callCount: 1, unavailableCallCount: 0,
  });
  // 只认「交付那一轮」还不够：壳自己的两轮对不上（`result.callId` ≠ `submitCallId`）时，
  // 恢复链把这份壳判成不可信，两个账本也得一样 —— 否则一份错壳能自己喂出证据。
  const mismatched = shell({ toolCallId: 'delivery-call', submitCallId: 'other', result: clipped });
  const refused = new XResearchEvidence('/tmp', () => 'run');
  refused.restore([entry(mismatched, 'delivery-call')]);
  expect(refused.observations).toEqual([]);
  expect(refused.sources.size).toBe(0);
  expect(refused.legacyProjections).toEqual([]);
  const refusedScope = new XResearchScopeLedger();
  refusedScope.restore([entry(mismatched, 'delivery-call')]);
  expect(refusedScope.prior('run').withCurrent({ ...full, callId: 'next' })).toMatchObject({
    callCount: 1, unavailableCallCount: 0,
  });
});

it('keeps a delivered result without its artifact from authorizing the parent', async () => {
  const task = root('task');
  const store = storeWith(task, root('legacy'));
  const full = await twoPosts();
  const ref = await store.write(full);
  // 交付副本按 1 MiB 裁过：Article 义务掉了，它自己得说出来（不然这条用例的前提不成立）。
  const clipped = deliveredCopy(full, ref);
  clipped.delivery = {
    ...clipped.delivery!, truncated: true, omittedObservations: 1,
    omittedFields: ['queries.0.posts'], articleObligationCoverage: 'not_inline',
  };
  const details = shell({ toolCallId: 'delivery-call', submitCallId: 'call', result: clipped });
  const evidence = new XResearchEvidence('/tmp', () => 'run');
  evidence.restore((await hydrateXResearchBranch([entry(details, 'delivery-call')], store)).entries);
  expect(evidence.guard('/tmp/report.md', '[source](https://x.com/alice/status/123)')).toBeUndefined();
  // 工件没了：裁过的交付副本照旧进账本，但省略的 Article 义务说不清了 —— 父帖引用必须被挡。
  await fs.rm(path.join(task, ref.directoryId), { recursive: true, force: true });
  const missing = await hydrateXResearchBranch([entry(details, 'delivery-call')], store);
  expect(missing.failures).toEqual([{ callId: 'delivery-call', reason: 'read' }]);
  evidence.restore(missing.entries);
  expect(evidence.observations.length).toBeGreaterThan(0);
  expect(() => evidence.guard('/tmp/report.md', '[source](https://x.com/alice/status/123)'))
    .toThrow('restoration');
});

it.skipIf(SKIP_WITHOUT_SYMLINK)(
  `rejects a legacy-root artifact directory that aliases another location (${SYMLINK_SKIP_REASON})`,
  async () => {
    const legacy = root('legacy'), task = root('task');
    const old = createXResearchArtifactStore(legacy);
    const ref = await old.write(await twoPosts());
    const store = storeWith(task, legacy);
    // 正面对照：任务根里没有它时，旧根里的这份读得通。
    expect(await store.read(ref)).toEqual(await old.read(ref));
    await fs.rename(path.join(legacy, ref.directoryId), path.join(legacy, 'outside'));
    await fs.symlink(path.join(legacy, 'outside'), path.join(legacy, ref.directoryId), 'dir');
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'path' });
  },
);
