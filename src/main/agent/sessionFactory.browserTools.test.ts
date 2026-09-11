import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ASK_TOOL_NAME } from '../../shared/askQuestion';
import { SEQUENTIAL_TOOL_NAMES } from './askSequentialTools';

/**
 * 浏览器工具真的进了 pi 的 `customTools` 吗？
 *
 * 这一层**没有任何别的东西会在它掉线时报错**：`createBrowserTools` 有自己的用例、
 * `browserService` 有自己的用例，可只要没人把前者塞进 `createAgentSession`，
 * 模型就一个浏览器工具都看不见 —— 编译过、lint 过、其余用例全绿，
 * 现象只是「agent 说它不会上网」。所以这里替身掉 pi，把交出去的那份
 * `customTools` 原样截下来看。
 */
/** pi 那份 customTools 里我们要看的字段。工具定义本身的形状由 pi 决定，这里只挑用得上的。 */
type Tool = {
  name?: string;
  executionMode?: string;
  description?: string;
  parameters?: unknown;
  execute?: unknown;
};

const H = vi.hoisted(() => ({
  captured: null as { customTools?: Tool[] } | null,
  runIdCalls: 0,
  currentRunId: null as string | null,
  settings: { ui: { locale: 'zh' }, institution: null } as {
    ui: { locale: string };
    institution: { name: string; entityID: string; username: string } | null;
  },
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async (opts: Record<string, unknown>) => {
    H.captured = opts as never;
    return { session: { prompt: async () => {}, abort: () => {}, subscribe: () => () => {} } };
  },
  SessionManager: { open: () => ({}) },
  createReadToolDefinition: () => ({ name: 'read' }),
}));

vi.mock('../skills/skillResourceLoader', () => ({
  createKydogResourceLoader: async () => ({ reload: async () => {} }),
}));

vi.mock('../llm/providerRegistry', () => ({
  getProviderRegistry: () => ({
    modelRuntime: { getModel: () => ({ id: 'm' }) },
  }),
}));

vi.mock('../settings/settingsService', () => ({
  settingsService: { get: async () => H.settings },
  toInstitutionPublic: () => null,
}));

// createBrowserTools 会 import 它，而它 import 的是 electron 的 WebContentsView / session。
vi.mock('../browser/browserService', () => ({ browserService: {} }));
// 同理：loginFlow 的单例要 webRequestHub（electron session）与 institutionService（safeStorage）。
vi.mock('../browser/loginFlow', () => ({ loginFlow: { noteFor: () => null } }));

const { createSession } = await import('./sessionFactory');

const noopAskShared = { onOpened: () => {}, onClosed: () => {} };

/** 清在一个单独的函数里：写成 `H.captured = null` 会让 TS 把它一路窄成 `null`。 */
function resetCaptured(): void {
  H.captured = null;
  H.runIdCalls = 0;
}

async function build(): Promise<Tool[]> {
  resetCaptured();
  await createSession({
    cwd: '/x', sessionId: 't1', sessionsDir: '/x/sessions',
    providerId: 'anthropic', modelId: 'claude',
    askShared: noopAskShared,
    currentRunId: () => { H.runIdCalls += 1; return H.currentRunId; },
  });
  return H.captured?.customTools ?? [];
}

beforeEach(() => {
  delete process.env.KYDOG_AGENT_FIXTURE;
  H.currentRunId = 'run-1';
  H.settings = { ui: { locale: 'zh' }, institution: null };
});

describe('customTools 里有五个浏览器工具', () => {
  it('browser_open / browser_tabs / browser_act / browser_read / browser_login 五个都在', async () => {
    const names = (await build()).map((t) => t.name);
    expect(names).toContain('browser_open');
    expect(names).toContain('browser_tabs');
    expect(names).toContain('browser_act');
    expect(names).toContain('browser_read');
    expect(names).toContain('browser_login');
  });

  it('本来就有的那个提问工具没被挤掉', async () => {
    expect((await build()).map((t) => t.name)).toContain(ASK_TOOL_NAME);
  });

  it('碰页面的四个都声明了 sequential —— 网页是有状态的，并行跑等于互相踩', async () => {
    const browser = (await build()).filter((t) => t.name?.startsWith('browser_'));
    expect(browser).toHaveLength(5);
    const seq = browser.filter((t) => t.executionMode === 'sequential').map((t) => t.name);
    expect(seq.sort()).toEqual(['browser_act', 'browser_login', 'browser_open', 'browser_read']);
  });

  /**
   * `browser_tabs` 只读 `browserService.getState()`，不进队列也不碰页面。
   * 声明成 sequential 会把它排进 UI 的串行批次，白白让一次纯查询挡住别的工具；
   * 而声明了却不登记进 SEQUENTIAL_TOOL_NAMES 则会让 UI 把串行批次画成并行组。
   */
  it('browser_tabs 不是 sequential，也不在那份名单里', async () => {
    const t = (await build()).find((x) => x.name === 'browser_tabs');
    // **正向前置**：不先钉住「确实找到了」，下面两条在工具改名时会一起假绿 ——
    // `.find()` 回 undefined，可选链让 `t?.executionMode` 仍然是 undefined。
    expect(t?.name).toBe('browser_tabs');
    expect(t?.executionMode).toBeUndefined();
    expect(SEQUENTIAL_TOOL_NAMES.has('browser_tabs')).toBe(false);
  });
});

