import path from 'node:path';
import * as paths from '../persist/paths';
import { createXResearchArtifactStore, createXResearchThreadArtifactStore, type XResearchArtifactStore } from '../x/xResearchArtifacts';
import { hydrateXResearchBranch } from '../x/xResearchBranch';
// src/main/agent/sessionFactory.ts
import { XResearchScopeLedger } from '../x/xResearchScopeFacts';
import { createFixtureSession } from './fixtureProvider';
import { createXResearchTools } from './xResearchTools';
import { XResearchEvidence } from '../x/xResearchEvidence';
import { createXResearchBrowser } from '../x/xResearchBrowser';
import { browserService } from '../browser/browserService';
import { createXResearchRunner } from '../x/xResearchRunner';
import { registerXResearchTaskService, XResearchTaskService } from '../x/xResearchTaskService';
import { XResearchTaskStore } from '../x/xResearchTaskStore';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { KydogError } from '../../shared/errors';
import { createAskUserQuestionTool, type AskSharedState } from './askUserQuestionTool';
import { createReadPdfFigureTool } from './readPdfFigureTool';
import { createReadDocxTool } from './readDocxTool';
import { createCharCountFileTools, type PiFileToolFactories } from './charCountFileTools';
import { createBrowserTools } from './browserTools';
import { createWebResearchTools } from './webResearchTools';
import { getWebResearchTaskService } from '../webResearch/service';
import type { Progress as ResearchProgress } from '../webResearch/researchRun';
import { getProviderRegistry } from '../llm/providerRegistry';
import { settingsService } from '../settings/settingsService';
import type { ProviderId } from '../../shared/types';

export type AnySession = {
  prompt: (
    content: string,
    options?: { images?: Array<{ type: 'image'; data: string; mimeType: string }> },
  ) => Promise<void>;
  abort: () => void | Promise<void>;
  subscribe: (listener: (event: { type: string; [k: string]: unknown }) => void) => () => void;
  cleanup?: () => Promise<void>;
  dispose?: () => void;
  readonly messages?: unknown[];
  readonly state?: { messages: unknown[] };
  /** pi AgentSession 的当前模型。`input` 是能不能收图的唯一依据（spec §3.6）。 */
  readonly model?: { readonly input?: readonly string[] };
};

/**
 * 「provider/model 已解析（配置里指向它），但当前 registry 里没有」——通常是上游把这个
 * 模型从目录里撤了。与泛化的 KydogError('llm.invalid', …) 分开成独立类型，是因为
 * 调用方（AgentService）要按**这一种**失败精确回退到「不建 session、直接读盘上的
 * transcript」，别的失败必须照旧抛出去（见 AgentService.loadHistory 的注释）。
 * 用 instanceof 判定，不靠 message 字符串——协议层事实应该是类型，不是文案。
 */
export class ModelUnavailableError extends Error {
  constructor(public readonly providerId: ProviderId, public readonly modelId: string) {
    super(`model not found: ${providerId}/${modelId}`);
    this.name = 'ModelUnavailableError';
  }
}

/** 这条 thread 此刻的活账本与它的落盘目录。任务 service 是**进程级**的（队列、在飞状态、
 *  `onUpdate` 都只有一份），而证据表 / 范围 prior / 当前轮都是 per-session 的 —— 所以工作体
 *  按 threadId 现取这一份，不把会话的东西塞进 service。 */
type XResearchSession = {
  evidence: XResearchEvidence;
  scopeFacts: XResearchScopeLedger;
  currentRunId: () => string | null;
  /** 改造前按会话落的工件根在那底下（`<sessionsDir>/<threadId>.x-research`）。 */
  sessionsDir: string;
};
const xResearchSessions = new Map<string, XResearchSession>();
let xResearchService: XResearchTaskService | null = null;

function xResearchSessionOf(threadId: string): XResearchSession {
  const session = xResearchSessions.get(threadId);
  // 会话没了还在跑的工作不猜也不糊：拿一份空账本跑完只会产出没有归属的观测。
  if (!session) throw new KydogError('research.not_found', `X research session ${threadId} is gone`);
  return session;
}

/** 一次研究的工件：写进这次研究的任务根；旧根只读，改造前的 ref 只认得它。 */
function xResearchArtifactsFor(threadId: string, researchRunId: string): XResearchArtifactStore {
  return createXResearchArtifactStore({
    task: path.join(paths.X_RESEARCH_DIR, threadId, researchRunId, 'artifact'),
    legacy: path.join(xResearchSessionOf(threadId).sessionsDir, `${threadId}.x-research`),
  });
}

