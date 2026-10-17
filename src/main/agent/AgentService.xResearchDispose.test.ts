// 会话拆除与替换会话的交错（Task 9 评审 F2）：拆除有多个 await，替换会话可以在那段时间
// 发布。旧会话只许收走**自己**那一份账本与在飞研究，替换会话的账本与研究都必须留下。
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { searchInput } from '../../test-support/xResearchFixture';
import type { XResearchDeliveryEnvelope } from '../x/xResearchTaskShell';
import type { XResearchTaskSnapshot } from '../../shared/xResearchTask';
import { disposeXResearchThread, xResearchTaskService } from '../x/xResearchTaskService';
import { xResearchSessionIdentity } from './sessionFactory';

const H = vi.hoisted(() => ({
  taskDir: `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/kydog-x-dispose-${process.pid}-${Date.now()}`,
  production: [] as ToolDefinition[],
  /** 每一轮采集拿到的中止信号：runId → signal（两条提交分别用 run-A / run-B）。 */
  signals: new Map<string, AbortSignal>(),
  started: [] as string[],
}));
vi.mock('../persist/paths', async importOriginal => ({
  ...await importOriginal<typeof import('../persist/paths')>(),
  X_RESEARCH_DIR: H.taskDir,
}));
vi.mock('../settings/settingsService', () => ({
  settingsService: {
    get: async () => ({ ui: { locale: 'en' }, institution: null, research: { xResearchEnabled: true } }),
  },
  toInstitutionPublic: () => null,
}));
vi.mock('../browser/browserService', () => ({ browserService: { endRun: vi.fn() } }));
vi.mock('../browser/loginFlow', () => ({ loginFlow: { noteFor: () => null } }));
vi.mock('../x/xResearchBrowser', () => ({ createXResearchBrowser: () => ({}) }));
vi.mock('../llm/providerRegistry', () => ({
  getProviderRegistry: () => ({ modelRuntime: { getModel: () => ({ id: 'test' }) } }),
}));
vi.mock('../skills/skillResourceLoader', () => ({
  createKydogResourceLoader: async () => ({ reload: async () => {} }),
}));
vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
vi.mock('@earendil-works/pi-coding-agent', async original => ({
  ...await original<any>(),
  createAgentSession: async (o: any) => {
    H.production = o.customTools;
    return {
      session: {
        sessionManager: o.sessionManager, prompt: async () => {}, abort: () => {}, subscribe: () => () => {},
      },
    };
  },
}));
// 采集体换成可控替身：run-A 一直挂着直到被中止；run-B 立刻交付一份结果。
// 它照样先取 `contextFor`（生产 runner 的第一件事），于是「账本被删掉」会当场抛。
vi.mock('../x/xResearchRunner', async () => {
  const { searchResult } = await import('../x/xResearchSearch');
  return {
    createXResearchRunner: (deps: any) => async (work: any, ctx: any) => {
      const session = deps.contextFor(ctx.threadId);
      H.signals.set(ctx.runId, ctx.signal);
      H.started.push(ctx.runId);
      if (ctx.runId === 'run-A') {
        return new Promise((_resolve, reject) => {
          // 拆除可以落在「这一份已经算 running」与「采集体真正开始」之间：信号已经是中止态时
          // `addEventListener` 不会再响，替身必须当场收场（真实采集层读的就是这个状态）。
          if (ctx.signal.aborted) {
            reject(new Error('aborted by teardown'));
            return;
          }
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted by teardown')), { once: true });
        });
      }
      const result = searchResult(work, {
        browser: {} as never, threadId: ctx.threadId, sources: session.sources,
        runId: ctx.runId, callId: ctx.submitCallId, batchId: ctx.batchId,
      });
      result.status = 'partial';
      for (const row of result.queries) { row.status = 'partial'; row.stopReason = 'budget_reached'; }
      return result;
    },
  };
});
const { agentService } = await import('./AgentService');
const { createSession } = await import('./sessionFactory');

