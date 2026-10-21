// 恢复链的 thread 级读入口：任务根按 researchRunId 分叉，而 ref 里没有 researchRunId。
// 三条判据：命中那一个 run 时读到同一份字节、一个 run 都没有时按「读不到」收场（hydrate 说
// `restoration: missing`）、改造前的旧根仍然读得通（双根没丢）。
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture, post, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import type { XResearchTaskSnapshot } from '../../shared/xResearchTask';
import {
  createXResearchArtifactStore, createXResearchThreadArtifactStore,
  type XResearchArtifactStore,
} from './xResearchArtifacts';
import { hydrateXResearchBranch } from './xResearchBranch';
import { deliverEnvelope } from './xResearchDeliver';
import { serializeXResearchResult } from './xResearchOutput';
import { searchX } from './xResearchSearch';
import type { XArtifactRef, XResearchResult } from './xResearchTypes';

const roots: string[] = [];
function root(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `x-thread-artifact-${prefix}-`));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const THREAD = '33333333-3333-4333-8333-333333333333';
const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** 真采集结果（工件 store 只写 canonical 的公开 DTO，夹具必须是真的一份）。 */
async function collected(): Promise<XResearchResult> {
  return (await searchX(
    { ...searchInput, search: { ...searchInput.search, maxScrollsPerQuery: 0 } },
    fixture([searchHtml(post())]).context,
  )) as XResearchResult;
}

function runArtifacts(rootPath: string, legacy: string, runId: string): XResearchArtifactStore {
  return createXResearchArtifactStore({ task: path.join(rootPath, THREAD, runId, 'artifact'), legacy });
}

function threadStore(rootPath: string, legacy: string) {
  return createXResearchThreadArtifactStore({ root: rootPath, threadId: THREAD, legacy });
}

it('reads a ref written under one research run and locates its artifact path', async () => {
  const task = root('task'), legacy = root('legacy');
  const store = runArtifacts(task, legacy, RUN_A);
  const full = await collected();
  const ref = await store.write(full);
  // 正面对照：同一个 ref 从 thread 级入口读回来的是同一份字节（走的是那个 run 的双根 store）。
  const read = await threadStore(task, legacy).read(ref);
  expect(read).toEqual(await store.read(ref));
  // 模型可见的那种路径在这里也 stat 得到（`locate` 的双根定位没被绕过）。
  const artifactPath = await store.locate(ref);
  expect((await fs.stat(artifactPath)).isFile()).toBe(true);
  expect(artifactPath.startsWith(path.join(task, THREAD, RUN_A, 'artifact'))).toBe(true);
});

it('fails as unreadable when no research run holds the directory identity', async () => {
  const task = root('task'), legacy = root('legacy');
  const store = runArtifacts(task, legacy, RUN_A);
  const full = await collected();
  // 一份形状合法、但盘上任何 run 都没有的 ref：thread 级入口必须说「读不到」，而不是让
  // hydrate 以为这份结果没有工件（那是「没落盘」，与「找不回来」两件事）。
  const missing: XArtifactRef = { ...(await store.write(full)), directoryId: '11111111-1111-4111-8111-111111111111' };
  const details = deliverEnvelope({
    researchRunId: 'research', snapshot: snapshot(), action: 'wait', undelivered: [],
    deliveries: [{
      deliveryCallId: 'delivery-call', submissionId: 'submission-1', submitCallId: 'call',
      operation: full.operation, result: serializeXResearchResult({ ...full, artifact: missing }).result,
    }],
  }).details;
  const hydrated = await hydrateXResearchBranch(
    [{ type: 'message', message: { role: 'toolResult', toolName: 'x_research',
      toolCallId: 'delivery-call', isError: false, details } }],
    threadStore(task, legacy),
  );
  expect(hydrated.failures).toEqual([{ callId: 'delivery-call', reason: 'read' }]);
  expect(hydrated.entries[0]).toMatchObject({ message: { details: { deliveries: [{ result: {
    restoration: { status: 'missing', reason: 'read' },
  } }] } } });
});

it('still reads a ref written under the legacy root', async () => {
  const task = root('task'), legacy = root('legacy');
  const flat = createXResearchArtifactStore(legacy);
  const full = await collected();
  const ref = await flat.write(full);
  expect(await threadStore(task, legacy).read(ref)).toEqual(await flat.read(ref));
});

it('refuses an ambiguous directory identity instead of picking a run', async () => {
  const task = root('task'), legacy = root('legacy');
  const full = await collected();
  const written = await runArtifacts(task, legacy, RUN_A).write(full);
  // 同一个 directoryId 出现在第二个 run 下：这份 ref 指向哪一个都说得通，所以不许猜。
  await fs.mkdir(path.join(task, THREAD, RUN_B, 'artifact'), { recursive: true });
  await fs.cp(
    path.join(task, THREAD, RUN_A, 'artifact', written.directoryId),
    path.join(task, THREAD, RUN_B, 'artifact', written.directoryId),
    { recursive: true },
  );
  await expect(threadStore(task, legacy).read(written)).rejects
    .toMatchObject({ name: 'XResearchArtifactError', code: 'read' });
});

function snapshot(): XResearchTaskSnapshot {
  return {
    researchRunId: 'research', threadId: 'thread', revision: 1, state: 'completed',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:01.000Z',
    objective: 'research',
    counts: {
      submissions: 1, queued: 0, running: 0, done: 1, failed: 0, cancelled: 0, interrupted: 0,
      posts: 1, replies: 0, articles: 0, undelivered: 0,
      searchDone: 0, searchTotal: 0, readDone: 0, readTotal: 0,
    },
    budget: { scrolls: 500, expandActions: 0 },
    usage: { posts: 1, scrolls: 0, expandActions: 0 },
    search: [], read: [],
  };
}
