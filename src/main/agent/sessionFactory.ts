// src/main/agent/sessionFactory.ts
import { createFixtureSession } from './fixtureProvider';
import { createAskUserQuestionTool, type AskSharedState } from './askUserQuestionTool';
import { createReadPdfFigureTool } from './readPdfFigureTool';
import { createReadDocxTool } from './readDocxTool';
import { getProviderRegistry } from '../llm/providerRegistry';
import { settingsService } from '../settings/settingsService';
import type { ProviderId } from '../../shared/types';

export type AnySession = {
  prompt: (content: string) => Promise<void>;
  abort: () => void | Promise<void>;
  subscribe: (listener: (event: { type: string; [k: string]: unknown }) => void) => () => void;
  cleanup?: () => Promise<void>;
  dispose?: () => void;
  readonly messages?: unknown[];
  readonly state?: { messages: unknown[] };
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
}): Promise<AnySession> {
  // locale 在这里（session 构造时）快照一次，理由与写法同下面 createKydogResourceLoader
  // 里的 disabledBuiltins：已开的 session 用的是开工那一刻的界面语言，之后用户在设置里
  // 切语言不会追着改正在跑的 session（spec §A.2）。ask_user_question 的回传文本要进
  // agent 上下文，必须跟这份快照走，不能各自现读 settings。
  const locale = (await settingsService.get()).ui.locale;

  const fixturePath = process.env.KYDOG_AGENT_FIXTURE;
  // sessionId 就是 threadId，fixture 里的工具必须用它注册 broker，
  // 否则 renderer 发来的 ask.submit / ask.cancel 会因 threadId 对不上被丢弃。
  if (fixturePath) return createFixtureSession(fixturePath, opts.askShared, opts.sessionId, locale);

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
    sessionManager: (pi as any).SessionManager.open(sessionFile),
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
      createReadPdfFigureTool({
        readTool: (pi as any).createReadToolDefinition(opts.cwd, { autoResizeImages: true }),
      }),
      createReadDocxTool(),
    ],
  });
  return session as AnySession;
}
