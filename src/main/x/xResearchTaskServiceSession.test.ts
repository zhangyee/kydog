// 会话生命周期与研究任务的接缝（spec 评审项 2）：会话一拆，在飞的那一份照信号收尾成 `interrupted`
// 并落盘；账本只在**交付**那一刻才被喂（可引用 = 已交付），已拆会话的账本永远等不到那一喂。
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { fixture, post, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { createXResearchRunner } from './xResearchRunner';
import { searchResult } from './xResearchSearch';
import { XResearchEvidence } from './xResearchEvidence';
import { XResearchScopeLedger } from './xResearchScopeFacts';
import {
  disposeXResearchThread, registerXResearchTaskService, XResearchTaskService,
  type XResearchRunWork,
} from './xResearchTaskService';
import { XResearchTaskStore } from './xResearchTaskStore';
import { createXResearchTools } from '../agent/xResearchTools';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'x-lifecycle-'));
  roots.push(dir);
  return dir;
}
beforeEach(() => { /* 每个用例自己登记、自己解绑 */ });
afterEach(() => {
  // 访问器的守卫把「换一个实例」当接线错误：解绑是每个用例的收尾。
  registerXResearchTaskService(undefined);
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 一个跑不完的工作体：等到被中止才收场（与真实采集层同一条：看 `ctx.signal`）。 */
function hangingRunner(seen: { signal?: AbortSignal; started: Promise<void> }): XResearchRunWork {
  let markStarted!: () => void;
  seen.started = new Promise<void>((resolve) => { markStarted = resolve; });
  return async (_work, ctx) => {
    seen.signal = ctx.signal;
    markStarted();
    return new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted by cancel')), { once: true });
    });
  };
}

function serviceWith(runWork: XResearchRunWork, artifacts = tempXArtifactStore()) {
  const service = new XResearchTaskService({
    store: new XResearchTaskStore(root()),
    runWork,
    onUpdate: () => undefined,
    artifacts: () => artifacts,
  });
  registerXResearchTaskService(service);
  return service;
}

const owner = () => ({ threadId: randomUUID(), runId: 'run-1', projectRoot: '/projects/x' });
const searchWork = () => ({ search: searchInput.search });

/** 被闸门放行才交结果的工作体：用来证明「没人动它，它就自己跑完」。 */
function releasedRunner(seen: { signal?: AbortSignal; started: Promise<void> }): {
  runWork: XResearchRunWork;
  release: () => void;
} {
  let markStarted!: () => void;
  seen.started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runWork: XResearchRunWork = async (_work, ctx) => {
    seen.signal = ctx.signal;
    markStarted();
    // 闸门放行或信号中止，先到的收场（与采集层同一条：中止时不产出结果）。
    await new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(new Error('aborted by teardown'));
        return;
      }
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted by teardown')), { once: true });
      void gate.then(resolve);
    });
    const result = searchResult({ search: searchInput.search }, {
      browser: {} as never, threadId: ctx.threadId, sources: new Map(),
      runId: ctx.runId, callId: ctx.submitCallId, batchId: ctx.batchId,
    });
    for (const row of result.queries) {
      row.status = 'partial';
      row.stopReason = 'budget_reached';
    }
    return result;
  };
  return { runWork, release };
}

it('cancels in-flight work when the session is disposed and marks it interrupted', async () => {
  const seen: { signal?: AbortSignal; started: Promise<void> } = { started: Promise.resolve() };
  const service = serviceWith(hangingRunner(seen));
  const thread = owner();
  const submitted = await service.submit({ work: searchWork() }, thread);
  await seen.started;
  await disposeXResearchThread(thread.threadId);
  // 中止真的送到了工作体手里（采集层靠这一条收场），而盘上的结论是「中断」而不是「还在跑」。
  expect(seen.signal?.aborted).toBe(true);
  expect((await service.get(thread.threadId, submitted.researchRunId)).state).toBe('interrupted');
  const stored = await service.get(thread.threadId, submitted.researchRunId);
  expect(stored.counts).toMatchObject({ interrupted: 1, running: 0, queued: 0 });
});

