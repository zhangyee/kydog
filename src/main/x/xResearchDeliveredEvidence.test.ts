// R81d：交付后的**可引用面**认工件里的观察，不认 1 MiB 交付副本的字数。
//
// 现场：一次 search 交付 1,196,614 字节 / 904 条正文被裁（`"text": ""`、整段 `posts` 省掉），
// 账本在裁剪之后投喂（R50），于是模型读到了工件却仍然不能引用 —— 它只能为每条引用再跑一遍浏览器
// read（20 个目标 → 自我取消）。这一组用例钉住改法：`wait` 投喂的是工件里的 canonical（与
// `deliveries` 同序一一对应），交付副本只在没有工件时才是投喂源。
//
// 「已交付」仍是唯一闸：没 `wait` 过的提交，工件在盘上也不可引用（同例正控随后交付即可引用）。
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import type { XArtifactRef } from './xResearchTypes';
import type { XResearchArtifactStore } from './xResearchArtifacts';
import { finalizeXResearchCollection } from './xResearchCanonical';
import { serializeXResearchResult } from './xResearchOutput';
import { XResearchEvidence } from './xResearchEvidence';
import {
  XResearchTaskService, type XResearchRunWork, type XResearchWorkContext,
} from './xResearchTaskService';
import { XResearchTaskStore } from './xResearchTaskStore';
import type { XResearchDeliveryEnvelope } from './xResearchTaskShell';
import type { XResearchResult, XSearchObservation, XTextObservation } from './xResearchTypes';
import { createXResearchTools } from '../agent/xResearchTools';

const roots: string[] = [];
function root(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `x-delivered-evidence-${prefix}-`));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REPORT = '/tmp/x-research-topic-2026-10-18.md';
const BOB = 'https://x.com/bob/status/456';
/** 每条正文都比整份额度长：裁切必然把额度耗在前面处理的那几条上，最后剩下的只剩 `text: ""`
 *  （实测的现场形状）。工件里三条都逐字还在。 */
const BIG = 500_000;

type SearchResult = Extract<XResearchResult, { operation: 'search' }>;

function networkPost(postId: string, handle: string, text: string): XTextObservation {
  return {
    observationId: randomUUID(), sourceKind: 'page_graphql',
    networkProvenance: {
      leaseId: 'lease-1', requestRef: `request-${postId}`, navigationId: 'nav-1',
      documentEpoch: 1, routeRevision: 1, navigationSequence: 1,
      operation: 'SearchTimeline', observedAt: '2026-10-18T00:00:00.000Z',
    },
    postId,
    sourceUrl: `https://x.com/${handle}/status/${postId}`,
    author: { handle, displayName: handle, profileUrl: `https://x.com/${handle}` },
    containerKind: 'root_post', text, observedAt: '2026-10-18T00:00:00.000Z',
    truncation: { returned: text.length, totalKnown: text.length, truncated: false },
  };
}

/** 三帖：每条正文都比整份额度长，裁切必然把额度耗在前面那几条上，最后一条只剩 `text: ""`。 */
function bigPosts(ctx: XResearchWorkContext): SearchResult {
  const posts = [
    networkPost('123', 'alice', `alice:${'a'.repeat(BIG)}`),
    networkPost('456', 'bob', `bob:${'b'.repeat(BIG)}`),
    networkPost('789', 'carol', `carol:${'c'.repeat(BIG)}`),
  ];
  const row: XSearchObservation = {
    query: { id: 'q1', query: 'agent memory', purpose: '看实际做法', product: 'Top' },
    collectionTransitions: [],
    status: 'observed',
    posts,
    stopReason: 'cursor_exhausted',
    budgetUsage: { scrolls: 0, expandActions: 0, distinctEntries: posts.length, outputBytes: 0 },
    location: null,
    barrier: null,
  };
  return {
    schemaVersion: 2, sourceKind: 'page_graphql', operation: 'search',
    runId: ctx.runId, callId: ctx.submitCallId, batchId: ctx.batchId, browserTabId: 'tab-1',
    objective: 'agent memory 的实际做法',
    status: 'observed',
    budgetUsage: { scrolls: 0, expandActions: 0, distinctEntries: posts.length, outputBytes: 0 },
    truncation: { returned: 0, totalKnown: posts.reduce((n, p) => n + p.text.length, 0), truncated: false },
    queries: [row],
  };
}

/** 采集层收尾时做的同一件事（`xResearchRunner`）：finalize → 写工件 → 把 ref 与 `delivery` 放进
 *  交付副本 → 按 1 MiB 序列化。工件里是完整 canonical，交付副本照旧裁过。 */
function withArtifact(artifacts: XResearchArtifactStore): XResearchRunWork {
  return async (work, ctx) => {
    if (!('search' in work)) throw new Error('search work expected');
    const canonical = finalizeXResearchCollection(bigPosts(ctx));
    const delivery: XResearchResult = { ...canonical };
    const ref = await artifacts.write(canonical);
    delivery.artifact = ref;
    delivery.delivery = {
      truncated: false, omittedObservations: 0, omittedFields: [],
      artifactPath: await artifacts.locate(ref), persistence: 'saved',
    };
    return serializeXResearchResult(delivery).result;
  };
}

