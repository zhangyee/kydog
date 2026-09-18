import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere, type MiniElement, type Mounted } from '../../../test-support/miniReact';
import type { AssistantBlock } from '../../../shared/types';

/**
 * **并行工具组**（`e2e/14-tool-group` 与 `e2e/63-running-tool-command` 第二条挪下来的那一半）。
 *
 * `ToolGroup` 的每一行是它自己画的 `<div>`，不是子组件 —— 所以 miniReact 在这里看得到
 * 行内的一切：展开按钮、命令、占位字样、输出。`ProcessGroup` 那一组看的是更外一层：
 * 三路并行确实被认成一个 `ToolGroup`，跑完默认收起，以及 key 不随状态变。
 *
 * 守不住的：真布局（折叠之后是不是真的看不见）、`ToolGroup` 在 `ProcessGroup` 里的
 * 内部渲染（子组件不展开）。占位字样照字面写，理由同 `ToolCard.test.tsx`。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 只把 React 订阅那一层换成直读，getState / setState 用真身（同 narrowMode.test.tsx）。
vi.mock('../../stores/runsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/runsStore')>();
  const real = mod.useRunsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useRunsStore: hook };
});

const { ToolGroup } = await import('./ToolGroup');
const { ToolCard } = await import('./ToolCard');
const { ProcessGroup } = await import('./ProcessGroup');
const { useRunsStore } = await import('../../stores/runsStore');

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

const PLACEHOLDER = '运行中，结果回来后显示在这里';
const SLOW = "fastpaper search biorxiv 'cry for help' --after 2025-06-01 -n 8";
const PUBMED = `fastpaper search pubmed '"cry for help" AND rhizosphere' -n 10`;

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

const tool = (id: string, patch: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool_call', id, name: 'bash', command: `fastpaper search ${id} x`,
  chunks: [{ stream: 'stdout', data: `${id} hit\n` }], status: 'ok', exitCode: 0,
  parallelGroupId: 'g1', ...patch,
});

const click = (el: MiniElement): void => { (el.props.onClick as () => void)(); };

beforeEach(() => {
  useRunsStore.setState(useRunsStore.getInitialState());
});

describe('ToolGroup：三路并行的表头与折叠', () => {
  it('表头「PARALLEL · 3」「fastpaper ×3」「全部完成」；默认收起，展开后三行都在', () => {
    const ids = ['tc-arxiv', 'tc-s2', 'tc-pubmed'];
    const m = mount(ToolGroup, { tools: ids.map((id) => tool(id)) });
    const header = textOf(m.find('tool-group-toggle-tc-arxiv'));
    expect(header).toContain('PARALLEL · 3');
    expect(header).toContain('fastpaper ×3');
    expect(header).toContain('全部完成');
    expect(textOf(m.find('tool-group-toggle-tc-arxiv'))).toContain('展开');

    // 默认收起：三行一行都不在树上
    expect(ids.map((id) => m.query(`tool-${id}`))).toEqual([null, null, null]);

    click(m.find('tool-group-toggle-tc-arxiv'));
    // 展开之后三行都在（也证明上面那条 null 不是查找坏了）
    for (const id of ids) expect(m.query(`tool-${id}`)).not.toBeNull();
    expect(textOf(m.find('tool-group-toggle-tc-arxiv'))).toContain('收起');
  });
});

/**
 * `e2e/63` 第二条：一条跑完、一条还在跑。还在跑的那一行也能展开看命令，跑完的那一行
 * 照常看输出；慢的那一行以失败结束时，错误输出补进同一行。
 */
describe('ToolGroup：组里还在跑的那一行也能展开', () => {
  it('跑着的行：可点、展开见命令与占位；跑完的行：命令与输出、无占位；慢的那行失败后 stderr 补进同一行', () => {
    const done = tool('tc-pubmed', {
      command: PUBMED, chunks: [{ stream: 'stdout', data: '[42346365] Screening of Cry for Help signals\n' }],
    });
    const slow = tool('tc-biorxiv', { command: SLOW, status: 'running', exitCode: undefined, chunks: [] });
    const m: Mounted<{ tools: ToolBlock[] }> = mount(ToolGroup, { tools: [done, slow] });

    // 前提：一条跑完、一条还在跑
    expect(textOf(m.find('tool-group-toggle-tc-pubmed'))).toContain('运行中 1 · 完成 1');
    click(m.find('tool-group-toggle-tc-pubmed'));

    const slowToggle = () => m.find('tool-toggle-tc-biorxiv');
    const doneToggle = () => m.find('tool-toggle-tc-pubmed');
    const slowRow = () => textOf(m.find('tool-tc-biorxiv'));
    const doneRow = () => textOf(m.find('tool-tc-pubmed'));

    expect(textOf(slowToggle())).toContain('运行中');
    expect(slowToggle().props.disabled).toBe(false);
    click(slowToggle());
    expect(slowToggle().props['aria-expanded']).toBe(true);
    expect(slowRow()).toContain(`$ ${SLOW}`);
    expect(slowRow()).toContain(PLACEHOLDER);
    expect(textOf(slowToggle())).toContain('运行中');

    // 展开是逐行记的：点开慢的那一行，跑完的那一行还收着
    expect(doneToggle().props['aria-expanded']).toBe(false);
    expect(doneRow()).not.toContain('Screening of Cry for Help signals');

    click(doneToggle());
    expect(doneRow()).toContain(`$ ${PUBMED}`);
    expect(doneRow()).toContain('Screening of Cry for Help signals');
    // 占位字样确实存在（上面慢的那一行刚看到过），跑完的这一行没有
    expect(doneRow()).not.toContain(PLACEHOLDER);

    m.rerender({
      tools: [done, { ...slow, status: 'failed', exitCode: 1, chunks: [{ stream: 'stderr', data: 'Error: Server error: 504\n' }] }],
    });
    expect(textOf(slowToggle())).toContain('失败');
    expect(slowToggle().props['aria-expanded']).toBe(true);
    expect(slowRow()).toContain('Server error: 504');
    expect(slowRow()).not.toContain(PLACEHOLDER);
    expect(textOf(m.find('tool-group-toggle-tc-pubmed'))).toContain('完成 1 · 失败 1');
  });
});