/** 真 thread id 的形状：任务 store 按 UUID 校验目录名。 */
const THREAD_ID = '11111111-1111-4111-8111-111111111111';
let dir: string;
let run: string;
beforeEach(() => {
  mkdirSync(H.taskDir, { recursive: true });
  dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-x-dispose-'));
  delete process.env.KYDOG_AGENT_FIXTURE;
  H.production = [];
  H.signals.clear();
  H.started = [];
  run = 'run-A';
  (agentService as any).sessions.clear();
  (agentService as any).runs.clear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => { rmSync(H.taskDir, { recursive: true, force: true }); });

async function build() {
  return createSession({
    cwd: dir, sessionsDir: path.join(dir, 'sessions'), sessionId: THREAD_ID,
    providerId: 'anthropic', modelId: 'test', askShared: { onOpened: () => {}, onClosed: () => {} },
    currentRunId: () => run,
  });
}

function researchTool(): ToolDefinition {
  const tool = H.production.filter(candidate => candidate.name === 'x_research').at(-1);
  if (!tool) throw new Error('x_research was not registered');
  return tool;
}

async function submit(tool: ToolDefinition, callId: string): Promise<XResearchDeliveryEnvelope> {
  const result = await tool.execute(callId, { action: 'submit', ...searchInput } as never,
    undefined, undefined, {} as never);
  return result.details as XResearchDeliveryEnvelope;
}

/** `AgentService.dispose` 只读这些字段；cleanup 是撑开 await 窗口的那道闸。 */
function bound(cleanup: () => Promise<void>, xResearchLedger?: object) {
  return {
    threadId: THREAD_ID, providerId: 'anthropic', modelId: 'test', cwd: dir,
    activeMessageId: null, askOpened: new Set(), askArgs: new Map(),
    researchToolCalls: new Set(), runJournal: [], runStartIndex: null, runId: null, xResearchLedger,
    session: { prompt: vi.fn(), abort: vi.fn(), subscribe: () => () => undefined, cleanup },
  };
}

it('keeps the replacement session ledger and its research when the old session tears down', async () => {
  // 会话 A：真实 createSession 登记账本 A；任务 service 在第一次建会话时懒构造一次。
  await build();
  const ledgerA = xResearchSessionIdentity(THREAD_ID);
  expect(ledgerA).toBeDefined();
  const aSubmit = await submit(researchTool(), 'a-submit');
  expect(xResearchTaskService()).not.toBeNull();

  // 拆除 A：cleanup 卡在闸上，dispose 已经解绑了 A 的 bound（detach before async cleanup）。
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  (agentService as any).sessions.set(THREAD_ID, bound(() => gate, ledgerA));
  const teardown = agentService.dispose(THREAD_ID);
  expect((agentService as any).sessions.has(THREAD_ID)).toBe(false);

  // 窗口里发布了替换会话 B（同一个 threadId，新账本对象），它提交了自己的研究。
  run = 'run-B';
  await build();
  const ledgerB = xResearchSessionIdentity(THREAD_ID);
  expect(ledgerB).toBeDefined();
  expect(ledgerB).not.toBe(ledgerA);
  (agentService as any).sessions.set(THREAD_ID, bound(async () => {}, ledgerB));
  const bSubmit = await submit(researchTool(), 'b-submit');

  release();
  await teardown;

  // A 的在飞研究照信号收尾成中断。
  expect(H.signals.get('run-A')?.aborted).toBe(true);
  expect((await xResearchTaskService()!.get(THREAD_ID, aSubmit.researchRunId)).counts)
    .toMatchObject({ interrupted: 1 });
  // 拆除只等自己那一份（F2），所以 B 的起跑要显式等到 —— 它仍必须发生。
  await vi.waitFor(() => expect(H.started).toContain('run-B'));
  await xResearchTaskService()!.whenIdle(THREAD_ID, bSubmit.researchRunId);
  // B 的研究真的起跑了（账本还在，contextFor 没抛），而且没被一起中止 —— 它交付完成。
  expect(H.signals.get('run-B')?.aborted).toBe(false);
  const bState: XResearchTaskSnapshot = await xResearchTaskService()!.get(THREAD_ID, bSubmit.researchRunId);
  expect(bState.counts).toMatchObject({ done: 1, running: 0, queued: 0, interrupted: 0 });
  // 替换会话的活账本是**同一个对象**，不是重新建出来的一份。
  expect(xResearchSessionIdentity(THREAD_ID)).toBe(ledgerB);
  // 收尾：B 这一份由它自己的身份带走（用例不让活账本跨用例残留）。
  await disposeXResearchThread(THREAD_ID, ledgerB);
});

it('still interrupts the research and drops the ledger when session cleanup rejects', async () => {
  await build();
  const submitted = await submit(researchTool(), 'a-submit');
  // 让这一份真的跑到采集层（而不是还排在队列上），否则下面断「被中止」只是断了个寂寞。
  await vi.waitFor(() => expect(H.started).toContain('run-A'));
  (agentService as any).sessions.set(THREAD_ID, bound(async () => { throw new Error('cleanup failed'); }, xResearchSessionIdentity(THREAD_ID)));

  await expect(agentService.dispose(THREAD_ID)).rejects.toThrow('cleanup failed');

  // cleanup 抛了也照样收尾：在飞的那一份停了，账本没有漏在内存里。
  expect(H.signals.get('run-A')?.aborted).toBe(true);
  expect(xResearchSessionIdentity(THREAD_ID)).toBeUndefined();
  // 盘上的结论是「中断」—— 下一次 `get` 从盘上读回同一个事实。
  expect((await xResearchTaskService()!.get(THREAD_ID, submitted.researchRunId)).counts)
    .toMatchObject({ interrupted: 1, running: 0 });
});

it('drains the thread chain when the dispose is part of a deletion', async () => {
  await build();
  const aSubmit = await submit(researchTool(), 'a-submit');
  await vi.waitFor(() => expect(H.started).toContain('run-A'));
  // 同一 thread 上另一个账本的研究（替换会话那一份）：排在 run-A 后面，尚在队列上。
  // 采集体的替身只在 `run-A` 上挂着等中止，所以这里也报 `run-A`（同一轮里的第二次提交本来就能共用）。
  const foreign = await xResearchTaskService()!.submit(
    { work: { search: searchInput.search } },
    { threadId: THREAD_ID, runId: 'run-A', projectRoot: dir, ledger: {} },
  );
  // 删对话：lifetime 先进入 deleting，于是 dispose 走**不带账本**的那一条（整条链要排空）——
  // 目录随后就被 `removeThread` 删掉，迟到的落盘会把一条已经不存在的研究写回来。
  (agentService as any).sessions.set(THREAD_ID, bound(async () => {}, xResearchSessionIdentity(THREAD_ID)));
  const deletion = agentService.beginThreadDeletion([THREAD_ID]);
  try {
    await agentService.dispose(THREAD_ID);
  } finally {
    deletion.finish();
  }
  // 整条 thread 都在删：不属于本次会话账本的那一份也被收走（走的是不带账本那一条）。
  expect(H.signals.get('run-A')?.aborted).toBe(true);
  expect((await xResearchTaskService()!.get(THREAD_ID, foreign.researchRunId)).counts)
    .toMatchObject({ interrupted: 1, done: 0, queued: 0, running: 0 });
  expect((await xResearchTaskService()!.get(THREAD_ID, aSubmit.researchRunId)).counts)
    .toMatchObject({ interrupted: 1, running: 0 });
});
