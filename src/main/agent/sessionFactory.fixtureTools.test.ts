import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FixtureFile } from '../../../e2e/fixtures/fixture.types';

/**
 * `KYDOG_AGENT_FIXTURE` 那条路上的 `tool` 事件：**工具真的被执行了吗**。
 *
 * ## 为什么非要一条替身用例（而不是「e2e 已经守着了」）
 *
 * 这套机制的接线只有一处：`sessionFactory.ts` 把 `createBrowserTools()` 的返回值
 * 作为**第五个实参**交给 `createFixtureSession`。评审的 N1 把那个实参删掉之后：
 * `npx tsc --noEmit` 绿、`npm run lint` 绿、`npm test` **一条不红** —— 只有
 * `e2e/61-browser.spec.ts` 里那几条会红，而它们在发版流水线上被
 * `KYDOG_SKIP_LIVE_BROWSER=1` **整组跳过**（那一组要打真源，机房 IP 会被当机器人）。
 * 也就是说 `fixtureProvider` 的 `tool` 分支与这处接线在 CI 上**零覆盖**。
 *
 * 所以这里补的不是「同一件事的第二笔账」——CI 上那第一笔账是空的。
 *
 * ## 为什么工具是假的
 *
 * 这条用例要钉的是**接线**（交进去的那份清单到底有没有被用上、按名字找得到吗、
 * 找不到会不会静默变成「什么都没发生」），不是浏览器工具本身的行为 ——
 * 那由 `browserTools.test.ts` 与 e2e 各自守着。真的 `createBrowserTools()` 会把
 * `browserService`（`WebContentsView` / `session`）一路拖进单测进程，而它们要真的 Electron。
 */

const H = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; toolCallId: string; args: unknown; hasSignal: boolean }>,
  /** `createBrowserTools()` 的替身返回值。**每次调用返回同一个数组**，好让下面按引用比。 */
  tools: [] as Array<{ name: string; execute: unknown }>,
  builtCount: 0,
  settings: { ui: { locale: 'zh' }, institution: null as unknown },
}));

vi.mock('./browserTools', () => ({
  createBrowserTools: () => { H.builtCount += 1; return H.tools; },
}));

vi.mock('../settings/settingsService', () => ({
  settingsService: { get: async () => H.settings },
  toInstitutionPublic: () => null,
}));

vi.mock('../llm/providerRegistry', () => ({
  getProviderRegistry: () => ({ modelRuntime: { getModel: () => ({ id: 'm' }) } }),
}));

const { createSession } = await import('./sessionFactory');

const noopAskShared = { onOpened: () => {}, onClosed: () => {} };

/** 一个假工具：名字 + 一个把调用记下来的 `execute`（形状照 pi 的 customTool）。 */
function fakeTool(name: string) {
  return {
    name,
    async execute(toolCallId: string, args: unknown, signal?: AbortSignal) {
      H.calls.push({ name, toolCallId, args, hasSignal: signal instanceof AbortSignal });
      return { content: [{ type: 'text', text: `${name} 真的跑过了` }], details: { ok: true } };
    },
  };
}

type PiEvent = { type: string; [k: string]: unknown };

let dir = '';

/** 写一份剧本、建 session、跑一轮，把发出来的事件原样收回来。 */
async function run(file: FixtureFile): Promise<PiEvent[]> {
  const fixturePath = path.join(dir, `f-${H.builtCount}-${Math.random().toString(36).slice(2)}.json`);
  await fsp.writeFile(fixturePath, JSON.stringify(file));
  process.env.KYDOG_AGENT_FIXTURE = fixturePath;
  const session = await createSession({
    cwd: '/x', sessionId: 't1', sessionsDir: '/x/sessions',
    providerId: 'anthropic', modelId: 'claude',
    askShared: noopAskShared,
    currentRunId: () => 'run-1',
  });
  const events: PiEvent[] = [];
  session.subscribe((e) => events.push(e as PiEvent));
  await session.prompt('跑一次');
  return events;
}

/** 一次工具调用 + 收场，最小剧本。 */
function script(name: string, args: Record<string, unknown>): FixtureFile {
  return {
    events: [
      { after_ms: 0, type: 'tool', toolCallId: 'tc-1', name, args },
      { after_ms: 0, type: 'agent_end', reason: 'completed' },
    ],
  };
}

