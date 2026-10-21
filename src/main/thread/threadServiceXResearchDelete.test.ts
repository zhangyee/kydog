// 删对话的队列边界（Task 9 评审 F1）：`AgentService.dispose` 读不到 bound session 时早退，
// 所以「从没建过会话的对话」在删除时没有人等它的 x 研究队列。目录随后被删，排队的那一份若还活着，
// 它自己的落盘会把目录写回来。这里钉的是**删除那一刻**盘上的队列已经空了，且之后没人再写它。
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { saveIndex } from '../persist/indexFile';
import { searchInput } from '../../test-support/xResearchFixture';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import {
  disposeXResearchThread, registerXResearchTaskService, XResearchTaskService,
  type XResearchRunWork,
} from '../x/xResearchTaskService';
import { xResearchTaskStore } from '../x/xResearchTaskStore';

const H = vi.hoisted(() => ({
  taskDir: `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/kydog-x-delete-${process.pid}-${Date.now()}`,
  started: [] as string[],
}));

// 真目录、真 store：这条用例要看的就是「目录还在不在」，替身答不了这个问题。
vi.mock('../x/xResearchTaskStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../x/xResearchTaskStore')>();
  return { xResearchTaskStore: new actual.XResearchTaskStore(H.taskDir) };
});
vi.mock('../webResearch/runStore', () => ({
  researchRunStore: { removeRunsForThread: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../browser/browserService', () => ({
  browserService: { disposeForThread: vi.fn(), endRun: vi.fn() },
}));
vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn(), emitTo: vi.fn() } }));

const { threadService } = await import('./threadService');
const { searchResult } = await import('../x/xResearchSearch');

/** 每一份都跑到被中止或闸门放行才收场：删除之前，第二份必然还排在链上没有起跑。 */
function runner(): { runWork: XResearchRunWork; started: Promise<void>; release: () => void } {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runWork: XResearchRunWork = async (_work, ctx) => {
    H.started.push(ctx.runId);
    markStarted();
    const result = searchResult({ search: searchInput.search }, {
      browser: {} as never, threadId: ctx.threadId, sources: new Map(),
      runId: ctx.runId, callId: ctx.submitCallId, batchId: ctx.batchId,
    });
    for (const row of result.queries) {
      row.status = 'partial';
      row.stopReason = 'budget_reached';
    }
    // 信号中止（拆除）与闸门放行（「没人等它」）两者先到的收场。
    await new Promise<void>((resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(new Error('aborted by teardown'));
        return;
      }
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted by teardown')), { once: true });
      void gate.then(() => resolve());
    });
    return result;
  };
  return { runWork, started, release };
}

let dir: string;
beforeEach(async () => {
  mkdirSync(H.taskDir, { recursive: true });
  dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-thr-xr-'));
  vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
  vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
  // 会话文件删的是这一类路径：重定向进临时目录，别碰真 home。
  mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  vi.spyOn(paths, 'sessionFileFor').mockImplementation((_projectPath, threadId) =>
    path.join(dir, 'sessions', `${threadId}.jsonl`));
  await saveIndex({
    schemaVersion: 1,
    projects: [{ path: '/x', addedAt: new Date().toISOString() }],
    threads: [],
  });
  H.started = [];
});
afterEach(() => {
  registerXResearchTaskService(undefined);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => { rmSync(H.taskDir, { recursive: true, force: true }); });

it('drains the queued research before removing the task directory, even with no bound session', async () => {
  const thread = await threadService.create({ projectPath: '/x', title: 'a' });
  const { runWork, started, release } = runner();
  const service = new XResearchTaskService({
    store: xResearchTaskStore, runWork, onUpdate: () => undefined,
    artifacts: () => tempXArtifactStore(),
  });
  registerXResearchTaskService(service);
  const ownerOf = (runId: string) => ({ threadId: thread.id, runId, projectRoot: '/x' });
  const first = await service.submit({ work: { search: searchInput.search } }, ownerOf('run-A'));
  await started;
  const second = await service.submit({ work: { search: searchInput.search } }, ownerOf('run-B'));

  const statesOnDisk = async (): Promise<string[]> => {
    const states: string[] = [];
    for (const runId of [first.researchRunId, second.researchRunId]) {
      for (const submission of await xResearchTaskStore.listSubmissions(thread.id, runId)) {
        states.push(submission.state);
      }
    }
    return states.sort();
  };
  // 前提：此刻盘上确实是一跑一排（否则下面那个「都收尾了」的空集是假的）。
  expect(await statesOnDisk()).toEqual(['queued', 'running']);

  // 「删除时队列已经排空」读的是删除那一刻的盘：`removeThread` 一响就读一遍两份提交文件。
  const removeThread = xResearchTaskStore.removeThread.bind(xResearchTaskStore);
  const atRemoval: string[] = [];
  vi.spyOn(xResearchTaskStore, 'removeThread').mockImplementation(async (threadId: string) => {
    atRemoval.push(...await statesOnDisk());
    return removeThread(threadId);
  });

  await threadService.delete({ threadIds: [thread.id] });

  // 两格都已经有结论：在飞的 A 收成「中断」，排在它后面的那一份也没留在队列上。
  expect(atRemoval).toEqual(['interrupted', 'interrupted']);
  // 前提：先起跑的是 A（否则上面那个「一跑一排」的盘面量的是别的东西）。
  expect(H.started[0]).toBe('run-A');
  const taskDir = path.join(H.taskDir, thread.id);
  expect(existsSync(taskDir)).toBe(false);

  // 迟到的落盘正是把目录写回来的那条路：放行工作体、再用服务自己的拆除等这条链排空。
  // 目录在链排空之后仍然不在 —— 删除那一刻队列已经空了，没有谁会再写它。
  release();
  await disposeXResearchThread(thread.id);
  expect(existsSync(taskDir)).toBe(false);
});