/**
 * 裁决 7b：`browser_login` 的 description 里要有**机构名与 entityID**。
 *
 * 不放的话模型压根不知道用户是哪所学校，Task 9 的 skill 写不出 CARSI 的登录 URL ——
 * 而这条接线掉了**不会有任何别的东西报错**：工具照样注册、照样能调、只是模型永远
 * 导不到正确的登录页。所以这里从**真正交给 pi 的那份** customTools 上断。
 *
 * 另一半同样要守：**账号与密码一个字都不许进 description**。
 */
describe('browser_login 的 description 带着机构名与 entityID（且只带这两个）', () => {
  const descOf = async (): Promise<string> =>
    (await build()).find((t) => t.name === 'browser_login')?.description ?? '';

  it('配了机构：机构名与 entityID 都在里面', async () => {
    H.settings = {
      ui: { locale: 'zh' },
      institution: { name: '北京大学', entityID: 'https://iaaa.pku.edu.cn/idp/shibboleth', username: '2100011000' },
    };
    const d = await descOf();
    expect(d).toContain('北京大学');
    expect(d).toContain('https://iaaa.pku.edu.cn/idp/shibboleth');
  });

  it('账号绝不进 description —— 它是用户数据，不是公开标识符', async () => {
    H.settings = {
      ui: { locale: 'zh' },
      institution: { name: '北京大学', entityID: 'https://iaaa.pku.edu.cn/idp/shibboleth', username: '2100011000' },
    };
    expect(await descOf()).not.toContain('2100011000');
  });

  it('没配机构时说清「还没配」，而不是留一句空的「当前配置的机构：」', async () => {
    const d = await descOf();
    expect(d).toContain('还没有配置机构账号');
  });

  /**
   * description 是**建会话那一刻**拼的，用户中途换学校它就旧了。这里钉住的是
   * 「我们把这件事写出来了」—— 处置是让模型以每次调用返回值里回显的当前值为准
   * （判据一侧从来不用这份快照，`loginFlow` 每次执行都重读设置）。
   */
  it('明说这是会话开始时的快照、以返回值回显的为准', async () => {
    H.settings = {
      ui: { locale: 'zh' },
      institution: { name: '清华大学', entityID: 'https://id.tsinghua.edu.cn/idp', username: 'u1' },
    };
    const d = await descOf();
    expect(d).toContain('快照');
    expect(d).toMatch(/回显当前的机构名与 entityID/);
  });
});

/**
 * run 上下文靠**闭包注入**（照 `askShared` 的现成形态由 `AgentService` 传进来），
 * 不是在 `sessionFactory` 里 import `agentService` —— 后者是一条 import 环
 * （`AgentService` → `sessionFactory` → `AgentService`）。
 *
 * 注入的是**取值函数不是值**：session 造出来那一刻还没有任何 run 在飞，
 * 传一个当场取到的值进去，之后每一轮 run 开的标签都会盖上同一个（或空的）戳。
 */
describe('runId 是取值函数，不是造 session 那一刻的快照', () => {
  it('造 session 的过程中一次都不去取 runId', async () => {
    await build();
    expect(H.runIdCalls).toBe(0);
  });

  it('工具描述与 schema 都建起来了（不是塞了三个空壳）', async () => {
    const open = (await build()).find((t) => t.name === 'browser_open') as
      { description?: string; parameters?: unknown; execute?: unknown } | undefined;
    expect(typeof open?.description).toBe('string');
    expect(open?.description?.length).toBeGreaterThan(0);
    expect(open?.parameters).toBeTruthy();
    expect(typeof open?.execute).toBe('function');
  });
});

/**
 * `SEQUENTIAL_TOOL_NAMES` 是 UI 判「这一批是不是并行组」的唯一依据
 * （`isParallelBatch`）。漏登记一个，一次串行批次会被画成并行组 —— 不报错。
 * **两个方向都守**，与 templates.test.ts 那条同一个手法。
 */
describe('sequential 工具名单与实际注册的工具对得上', () => {
  it('每个声明了 sequential 的工具都登记在名单里', async () => {
    const missing = (await build())
      .filter((t) => t.executionMode === 'sequential')
      .map((t) => t.name ?? '')
      .filter((n) => !SEQUENTIAL_TOOL_NAMES.has(n));
    expect(missing).toEqual([]);
  });

  it('名单里的每个名字都真的注册着，且真的是 sequential —— 名单不许烂在库里', async () => {
    const tools = await build();
    const byName = new Map(tools.map((t) => [t.name ?? '', t]));
    const stale = [...SEQUENTIAL_TOOL_NAMES].filter(
      (n) => byName.get(n)?.executionMode !== 'sequential',
    );
    expect(stale).toEqual([]);
  });
});