/**
 * 进程里唯一那一个任务 service（R42）：**第一次建会话时懒构造一次**。
 *
 * 不在模块加载时构造：那样本进程一启动就得定下工件根与 store，而没有任何会话能告诉它
 * 每一条 thread 的 `sessionsDir`（旧工件根在那底下）。也不按 `xResearchEnabled` 决定注册不注册 ——
 * 工具由那个开关 gate，而「这个进程有没有任务队列」是另一件事：关开关不该让已经排上的
 * 工作失去归处（同一次会话里把开关关掉再开会新建 instance，访问器的守卫会直接报接线错误）。
 *
 * 建会话那一段是同步的（中间没有 await），所以两个并发会话不可能各造一个实例。
 */
function researchService(): XResearchTaskService {
  if (xResearchService) return xResearchService;
  const service = new XResearchTaskService({
    store: new XResearchTaskStore(paths.X_RESEARCH_DIR),
    runWork: createXResearchRunner({
      browserFor: (threadId) => createXResearchBrowser(browserService, threadId),
      contextFor: (threadId) => {
        const session = xResearchSessionOf(threadId);
        return {
          sources: session.evidence.sources,
          scopePrior: (runId) => session.scopeFacts.prior(runId),
          currentRunId: session.currentRunId,
        };
      },
      artifacts: xResearchArtifactsFor,
    }),
    artifacts: xResearchArtifactsFor,
    // R22：推出去的快照里带着活工作项对象，不拷贝的话 journal 里那一帧会跟着后续状态转移一起变。
    onUpdate: (snapshot) => broadcaster.emit('xResearch.taskUpdated', structuredClone(snapshot)),
  });
  xResearchService = service;
  registerXResearchTaskService(service);
  return service;
}

/** 这条 thread 此刻活账本的不透明身份：拆除路径用它区分「我那一份」与替换会话的账本。 */
export function xResearchSessionIdentity(threadId: string): object | undefined {
  return xResearchSessions.get(threadId);
}

/** 会话拆掉之后这条 thread 的活账本跟着丢（在飞研究已由 `disposeXResearchThread` 先收尾落盘）。
 *  不丢的话，之后任何一个走错路的调用会拿到一个没人再同步的账本。
 *  给了身份时只删那一份：拆除有多个 await，这个窗口里重新发布的替换会话会把同一个
 *  threadId 换成另一个账本对象 —— 旧会话不许把它删掉。 */
export function forgetXResearchSession(threadId: string, identity?: object): void {
  if (identity !== undefined && xResearchSessions.get(threadId) !== identity) return;
  xResearchSessions.delete(threadId);
}

/** 这条工具结果是不是**这一轮亲手交付**的那一份：是就返回它的配对身份。
 *  `undefined` = 这条结果没有可恢复的东西（submit / inspect / cancel 的壳，本来就没有结果）；
 *  `null` = 不是我们发的（要继续去磁盘恢复）。
 *
 *  配对键取壳里的 `submitCallId`，不取这条结果的 `toolCallId`：`delivery.result.callId` 是**提交**
 *  那一轮（`observeDelivery` 只拿得到它），而 `toolCallId` 是 `wait` 那一轮 —— 两者不是一个 id。 */
function liveDelivery(details: unknown): { submitCallId: string; batchId: string } | null | undefined {
  if (!details || typeof details !== 'object') return null;
  const value = details as {
    kind?: unknown;
    delivery?: { submitCallId?: unknown; result?: { batchId?: unknown } | null };
  };
  // 改造前的平铺结果不可能被这一轮追加（旧工具已删）：一律交给磁盘恢复。
  if (value.kind !== 'x_research') return null;
  if (!value.delivery) return undefined;
  const submitCallId = value.delivery.submitCallId;
  const batchId = value.delivery.result?.batchId;
  if (typeof submitCallId !== 'string' || typeof batchId !== 'string') return null;
  return { submitCallId, batchId };
}

