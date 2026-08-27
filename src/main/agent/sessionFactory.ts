// src/main/agent/sessionFactory.ts
import { createFixtureSession } from './fixtureProvider';
import { createAskUserQuestionTool, type AskSharedState } from './askUserQuestionTool';
import { createPdfFigureTool } from './pdfFigureTool';
import { getProviderRegistry } from '../llm/providerRegistry';
import { settingsService } from '../settings/settingsService';
import { KydogError } from '../../shared/errors';
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
    throw new KydogError('llm.invalid', `model not found: ${opts.providerId}/${opts.modelId}`);
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
      createPdfFigureTool(),
    ],
  });
  return session as AnySession;
}