function withoutArtifact(): XResearchRunWork {
  return async (work, ctx) => {
    if (!('search' in work)) throw new Error('search work expected');
    const canonical = finalizeXResearchCollection(bigPosts(ctx));
    return serializeXResearchResult({
      ...canonical,
      delivery: {
        truncated: false, omittedObservations: 0, omittedFields: [],
        artifactPath: null, persistence: 'failed', failureCode: 'write',
      },
    }).result;
  };
}

const SEARCH = {
  search: {
    objective: 'agent memory 的实际做法',
    queries: [{ id: 'q1', query: 'agent memory', purpose: '看实际做法', product: 'Top' as const }],
    maxPostsPerQuery: 10, maxScrollsPerQuery: 1,
  },
};

function harness(mode: 'saved' | 'failed') {
  // 写工件的那一个 store 必须就是 `deps.artifacts` 返回的那一个：两份临时根会让交付读不到自己的工件。
  const artifacts = tempXArtifactStore();
  const runWork = mode === 'saved' ? withArtifact(artifacts) : withoutArtifact();
  const threadId = randomUUID();
  const store = new XResearchTaskStore(root('store'));
  const ledger = new XResearchEvidence(REPORT, () => 'run-1');
  const service = new XResearchTaskService({
    store, runWork, onUpdate: () => undefined, artifacts: () => artifacts,
  });
  const tool = createXResearchTools({
    service, threadId, projectRoot: '/projects/x', currentRunId: () => 'run-1',
    observeDelivery: (result) => ledger.observe(result),
  });
  const execute = async (raw: Record<string, unknown>, callId: string) =>
    (await tool.execute(callId, raw as never, undefined, undefined, {} as never))
      .details as XResearchDeliveryEnvelope;
  const submit = async () => (await execute({ action: 'submit', ...SEARCH }, 'submit-1')).researchRunId;
  const wait = (researchRunId: string, callId = 'wait-1') => execute(
    { action: 'wait', researchRunId }, callId);
  return { artifacts, ledger, service, threadId, submit, wait };
}

/** 交付副本里那条被裁到空正文的帖子：位置随包络裁切的顺序而变，用例只认「哪一条空了」。 */
function clippedPostOf(delivered: XResearchDeliveryEnvelope): { postId: string; sourceUrl: string } {
  const posts = delivered.deliveries![0]!.result.operation === 'search'
    ? delivered.deliveries![0]!.result.queries[0]!.posts
    : [];
  const empty = posts.filter((post) => post.text === '');
  if (!empty.length) throw new Error('expected at least one body clipped out entirely');
  const { postId, sourceUrl } = empty[0]!;
  if (!postId || !sourceUrl) throw new Error('the clipped-out body lost its identity');
  return { postId, sourceUrl };
}

function artifactPost(full: SearchResult, postId: string): XTextObservation {
  return full.queries[0]!.posts.find((post) => post.postId === postId)!;
}

it('cites a body the delivery clipped away from the artifact, and not a text altered by one character', async () => {
  const { artifacts, ledger, service, threadId, submit, wait } = harness('saved');
  const researchRunId = await submit();
  await service.whenIdle(threadId, researchRunId);
  const delivered = await wait(researchRunId);
  const submitted = delivered.deliveries![0]!;
  // 前提：交付副本确实把一条正文裁空了（`"text": ""`），工件里那份逐字还在。
  const clipped = clippedPostOf(delivered);
  const full = await artifacts.read(submitted.result.artifact!);
  if (full.operation !== 'search') throw new Error('search artifact expected');
  const original = artifactPost(full, clipped.postId)!;
  expect(original.text.length).toBeGreaterThanOrEqual(BIG);
  expect(delivered.deliveries![0]!.result.operation === 'search'
    && delivered.deliveries![0]!.result.queries[0]!.posts
      .filter((post) => post.text === '').length).toBe(1);
  // 正控：这条帖凭工件可引用（交付副本里它一个字都没有）。
  expect(ledger.guard(REPORT, `[source](${clipped.sourceUrl})`)).toEqual({ createOnly: true });
  // 账本里授权引用的就是工件里的那一份**逐字**正文，不是重新序列化出来的近似。
  const records = ledger.observations.filter((o) => o.sourceUrl === clipped.sourceUrl);
  expect(records.map((o) => o.text)).toEqual([original.text]);
  // 反控：同一段正文改一个字不在账本里 —— 先证明原文在工件字节里，再证明改过的那段不在。
  const tail = original.text.slice(-24);
  const altered = `${tail.slice(0, -1)}${tail.endsWith('X') ? 'Y' : 'X'}`;
  expect(tail).not.toBe(altered);
  expect(full.queries[0]!.posts.some((post) => post.text.includes(tail))).toBe(true);
  expect(full.queries[0]!.posts.some((post) => post.text.includes(altered))).toBe(false);
  expect(ledger.observations.some((o) => o.text.includes(altered))).toBe(false);
});

