import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));

import { broadcaster } from '../ipc/broadcaster';
import { agentService } from './AgentService';
import { PAGE_CONTENT_OPEN, PAGE_CONTENT_CLOSE } from '../browser/snapshot';

type Listener = (evt: { type: string; [k: string]: unknown }) => void;

/** 与 AgentService.parallel.test.ts 同一个假 session 形态：直接往私有 map 里塞 bound。 */
function attach(threadId: string) {
  let listener: Listener = () => undefined;
  const bound = {
    threadId, providerId: 'anthropic', modelId: 'm', cwd: '/x',
    activeMessageId: `${threadId}:msg`,
    askOpened: new Set<string>(),
    askArgs: new Map<string, { toolName: string; args: unknown }>(),
    runJournal: [],
    runStartIndex: null,
    session: {
      prompt: vi.fn(), abort: vi.fn(), dispose: vi.fn(),
      subscribe: (l: Listener) => { listener = l; return () => undefined; },
    },
  };
  (agentService as any).sessions.set(threadId, bound);
  (agentService as any).runs.set(threadId, { status: 'running', runId: 'r1', abortRequested: false });
  (agentService as any).subscribe(bound);
  return { fire: (evt: { type: string; [k: string]: unknown }) => listener(evt) };
}

const chunksOf = (): Array<Record<string, unknown>> =>
  (broadcaster.emit as unknown as { mock: { calls: Array<[string, Record<string, unknown>]> } })
    .mock.calls.filter(([t]) => t === 'run.tool_call_chunk').map(([, p]) => p);

/**
 * **工具结果送往渲染层的路上一个字都不许少**（从 `e2e/61-browser` 的 E-1b 下界那条挪下来）。
 *
 * 那条 e2e 的上界守的是「整批预算把结果压住了」（`browserTools.test.ts` 已有单测）；
 * 下界守的是另一件事：评审 N6 实测把 `extractToolResultText` 的 `.join('')` 改成
 * `.join('').slice(0, 5000)`，三条 gate 全绿 —— 「预算把结果压住了」与「结果在路上被
 * 压住了」长得一模一样，而后者对模型的后果正是 E-1b 要挡的：收到的比实际抽到的少，且看不出来。
 *
 * 夹具照真的 `browser_act` 结果的形状摆（`browserTools.ts` 的 `text()`：一个 text 块）：
 * 头部 → 数据块（~6 万字符的 JSON）→ 收尾标记 → 「页面变化」那一段。收尾标记与它后面那一段
 * 排在大块 JSON **之后**，截成前缀的话最先丢的就是它们。
 */
describe('AgentService：大块工具结果原样进 run.tool_call_chunk', () => {
  beforeEach(() => {
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
    (broadcaster.emit as any).mockClear();
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('约 6 万字符的 browser_act 结果：chunk 与原文逐字相同，收尾标记与「页面变化」都在', () => {
    const rows = Array.from({ length: 59 }, () => ({ blob: 'K'.repeat(1000) }));
    const text = [
      '抽到 59 条。',
      PAGE_CONTENT_OPEN,
      JSON.stringify(rows, null, 1),
      PAGE_CONTENT_CLOSE,
      '── 页面变化',
      '（没有变化）',
    ].join('\n');
    // 前提：夹具真有这么大 —— 比 N6 那一刀的 5000 大一个数量级，比 E-1b 的下界 45000 还大。
    expect(text.length).toBeGreaterThan(60_000);

    const { fire } = attach('t1');
    fire({ type: 'tool_execution_start', toolCallId: 'tc-budget', toolName: 'browser_act', args: { tabId: 'tab_1' } });
    fire({
      type: 'tool_execution_end', toolCallId: 'tc-budget', toolName: 'browser_act',
      isError: false, result: { content: [{ type: 'text', text }] },
    });

    const chunks = chunksOf();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ toolCallId: 'tc-budget', stream: 'stdout' });
    const got = chunks[0].chunk as string;
    // 先比长度、再比尾巴、最后逐字比：6 万字符的 toBe 失败时 diff 读不了，前两条先把话说清楚。
    expect(got.length).toBe(text.length);
    expect(got.slice(got.lastIndexOf(PAGE_CONTENT_CLOSE))).toContain('── 页面变化');
    expect(got === text).toBe(true);
  });
});
