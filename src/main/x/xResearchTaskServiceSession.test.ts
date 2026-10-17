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