it('rejects a fabricated postId while the real one in the same delivery stays citable', async () => {
  const { ledger, service, threadId, submit, wait } = harness('saved');
  const researchRunId = await submit();
  await service.whenIdle(threadId, researchRunId);
  const delivered = await wait(researchRunId);
  const clipped = clippedPostOf(delivered);
  // 正控：真 postId 可引用。
  expect(ledger.guard(REPORT, `[source](${clipped.sourceUrl})`)).toEqual({ createOnly: true });
  // 反控：同一页上从没被观察过的 postId 被拒（不是「工件在就什么都放行」）。
  expect(() => ledger.guard(REPORT, `[source](${clipped.sourceUrl.replace(/\d+$/, '999')})`))
    .toThrow(/unobserved/);
  expect(ledger.observations.some((o) => o.postId === '999')).toBe(false);
});

it('keeps an undelivered submission uncitable even though its artifact is already on disk', async () => {
  const { ledger, service, threadId, submit, wait } = harness('saved');
  const researchRunId = await submit();
  await service.whenIdle(threadId, researchRunId);
  // 工作收尾了、工件在盘上，但模型还没 `wait`：这份观察不许可引用。
  expect(() => ledger.guard(REPORT, `[source](${BOB})`)).toThrow(/unobserved/);
  expect(ledger.observations).toEqual([]);
  // 翻面：`wait` 交付之后，同一条引用通过 —— 「可引用 = 已交付」与「正文来自工件」同时成立。
  const delivered = await wait(researchRunId);
  expect(delivered.deliveries).toHaveLength(1);
  expect(ledger.guard(REPORT, `[source](${BOB})`)).toEqual({ createOnly: true });
});

it('falls back to the clipped copy for a delivery that has no artifact', async () => {
  const { ledger, service, threadId, submit, wait } = harness('failed');
  const researchRunId = await submit();
  await service.whenIdle(threadId, researchRunId);
  const delivered = await wait(researchRunId);
  const clipped = clippedPostOf(delivered);
  const kept = delivered.deliveries![0]!.result.operation === 'search'
    ? delivered.deliveries![0]!.result.queries[0]!.posts.find((post) => post.text !== '')
    : undefined;
  // 没有工件（`persistence: 'failed'`）：投喂源就是交付副本，模型看到什么就能引用什么 ——
  // 留下的那条可引用……
  expect(ledger.guard(REPORT, `[source](${kept!.sourceUrl})`)).toEqual({ createOnly: true });
  // ……被裁空的那条不可引用：账本里它的正文就是空串（同一条帖在有工件那一组里是逐字全文，
  // 差别只在这条 fallback 上）。
  expect(() => ledger.guard(REPORT, `[source](${clipped.sourceUrl})`)).toThrow(/unobserved/);
  expect(ledger.observations.filter((o) => o.sourceUrl === clipped.sourceUrl).map((o) => o.text))
    .toEqual(['']);
});

it('reads a delivered artifact once per delivery, including the ledger feed', async () => {
  const artifacts = tempXArtifactStore();
  const store = new XResearchTaskStore(root('restart'));
  const reads: XArtifactRef[] = [];
  const counted: XResearchArtifactStore = {
    ...artifacts,
    read: async (ref) => { reads.push(ref); return artifacts.read(ref); },
  };
  const first = new XResearchTaskService({
    store, runWork: withArtifact(artifacts), onUpdate: () => undefined, artifacts: () => artifacts,
  });
  const threadId = randomUUID();
  const submitted = await first.submit({ work: SEARCH }, {
    threadId, runId: 'run-1', projectRoot: '/projects/x',
  });
  await first.whenIdle(threadId, submitted.researchRunId);
  // 重启后的形状：内存里没有结果，交付必须把工件读回来（一大份，多个 chunk）。
  const second = new XResearchTaskService({
    store, runWork: withArtifact(artifacts), onUpdate: () => undefined, artifacts: () => counted,
  });
  const ledger = new XResearchEvidence(REPORT, () => 'run-1');
  const tool = createXResearchTools({
    service: second, threadId, projectRoot: '/projects/x', currentRunId: () => 'run-1',
    observeDelivery: (result) => ledger.observe(result),
  });
  const delivered = (await tool.execute('wait-1', { action: 'wait', researchRunId: submitted.researchRunId } as never,
    undefined, undefined, {} as never)).details as XResearchDeliveryEnvelope;
  expect(delivered.deliveries).toHaveLength(1);
  // 一次交付正好读一次工件：交付字节与账本投喂源是同一份读回来的 canonical，不为了喂账本再读一遍。
  expect(reads).toHaveLength(1);
  // 而且这次喂的确实是工件那一份：交付副本里被裁空的那条帖，凭工件可引用，正文逐字等于工件。
  const clipped = clippedPostOf(delivered);
  const artifactPost = (await artifacts.read(delivered.deliveries![0]!.result.artifact!)) as SearchResult;
  expect(ledger.observations.find((o) => o.sourceUrl === clipped.sourceUrl)?.text)
    .toBe(artifactPost.queries[0]!.posts.find((post) => post.postId === clipped.postId)!.text);
  expect(ledger.guard(REPORT, `[source](${clipped.sourceUrl})`)).toEqual({ createOnly: true });
});
