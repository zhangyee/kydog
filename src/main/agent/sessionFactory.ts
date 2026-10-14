// src/main/agent/sessionFactory.ts
import { XResearchScopeLedger } from '../x/xResearchScopeFacts';
import { createFixtureSession } from './fixtureProvider';
import { createXResearchTool } from './xResearchTool';
import { XResearchEvidence, latestXResearchTab } from '../x/xResearchEvidence';
import { createXResearchBrowser } from '../x/xResearchBrowser';
import { browserService } from '../browser/browserService';
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
  let retainedTab: string | undefined;
  // Ordinary appends retain the immediate production observations. A real branch
  // change rebuilds exclusively from getBranch(), including through compaction.
  const syncBranch = () => {
    const branch = sessionManager.getBranch();
    const next = branch.map(entry => entry.id);
    if (!branchIds || !branchIds.every((id,index) => next[index]===id)) {
      evidence.restore(branch);
      scopeFacts.restore(branch);
      retainedTab=latestXResearchTab(branch);
    }
    branchIds = next;
  };
  syncBranch();
  // Shared cwd-aware SDK read; PDF delegation preserves the explicit image resize policy.
  const readTool = pi.createReadToolDefinition(opts.cwd, { autoResizeImages: true });
  const customTools = [
    createAskUserQuestionTool(opts.sessionId, opts.askShared, locale),
    readTool,
    createReadPdfFigureTool({ readTool: readTool as never, cwd: opts.cwd }),
    createReadDocxTool({ cwd: opts.cwd }),
    // Same-name SDK overrides keep ordinary file semantics and full-content guarding.
    ...createCharCountFileTools(pi as unknown as PiFileToolFactories, opts.cwd, (path, content) => {
      syncBranch(); return evidence.guard(path, content);
    }),
    ...browserTools,
    ...researchTools,
    ...(settings.research?.xResearchEnabled === true ? [createXResearchTool({
      browser: createXResearchBrowser(browserService, opts.sessionId),
      threadId: opts.sessionId, sources: evidence.sources, currentRunId: () => {syncBranch();return currentRunId();},
      tabBinding:{get:()=>retainedTab,set:id=>{retainedTab=id;}},
      scopePrior: runId => scopeFacts.prior(runId),
      observeResult: result => { evidence.observe(result); scopeFacts.observe(result); },
    })] : []),
  ];
  // SDK emits message_end before persisting it. Refresh only after prompt settles,
  // so branching away from the last result cannot leave an untracked live observation.
  const trackSettledBranch = <T extends AnySession>(session:T):T => {
    const prompt=session.prompt.bind(session);
    session.prompt=async (...args) => {try{return await prompt(...args);}finally{syncBranch();}};
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