export async function createSession(opts: {
  cwd: string;
  sessionId: string;
  sessionsDir: string;
  providerId: ProviderId;
  modelId: string;
  askShared: AskSharedState;
  /**
   * 这条 thread 此刻在为哪一轮 run 服务 —— 浏览器工具按轮记账用的戳（下载计数、机构登录的「本轮已填过一次」）；标签归属不读它，读 threadId。
   *
   * **由调用方注入一个取值函数，不是在这里 import `agentService`**：后者是一条
   * import 环（`AgentService` → `sessionFactory` → `AgentService`）。形态照
   * `askShared` —— 同样是 `AgentService` 造好了交进来的 run 上下文。
   *
   * **必须是函数不是值**：session 造出来那一刻还没有 run 在飞，取一次快照进去，
   * 之后每一轮的下载与登录都会记到同一个（空的）戳名下，按轮的上限与「本轮已填过」全部失效。
   *
   * 可选：fixture / 用例那条路不接浏览器，缺省当作「没有 run 在飞」。
   */
  currentRunId?: () => string | null;
  onResearchProgress?: (progress: ResearchProgress & { runId: string; toolCallId: string }) => void;
}): Promise<AnySession> {
  // locale 在这里（session 构造时）快照一次，理由与写法同下面 createKydogResourceLoader
  // 里的 disabledBuiltins：已开的 session 用的是开工那一刻的界面语言，之后用户在设置里
  // 切语言不会追着改正在跑的 session（spec §A.2）。ask_user_question 的回传文本要进
  // agent 上下文，必须跟这份快照走，不能各自现读 settings。
  const settings = await settingsService.get();
  const locale = settings.ui.locale;
  // `browser_login` 的 description 要拼进机构名与 entityID（裁决 7b）：不放的话
  // 模型不知道用户是哪所学校，写不出 CARSI 的登录 URL。**只取这两个公开字段** ——
  // 账号与密码一个字都不进模型上下文。陈旧问题（用户中途换学校）的处置见
  // `browserTools.ts` 的 `loginDesc`：判据一侧每次执行都重读设置，这份快照只影响
  // 「模型第一次往哪导」，而每次调用的返回值都会回显当前值。
  const inst = settings.institution;
  const institution = inst ? { name: inst.name, entityID: inst.entityID } : null;

  // 内置浏览器的六个工具。**造在分支之前，两条路用同一份** —— fixture 那条路要能
  // 真的执行它们（`fixtureProvider` 的 `tool` 事件，形态照 `ask`：那一条一直就是
  // 真调 `askUserQuestionTool.execute`）。造两次的话 e2e 走到的就不是产品那一份，
  // 而「测的不是用户拿到的东西」正是这条路要避开的。
  //
  // read / login / download 声明了 `executionMode: 'sequential'`；open / act 允许跨标签
  // 并行，同标签仍由 BrowserService 队列串行。sequential 名字要同步登记进
  // askSequentialTools.ts 的 SEQUENTIAL_TOOL_NAMES；守这条的是本文件的双向用例。
  //
  // `browser_login` 的确认框走的是**同一个** askShared / threadId：spec §4.6
  // 那道确认要用现成的 ask broker，不新发明挂起机制。
  const browserTools = createBrowserTools({
    currentRunId: opts.currentRunId ?? (() => null),
    cwd: opts.cwd,
    threadId: opts.sessionId,
    askShared: opts.askShared,
    institution,
  });
  const researchTools = createWebResearchTools({
    threadId: opts.sessionId,
    projectRoot: opts.cwd,
    currentRunId: opts.currentRunId ?? (() => null),
    service: getWebResearchTaskService(),
  });

  // pi remains an external ESM dependency; runtime tool factories use this import.
  const pi = await import('@earendil-works/pi-coding-agent');
  const sessionFile = `${opts.sessionsDir}/${opts.sessionId}.jsonl`;
  // Explicit session directory and project cwd also apply to the parameter-only fixture.
  const sessionManager = pi.SessionManager.open(sessionFile, opts.sessionsDir, opts.cwd);
  const currentRunId = opts.currentRunId ?? (() => null);
  const evidence = new XResearchEvidence(opts.cwd, currentRunId);
  const scopeFacts = new XResearchScopeLedger();
  let branchIds: string[] | undefined;
  // 进程级 service 按 threadId 现取这一份：证据表与范围 prior 属于会话，队列与在飞状态属于进程。
  // 它同时是会话身份：替换会话在同一个 threadId 上登记的永远是新对象。
  const ledger = { evidence, scopeFacts, currentRunId, sessionsDir: opts.sessionsDir };
  xResearchSessions.set(opts.sessionId, ledger);
  const service = researchService();
  // 恢复链读本 thread 任意一次研究的工件（任务根按 researchRunId 分叉，见那个工厂的注释）。
  const artifacts = createXResearchThreadArtifactStore({
    root: paths.X_RESEARCH_DIR, threadId: opts.sessionId,
    legacy: path.join(opts.sessionsDir, `${opts.sessionId}.x-research`),
  });
  const pendingResults = new Map<string,string>();
  let synchronization = Promise.resolve();
  // Serialize restore work. A branch can move while disk reads are pending:
  // publish only if its entire entry-ID sequence still equals the captured one.
  const syncBranch = (): Promise<void> => {
    const pending = synchronization.then(async () => {
      for (;;) {
        const branch = sessionManager.getBranch();
        const next = branch.map(entry => entry.id);
        if (branchIds && branchIds.every((id,index) => next[index] === id)) {
          const appended = branch.slice(branchIds.length).filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'x_research');
          const delivered = appended.map(entry => liveDelivery((entry as {message:{details?:unknown}}).message.details));
          // 只有这一轮亲手交付的那几份可以绕过磁盘恢复：账本已经按「生产」记过它们，重读一遍
          // 会把它们降级成历史。没有交付的壳（submit / inspect / cancel）没有可恢复的事实。
          const live = delivered.every(identity => identity === undefined
            || (identity !== null && pendingResults.get(identity.submitCallId) === identity.batchId));
          if (live) {
            for (const identity of delivered) if (identity) pendingResults.delete(identity.submitCallId);
            branchIds = next;
            return; // Only our immediate canonical observations may bypass disk restore.
          }
        }
        const hydrated = await hydrateXResearchBranch(branch, artifacts);
        const latest = sessionManager.getBranch().map(entry => entry.id);
        if (next.length !== latest.length || next.some((id,index) => latest[index] !== id)) continue;
        pendingResults.clear();
        evidence.restore(hydrated.entries);
        scopeFacts.restore(hydrated.entries);
        if (hydrated.failures.length) {
          // 恢复不了的工件在 `hydrateXResearchBranch` 返回的**副本**上标了 `restoration: missing` ——
          // 它不回写 transcript，模型看不到：账本凭这个标记挡住引用，模型只看到工具自己那份
          // `delivery` 事实。这里是它唯一的进程侧痕迹。
          const reasonCounts: Record<string, number> = {};
          for (const {reason} of hydrated.failures) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
          logger.warn('x_research', 'could not restore artifacts on this branch', { threadId: opts.sessionId, missingCalls: hydrated.failures.length, reasonCounts });
        }
        branchIds = next;
        return;
      }
    });
    synchronization = pending.catch(() => {});
    return pending;
  };
  await syncBranch();
  // Shared cwd-aware SDK read; PDF delegation preserves the explicit image resize policy.
  const readTool = pi.createReadToolDefinition(opts.cwd, { autoResizeImages: true });
  const customTools = [
    createAskUserQuestionTool(opts.sessionId, opts.askShared, locale),
    readTool,
    createReadPdfFigureTool({ readTool: readTool as never, cwd: opts.cwd }),
    createReadDocxTool({ cwd: opts.cwd }),
    // Same-name SDK overrides keep ordinary file semantics and full-content guarding.
    ...createCharCountFileTools(pi as unknown as PiFileToolFactories, opts.cwd, async (path, content) => {
      await syncBranch(); return evidence.guard(path, content);
    }),
    ...browserTools,
    ...researchTools,
    ...(settings.research?.xResearchEnabled === true ? [createXResearchTools({
      service, threadId: opts.sessionId, projectRoot: opts.cwd, currentRunId, ledger,
      // 交付即入账（spec §4.5「可引用 = 已交付」）：只有 `wait` 真把结果交出去时才会走到这里。
      // `pendingResults` 记的是「这一份是我亲手交的」：`syncBranch` 靠它绕过磁盘恢复。
      observeDelivery: result => {
        evidence.observe(result);
        scopeFacts.observe(result);
        pendingResults.set(result.callId, result.batchId);
      },
    })] : []),
  ];
  // SDK emits message_end before persisting it. Refresh only after prompt settles,
  // so branching away from the last result cannot leave an untracked live observation.
  const trackSettledBranch = <T extends AnySession>(session:T):T => {
    const prompt=session.prompt.bind(session);
    session.prompt=async (...args) => {await syncBranch();try{return await prompt(...args);}finally{await syncBranch();}};
    return session;
  };
  const fixturePath = process.env.KYDOG_AGENT_FIXTURE;
  if (fixturePath) return trackSettledBranch(await createFixtureSession(fixturePath, opts.askShared, opts.sessionId, locale,
    customTools, sessionManager));

  const reg = getProviderRegistry();
  const model = reg.modelRuntime.getModel(opts.providerId, opts.modelId);
  if (!model) {
    throw new ModelUnavailableError(opts.providerId, opts.modelId);
  }

  const { createKydogResourceLoader } = await import('../skills/skillResourceLoader');
  const resourceLoader = await createKydogResourceLoader(opts.cwd);
  // KyDog 是 SDK 嵌入方，不吸收项目本地的 pi 配置（.pi/settings.json、.pi/SYSTEM.md）。
  await resourceLoader.reload({ resolveProjectTrust: async () => false });
  const { session } = await (pi as any).createAgentSession({
    cwd: opts.cwd,
    sessionManager,
    modelRuntime: reg.modelRuntime,
    model,
    resourceLoader,
    customTools,
  });
  return trackSettledBranch(session as AnySession);
}