it('marks a torn-down research interrupted even though the collector returns cancelled rows instead of throwing', async () => {
  // 采集层的拆除形状同样不是抛错：`context.signal` 一响，它把剩下的行映成 `status: 'cancelled'`
  // 再返回（spec §4.7）。只看行数的收尾会把这段研究写成 `done`，而 §4.6 要的是 `interrupted` ——
  // 会话没了和被用户取消是两件事，卡上不能都说成「完成」。
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const runWork: XResearchRunWork = async (_work, ctx) => {
    const result = searchResult({ search: searchInput.search }, {
      browser: {} as never, threadId: ctx.threadId, sources: new Map(),
      runId: ctx.runId, callId: ctx.submitCallId, batchId: ctx.batchId,
    });
    markStarted();
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) resolve();
      else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    for (const row of result.queries) {
      row.status = 'cancelled';
      row.stopReason = 'cancelled';
    }
    return result;
  };
  const service = serviceWith(runWork);
  const thread = owner();
  const submitted = await service.submit({ work: searchWork() }, thread);
  await started;
  await disposeXResearchThread(thread.threadId);
  const torn = await service.get(thread.threadId, submitted.researchRunId);
  expect(torn.state).toBe('interrupted');
  // 行自己的结论仍是采集层说的「这一轮被取消了」，研究级的生命周期由 `record.state` 说「中断」：
  // 桶按行分，状态词说这段研究为什么停下（spec §5.3）。两头都要在，所以两条都断。
  expect(torn.counts).toMatchObject({
    cancelled: submitted.snapshot.search.length, interrupted: 0, running: 0, queued: 0,
  });
});

it('never delivers into a ledger that belongs to a disposed session', async () => {
  const seen: { signal?: AbortSignal; started: Promise<void> } = { started: Promise.resolve() };
  const service = serviceWith(hangingRunner(seen));
  const thread = owner();
  const observed: unknown[] = [];
  const tool = createXResearchTools({
    service, threadId: thread.threadId, projectRoot: thread.projectRoot,
    currentRunId: () => thread.runId, observeDelivery: (result) => { observed.push(result); },
  });
  const submitted = (await tool.execute('submit', { action: 'submit', ...searchInput } as never,
    undefined, undefined, {} as never)).details as { researchRunId: string };
  await seen.started;
  await disposeXResearchThread(thread.threadId);
  // 中止之后不再有可交付的结果：`wait` 交不出东西，账本就一次都没被喂 —— 没有任何观察
  // 写进一个已经拆掉的会话。
  const waited = (await tool.execute('wait', {
    action: 'wait', researchRunId: submitted.researchRunId,
  } as never, undefined, undefined, {} as never)).details as {
    delivery?: unknown; undelivered?: unknown[];
  };
  expect(waited.delivery).toBeUndefined();
  expect(waited.undelivered).toHaveLength(1);
  expect(observed).toEqual([]);
});

it('feeds the ledger only on delivery', async () => {
  const f = fixture([searchHtml(post())]);
  const ledger = new XResearchEvidence('/tmp', () => 'run-1');
  const scope = new XResearchScopeLedger();
  const artifacts = tempXArtifactStore();
  const service = serviceWith(createXResearchRunner({
    browserFor: () => f.context.browser,
    contextFor: () => ({
      sources: ledger.sources, scopePrior: (runId) => scope.prior(runId), currentRunId: () => 'run-1',
    }),
    artifacts: () => artifacts,
  }), artifacts);
  const thread = owner();
  const tool = createXResearchTools({
    service, threadId: thread.threadId, projectRoot: thread.projectRoot,
    currentRunId: () => thread.runId, observeDelivery: (result) => ledger.observe(result),
  });
  const submitted = (await tool.execute('submit', { action: 'submit', ...searchInput } as never,
    undefined, undefined, {} as never)).details as { researchRunId: string; snapshot: unknown };
  // 工作收尾了，但模型还没 `wait`：这一份不许可引用。
  await service.whenIdle(thread.threadId, submitted.researchRunId);
  expect(ledger.observations).toEqual([]);
  expect(() => ledger.guard('/tmp/x-research-topic-2026-10-12.md', '[source](https://x.com/alice/status/123)'))
    .toThrow(/unobserved/);
  const waited = (await tool.execute('wait', {
    action: 'wait', researchRunId: submitted.researchRunId,
  } as never, undefined, undefined, {} as never)).details as { delivery?: { result: unknown } };
  expect(waited.delivery).toBeDefined();
  // 交付之后才有可引用的事实，而且是这一份。
  expect(ledger.observations.length).toBeGreaterThan(0);
  expect(ledger.guard('/tmp/x-research-topic-2026-10-12.md', '[source](https://x.com/alice/status/123)')).toEqual({ createOnly: true });
});