/**
 * 外面那一层：`ProcessGroup` 把一段工具块切成 `ToolGroup` 还是一张张 `ToolCard`
 * （判据 `isParallelGroup` 有自己的纯函数用例，这里钉的是「组件真的调它、结果真的接上」），
 * 以及「过程」区跑着时展开、跑完默认收起。
 */
describe('ProcessGroup：并行识别与默认折叠', () => {
  const TID = 'thr-1';
  const MID = 'thr-1:msg-1';
  const three = ['tc-arxiv', 'tc-s2', 'tc-pubmed'].map((id) => tool(id));

  const runningNow = () => {
    useRunsStore.setState({ runStateByThread: { [TID]: { status: 'running', runId: 'r1' } } });
    useRunsStore.getState().startMessageBuffer(TID, MID);
  };

  it('跑着时展开、跑完默认收起；展开后三路并行是一个 ToolGroup，去掉 groupId 就是三张散卡', () => {
    runningNow();
    const m = mount(ProcessGroup, { threadId: TID, messageId: MID, blocks: three });
    expect(m.query('process-content')).not.toBeNull();

    // 块不变，只让这一轮结束（状态回 idle、buffer 挪走 —— isRunning 看的就是这两样）
    useRunsStore.setState(useRunsStore.getInitialState());
    m.rerender({ threadId: TID, messageId: MID, blocks: three });
    expect(textOf(m.find('process-toggle'))).toContain('已处理');
    expect(m.query('process-content')).toBeNull();

    click(m.find('process-toggle'));
    const content = m.find('process-content');
    const groups = findAllWhere(content, (el) => el.type === ToolGroup);
    expect(groups).toHaveLength(1);
    expect((groups[0].props.tools as ToolBlock[]).map((t) => t.id)).toEqual(['tc-arxiv', 'tc-s2', 'tc-pubmed']);
    expect(findAllWhere(content, (el) => el.type === ToolCard)).toHaveLength(0);

    // 对照：同样三条、只去掉 parallelGroupId → 三张散卡，没有组
    const loose = three.map((t) => ({ ...t, parallelGroupId: undefined }));
    m.rerender({ threadId: TID, messageId: MID, blocks: loose });
    const content2 = m.find('process-content');
    expect(findAllWhere(content2, (el) => el.type === ToolGroup)).toHaveLength(0);
    expect(findAllWhere(content2, (el) => el.type === ToolCard).map((el) => el.key)).toEqual(['tc-arxiv', 'tc-s2', 'tc-pubmed']);
  });

  /**
   * 「结果补进同一张卡」在真 React 里靠的是父组件给的 key 不变：key 一变，卡片就被卸掉重建，
   * 用户点开的那张在结果回来的一刻自己收起来。这一层只能钉 key 本身。
   */
  it('工具从运行中到完成，给卡片与组的 key 不变', () => {
    runningNow();
    const single = tool('t-slow', { command: SLOW, status: 'running', chunks: [], parallelGroupId: undefined });
    const m = mount(ProcessGroup, { threadId: TID, messageId: MID, blocks: [single] });
    const cardKey = () => findAllWhere(m.find('process-content'), (el) => el.type === ToolCard).map((el) => el.key);
    expect(cardKey()).toEqual(['t-slow']);
    m.rerender({ threadId: TID, messageId: MID, blocks: [{ ...single, status: 'ok', chunks: [{ stream: 'stdout', data: 'x\n' }] }] });
    expect(cardKey()).toEqual(['t-slow']);

    const pair = [tool('tc-a', { status: 'running', chunks: [] }), tool('tc-b')];
    m.rerender({ threadId: TID, messageId: MID, blocks: pair });
    const groupKey = () => findAllWhere(m.find('process-content'), (el) => el.type === ToolGroup).map((el) => el.key);
    expect(groupKey()).toEqual(['tg-tc-a']);
    m.rerender({ threadId: TID, messageId: MID, blocks: [{ ...pair[0], status: 'ok' }, pair[1]] });
    expect(groupKey()).toEqual(['tg-tc-a']);
  });
});
