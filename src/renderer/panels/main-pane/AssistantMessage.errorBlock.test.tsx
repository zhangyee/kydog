import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere } from '../../../test-support/miniReact';

/**
 * **错误只显示在出错的那一轮**（2026-09-14 修的 bug）。
 *
 * 以前红字挂在 `AssistantMessage` 底部，判据是线程级的 `runStateByThread[threadId]`：
 * 「这条对话最近一次运行出错了没有」。两个后果：① 一个字都没输出就失败的那一轮根本
 * 没有回复组件，红字无处落脚；② 聊了几轮之后才出错，前面每一条正常回复都会挂上同一行
 * 红字。现在错误是这一轮自己的 `error` 块，只在带着它的那一条里渲染。
 *
 * 渲染用 miniReact（见 narrowMode.test.tsx 顶部的说明）：子组件不展开，
 * `ErrorMarginalia` 在树上是一个 `{ type: ErrorMarginalia, props: { text } }` 节点，
 * 按身份找它、读它的 `text`。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 与 narrowMode.test.tsx 同一套替身：只把 React 订阅那一层换成直读，store 本身全用真身。
vi.mock('../../stores/runsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/runsStore')>();
  const real = mod.useRunsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useRunsStore: hook };
});

vi.mock('../../stores/threadsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useThreadsStore: hook };
});

vi.mock('../../stores/identityStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/identityStore')>();
  const real = mod.useIdentityStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useIdentityStore: hook };
});

const { AssistantMessage } = await import('./AssistantMessage');
const { ErrorMarginalia } = await import('./ErrorMarginalia');
const { useRunsStore } = await import('../../stores/runsStore');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useIdentityStore } = await import('../../stores/identityStore');

beforeEach(() => {
  useRunsStore.setState(useRunsStore.getInitialState());
  useThreadsStore.setState(useThreadsStore.getInitialState());
  useIdentityStore.setState(useIdentityStore.getInitialState());
});

const errorsIn = (tree: unknown): string[] =>
  findAllWhere(tree, (el) => el.type === ErrorMarginalia).map((el) => el.props.text as string);

describe('AssistantMessage：错误只显示在出错的那一轮', () => {
  // 线程级 runState 故意保持初始（没有出错）：这一轮自己的 error 块必须不靠线程状态也渲染。
  it('这一轮带 error 块 → 显示错误原文', () => {
    const m = mount(AssistantMessage, {
      threadId: 't1', messageId: 'm2', settled: true,
      blocks: [{ kind: 'error', text: '402: Insufficient Balance' }],
    });
    expect(errorsIn(m.tree)).toEqual(['402: Insufficient Balance']);
  });

  // 线程级错误原文**故意与 error 块的原文不同**：旧实现按线程状态渲染的那一行会显示
  // 「线程级的旧错误」，于是连「出错那一轮查得到」这条正向前置也骗不过去 ——
  // 它必须是从这一轮自己的块里读出来的。
  it('线程最近一次运行出错，但这一轮本身正常 → 不挂错误（同条用例里先证明出错那一轮查得到）', () => {
    useRunsStore.setState({ runStateByThread: { t1: { status: 'error', error: '线程级的旧错误' } } });

    const failed = mount(AssistantMessage, {
      threadId: 't1', messageId: 'm2', settled: true,
      blocks: [{ kind: 'error', text: '402: Insufficient Balance' }],
    });
    expect(errorsIn(failed.tree)).toEqual(['402: Insufficient Balance']);

    const earlier = mount(AssistantMessage, {
      threadId: 't1', messageId: 'm1', settled: true,
      blocks: [{ kind: 'text', text: '第一答' }],
    });
    expect(errorsIn(earlier.tree)).toEqual([]);
  });
});