it('does not wait for another ledger\'s running submission when a session tears down', async () => {
  const seen: { signal?: AbortSignal; started: Promise<void> } = { started: Promise.resolve() };
  const service = serviceWith(hangingRunner(seen));
  const thread = owner();
  const ledgerA = {};
  const ledgerB = {};
  // 同一 thread 上另一个账本的在飞提交（替换会话那一份）。
  const foreign = await service.submit({ work: searchWork() }, { ...thread, ledger: ledgerB });
  await seen.started;
  let resolved = false;
  void service.disposeThread(thread.threadId, ledgerA).then(() => { resolved = true; });
  // 工作体一直在等信号（没有人中止它）：拆除必须已经返回 —— 它等的是自己那一份在跑的提交，
  // 不是整条链。
  await vi.waitFor(() => expect(resolved).toBe(true));
  expect(seen.signal?.aborted).toBe(false);
  // 翻面：换成本会话的账本，同一份在飞工作就被收走，拆除也因此等得到它。
  await service.disposeThread(thread.threadId, ledgerB);
  expect(seen.signal?.aborted).toBe(true);
  expect((await service.get(thread.threadId, foreign.researchRunId)).counts)
    .toMatchObject({ interrupted: 1, running: 0, queued: 0 });
});

it('drops the cache a card RPC opened when a session tears down', async () => {
  const seen: { signal?: AbortSignal; started: Promise<void> } = { started: Promise.resolve() };
  const store = new XResearchTaskStore(root());
  const service = new XResearchTaskService({
    store, runWork: hangingRunner(seen), onUpdate: () => undefined,
    artifacts: () => tempXArtifactStore(),
  });
  const thread = owner();
  const ledger = {};
  const submitted = await service.submit({ work: searchWork() }, { ...thread, ledger });
  await seen.started;
  await service.cancel(thread.threadId, submitted.researchRunId);
  // 卡片 RPC 那一侧的形状：缓存里没有这份研究，`get` 把它按「无账本」重新打开。
  service.forget(thread.threadId);
  const cached = await service.get(thread.threadId, submitted.researchRunId);
  const record = (await store.readTask(thread.threadId, submitted.researchRunId))!;
  expect(cached.revision).toBe(record.revision);
  // 盘上前进一格：缓存还在时 `get` 答的仍是内存里那一份。
  await store.writeTask({ ...record, revision: record.revision + 7 });
  expect((await service.get(thread.threadId, submitted.researchRunId)).revision).toBe(record.revision);
  // 会话拆除：这份缓存既没有账本也没有在飞工作 —— 纯内存残留，跟着会话一起走。
  await service.disposeThread(thread.threadId, ledger);
  expect((await service.get(thread.threadId, submitted.researchRunId)).revision).toBe(record.revision + 7);
});

it('leaves a ledger-less active holding in-flight work alone when another ledger tears down', async () => {
  // 生产里造不出这个状态：每次 `submit` 都带账本。留着这条用例是为了**不让 `owns` 的安全那一半
  // 被当成死代码删掉** —— 没有账本、又真有在飞工作的 active 谁也不认领，拆除必须原样留着它。
  const seen: { signal?: AbortSignal; started: Promise<void> } = { started: Promise.resolve() };
  const { runWork, release } = releasedRunner(seen);
  const service = serviceWith(runWork);
  const thread = owner();
  const submitted = await service.submit({ work: searchWork() }, thread);
  await seen.started;
  await service.disposeThread(thread.threadId, {});
  // 拆除没碰它：信号没响，工作照旧在跑。
  expect(seen.signal?.aborted).toBe(false);
  release();
  await service.whenIdle(thread.threadId, submitted.researchRunId);
  const snapshot = await service.get(thread.threadId, submitted.researchRunId);
  // 它的工作跑完了、结论落在盘上，`get` 也还答得出这段研究。
  expect(snapshot.state).toBe('completed');
  expect(snapshot.counts).toMatchObject({ done: 1, interrupted: 0, running: 0, queued: 0 });
});
