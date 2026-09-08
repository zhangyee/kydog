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
  settingsService: { get: async () => ({ ui: { locale: 'zh' } }) },
}));

// createBrowserTools 会 import 它，而它 import 的是 electron 的 WebContentsView / session。
vi.mock('../browser/browserService', () => ({ browserService: {} }));

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
});

describe('customTools 里有三个浏览器工具', () => {
  it('browser_open / browser_act / browser_read 三个都在', async () => {
    const names = (await build()).map((t) => t.name);
    expect(names).toContain('browser_open');
    expect(names).toContain('browser_act');
    expect(names).toContain('browser_read');
  });

  it('本来就有的那个提问工具没被挤掉', async () => {
    expect((await build()).map((t) => t.name)).toContain(ASK_TOOL_NAME);
  });

  it('三个都声明了 sequential —— 网页是有状态的，并行跑等于互相踩', async () => {
    const browser = (await build()).filter((t) => t.name?.startsWith('browser_'));
    expect(browser).toHaveLength(3);
    for (const t of browser) expect(t.executionMode).toBe('sequential');
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
