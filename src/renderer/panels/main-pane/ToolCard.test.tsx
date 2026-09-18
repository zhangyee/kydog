import { describe, it, expect, vi } from 'vitest';
import { mount, findAllWhere, type MiniElement, type Mounted } from '../../../test-support/miniReact';
import type { AssistantBlock } from '../../../shared/types';

/**
 * **单张工具卡：跑着的时候就能展开看命令，结果回来补进同一张卡**
 * （`e2e/63-running-tool-command` 第一条挪下来的那一半）。
 *
 * 命令在工具开始那一刻就随 `run.tool_call_start` 到了，输出要等工具结束才一次性发过来
 * （AgentService 不转发 tool_execution_update）。原先卡片「有输出才能展开」，于是一批并行的
 * fastpaper 全显示成「fastpaper 运行中」，哪条卡住了只能干等。
 *
 * 渲染用 miniReact（见 `src/test-support/miniReact.ts` 顶部）：真调组件函数、真触发
 * `onClick`，`rerender` 换的是同一个组件实例的 props —— 「补进同一张卡」在这一层的意思是
 * 展开状态不因结果回来而丢。父组件那边 key 不变（React 真的复用这张卡）钉在
 * `ToolGroup.test.tsx` 的 ProcessGroup 那一组。
 *
 * 占位字样**照字面写**，不 import `RUNNING_OUTPUT_PLACEHOLDER`：那个常量被改成空串时，
 * 「含空串」恒真，import 进来的断言会跟着一起失效。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { ToolCard } = await import('./ToolCard');

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

const SLOW = "fastpaper search biorxiv 'cry for help' --after 2025-06-01 -n 8";
const PLACEHOLDER = '运行中，结果回来后显示在这里';

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

const running = (patch: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool_call', id: 't-slow', name: 'bash', command: SLOW, chunks: [], status: 'running', ...patch,
});

function handles(m: Mounted<{ tool: ToolBlock }>) {
  return {
    toggle: (): MiniElement => m.find('tool-toggle-t-slow'),
    card: (): string => textOf(m.find('tool-t-slow')),
    click: (): void => { (m.find('tool-toggle-t-slow').props.onClick as () => void)(); },
  };
}

describe('ToolCard：运行中能展开，结果回来补进同一张卡', () => {
  it('运行中：按钮可点，展开后看到命令与占位字样；完成后输出补进来、占位消失、命令还在、仍是展开的', () => {
    const m = mount(ToolCard, { tool: running() });
    const { toggle, card, click } = handles(m);

    // 前提：它确实还在跑，而且一个字的输出都没有
    expect(textOf(toggle())).toContain('运行中');
    expect(toggle().props.disabled).toBe(false);
    expect(toggle().props['aria-expanded']).toBe(false);
    // 收着的时候命令不在卡里 —— 下面展开之后它在，证明这条不是查找坏了的假绿
    expect(card()).not.toContain(`$ ${SLOW}`);

    click();
    expect(toggle().props['aria-expanded']).toBe(true);
    expect(card()).toContain(`$ ${SLOW}`);
    expect(card()).toContain(PLACEHOLDER);
    expect(textOf(toggle())).toContain('运行中');

    m.rerender({
      tool: running({
        status: 'ok', exitCode: 0,
        chunks: [{ stream: 'stdout', data: '[40000001] Root exudates recruit protective bacteria\n' }],
      }),
    });
    expect(textOf(toggle())).toContain('完成');
    expect(toggle().props['aria-expanded']).toBe(true);
    expect(card()).toContain('Root exudates recruit protective bacteria');
    expect(card()).not.toContain(PLACEHOLDER);
    expect(card()).toContain(`$ ${SLOW}`);
  });

  it('以失败结束：stderr 补进同一张卡，占位消失', () => {
    const m = mount(ToolCard, { tool: running() });
    const { toggle, card, click } = handles(m);
    click();
    expect(card()).toContain(PLACEHOLDER);

    m.rerender({
      tool: running({ status: 'failed', exitCode: 1, chunks: [{ stream: 'stderr', data: 'Error: Server error: 504\n' }] }),
    });
    expect(textOf(toggle())).toContain('失败');
    expect(toggle().props['aria-expanded']).toBe(true);
    expect(card()).toContain('Server error: 504');
    expect(card()).not.toContain(PLACEHOLDER);
    // 走的是 stderr 那一色
    const spans = findAllWhere(m.find('tool-t-slow'), (el) => el.props['data-stream'] !== undefined);
    expect(spans.map((el) => el.props['data-stream'])).toEqual(['stderr']);
  });
});