const endOf = (events: PiEvent[]) => events.find((e) => e.type === 'tool_execution_end');
const textOf = (e: PiEvent | undefined): string => {
  const content = (e?.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [];
  return content.map((c) => c.text ?? '').join('');
};

beforeEach(async () => {
  H.calls = [];
  H.builtCount = 0;
  H.tools = [fakeTool('browser_open'), fakeTool('browser_act'), fakeTool('browser_read'), fakeTool('browser_login')];
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kydog-fixt-'));
});

afterEach(async () => {
  delete process.env.KYDOG_AGENT_FIXTURE;
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('fixture 的 tool 事件真的执行 sessionFactory 交进来的那份工具', () => {
  it('按名字找到之后**真调** execute，参数原样、AbortSignal 也给了', async () => {
    const events = await run(script('browser_act', { tabId: 'tab_1', actions: [{ kind: 'scroll', direction: 'up' }] }));
    expect(H.calls, 'execute 一次都没被调到 —— 交给 createFixtureSession 的那份工具清单没接上'
      + `（sessionFactory 的第五个实参）。收到的事件：${events.map((e) => e.type).join(' / ')}`)
      .toHaveLength(1);
    expect(H.calls[0].name).toBe('browser_act');
    expect(H.calls[0].toolCallId, 'toolCallId 要原样传下去 —— 工具卡按它配对').toBe('tc-1');
    expect(H.calls[0].args, 'args 原样交给工具：模型给的参数长什么样，这里就长什么样')
      .toEqual({ tabId: 'tab_1', actions: [{ kind: 'scroll', direction: 'up' }] });
    // 一批 60 个动作的 browser_act 按了停止要停得住 —— fixture 那条路不许没有这个口子。
    expect(H.calls[0].hasSignal, 'execute 要拿到 AbortSignal，否则 fixture 下按停止停不住').toBe(true);
  });

  it('工具真实的返回值原样进 tool_execution_end，isError 是 false', async () => {
    const events = await run(script('browser_read', { tabId: 'tab_1' }));
    const end = endOf(events);
    expect(end, 'tool_execution_end 一条都没发出来').toBeTruthy();
    expect(end!.toolName).toBe('browser_read');
    expect(textOf(end)).toContain('browser_read 真的跑过了');
    expect(end!.isError).toBe(false);
    expect((end!.result as { details?: unknown }).details, 'details 也要带上（工具卡与后续判据要用）')
      .toEqual({ ok: true });
  });

  it('先 start 后 end，形态与真实 pi 一致（AgentService 靠 start 建工具卡）', async () => {
    const events = await run(script('browser_open', { url: 'https://example.com/' }));
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf('tool_execution_start'), 'tool_execution_start 必须在').toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('tool_execution_start')).toBeLessThan(kinds.indexOf('tool_execution_end'));
    const start = events.find((e) => e.type === 'tool_execution_start')!;
    expect(start.toolName).toBe('browser_open');
    expect(start.args).toEqual({ url: 'https://example.com/' });
  });

  /**
   * 名字打错时**不许**静默变成「这一步什么都没发生」—— 那样一条本该红的用例会绿，
   * 而红的时候没有任何东西说得出原因。诊断话术里要把「这条 session 上到底注册着什么」
   * 报出来：那份清单同时也是「第五个实参有没有接上」的直接证据。
   */
  it('名字打错：isError + 把实际注册着的名字都列出来', async () => {
    const events = await run(script('browser_akt', { tabId: 'tab_1' }));
    expect(H.calls, '名字对不上时一个工具都不该被执行').toHaveLength(0);
    const end = endOf(events);
    expect(end!.isError, '找不到的名字要按工具失败处理，不能静默跳过').toBe(true);
    const text = textOf(end);
    expect(text).toContain('browser_akt');
    for (const n of ['browser_open', 'browser_act', 'browser_read', 'browser_login']) {
      expect(text, `诊断里要列出真正注册着的名字（缺 ${n} 说明交进去的清单不全）`).toContain(n);
    }
  });

  it('工具自己抛异常：包成 isError 的结果，不把整轮 run 掀掉', async () => {
    H.tools = [{
      name: 'browser_act',
      async execute() { throw new Error('KYDOG测试用的爆炸'); },
    }];
    const events = await run(script('browser_act', { tabId: 'tab_1' }));
    const end = endOf(events);
    expect(end!.isError).toBe(true);
    expect(textOf(end)).toContain('KYDOG测试用的爆炸');
    expect(events.some((e) => e.type === 'agent_end'), '这一轮仍要正常收场').toBe(true);
  });

  /**
   * `createBrowserTools()` 只造**一次**，fixture 与 pi 两条路共用同一份。
   * 造两次的话 e2e 走到的就不是产品那一份 —— 而「测的不是用户拿到的东西」
   * 正是这条路要避开的。
   */
  it('一条 session 只造一次浏览器工具（两条路共用同一份）', async () => {
    await run(script('browser_act', { tabId: 'tab_1' }));
    expect(H.builtCount).toBe(1);
  });
});
