// src/main/agent/sessionFactory.ts
import { createFixtureSession } from './fixtureProvider';
import { createAskUserQuestionTool, type AskSharedState } from './askUserQuestionTool';
import { createReadPdfFigureTool } from './readPdfFigureTool';
import { createReadDocxTool } from './readDocxTool';
import { createCharCountFileTools, type PiFileToolFactories } from './charCountFileTools';
import { createBrowserTools } from './browserTools';
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

  // 内置浏览器的四个工具。**造在分支之前，两条路用同一份** —— fixture 那条路要能
  // 真的执行它们（`fixtureProvider` 的 `tool` 事件，形态照 `ask`：那一条一直就是
  // 真调 `askUserQuestionTool.execute`）。造两次的话 e2e 走到的就不是产品那一份，
  // 而「测的不是用户拿到的东西」正是这条路要避开的。
  //
  // 四个都声明了 `executionMode: 'sequential'`，名字要同步登记进
  // askSequentialTools.ts 的 SEQUENTIAL_TOOL_NAMES —— 漏登记不报错，
  // 只会让 UI 把一次串行批次画成并行组。守这条的是本文件的用例（两个方向）。
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

  const fixturePath = process.env.KYDOG_AGENT_FIXTURE;
  // sessionId 就是 threadId，fixture 里的工具必须用它注册 broker，
  // 否则 renderer 发来的 ask.submit / ask.cancel 会因 threadId 对不上被丢弃。
  if (fixturePath) {
    return createFixtureSession(fixturePath, opts.askShared, opts.sessionId, locale, browserTools);
  }

  const pi = await import('@earendil-works/pi-coding-agent');
  const reg = getProviderRegistry();
  const model = reg.modelRuntime.getModel(opts.providerId, opts.modelId);
  if (!model) {
    throw new ModelUnavailableError(opts.providerId, opts.modelId);
  }

  const { createKydogResourceLoader } = await import('../skills/skillResourceLoader');
  const resourceLoader = await createKydogResourceLoader(opts.cwd);
  // KyDog 是 SDK 嵌入方，不吸收项目本地的 pi 配置（.pi/settings.json、.pi/SYSTEM.md）。
  await resourceLoader.reload({ resolveProjectTrust: async () => false });
  const sessionFile = `${opts.sessionsDir}/${opts.sessionId}.jsonl`;
  const { session } = await (pi as any).createAgentSession({
    cwd: opts.cwd,
    // 第三个参数是 cwd：不给的话新文件的头取 process.cwd()（从 Finder 启动的打包版是 `/`），
    // 旧文件取头里记的值。给了则两种都以项目目录为准；旧文件头里的 `/` 不改写。
    sessionManager: (pi as any).SessionManager.open(sessionFile, undefined, opts.cwd),
    modelRuntime: reg.modelRuntime,
    model,
    resourceLoader,
    customTools: [
      createAskUserQuestionTool(opts.sessionId, opts.askShared, locale),
      // read 定义在这里构造、注入进去，而不是在工具文件里 import：pi 在 vite.main.config.ts
      // 里是 external、main 打成 CJS，所以 pi 的一切运行时引用都必须走上面那个动态 import()。
      // autoResizeImages 显式给 true，不跟随 pi 的 settings（那个开关在 pi 的 settingsManager
      // 里、KyDog 没有暴露）：渲染页的像素上限是 2400 万，不 resize 会把请求撑爆。
      // 这份 read 定义只用于工具内部委托，不注册成一个对模型可见的工具。
      // cwd 传进去：spec §2.3/§3.3 里项目内附件走的是相对路径，两个工具据此把它补成
      // 绝对路径再校验（relpath-brief.md）。补全只做字符串拼接、不 normalize，
      // `..` 段的检查不受影响，见 resolveAgainstCwd.ts。
      createReadPdfFigureTool({
        readTool: (pi as any).createReadToolDefinition(opts.cwd, { autoResizeImages: true }),
        cwd: opts.cwd,
      }),
      createReadDocxTool({ cwd: opts.cwd }),
      // 同名覆盖 pi 内置的 write / edit：行为不变，写完多报一行字数（见 charCountFileTools.ts）。
      // pi 的注册表先放内置、再按名字放 customTools，同名的后者胜出。
      ...createCharCountFileTools(pi as unknown as PiFileToolFactories, opts.cwd),
      // 内置浏览器的四个工具（上面造好的**同一份**，见那段注释）。
      ...browserTools,
    ],
  });
  return session as AnySession;
}
