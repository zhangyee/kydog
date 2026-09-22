import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';

/**
 * **拖放落点层（Task 7）**：文件拖进对话区任意位置都接——不是只有一小块「拖放区」。
 * 判据是 `dataTransfer.types` 含 `'Files'`（协议层事实，不用文件名后缀猜），
 * 松开交给 `ingestFiles` 这个唯一出口。提问卡片在场时没有输入框可放，不接。
 *
 * 照 `narrowMode.test.tsx` 的做法：`react` 换 miniReact 的 hooks，组件用到的每个
 * zustand store 都换成「直读 getState」的替身；`ingestFiles` 整个 mock 掉，这里只
 * 断言接线（drop 时确实把参数原样转交），不重复测 ingestFiles 自己的逻辑
 * （那是 composerIngest.test.ts 的事）。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

vi.mock('../../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

vi.mock('../../stores/threadsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useThreadsStore: hook };
});

vi.mock('../../stores/askStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/askStore')>();
  const real = mod.useAskStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useAskStore: hook };
});

vi.mock('./composerIngest', () => ({ ingestFiles: vi.fn() }));

const { ThreadView } = await import('./ThreadView');
const { ingestFiles } = await import('./composerIngest');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useUiStore } = await import('../../stores/uiStore');
const { useAskStore } = await import('../../stores/askStore');

function dragEvent(types: string[], files: unknown[] = []) {
  return { preventDefault: vi.fn(), dataTransfer: { types, files, dropEffect: 'none' } };
}
function root(tree: unknown) {
  return findAllWhere(tree as never, (el) => typeof el.props.onDrop === 'function')[0];
}
const overlay = (tree: unknown) => findAllWhere(tree as never, (el) => el.props['data-testid'] === 'drop-overlay');

beforeEach(() => {
  (globalThis as any).window = { kydog: { invoke: vi.fn().mockResolvedValue([]), on: () => () => {} } };
  useUiStore.setState(useUiStore.getInitialState());
  useThreadsStore.setState({ historyByThread: { t1: [] } });
  useAskStore.setState({ pendingByThread: {} });
  vi.mocked(ingestFiles).mockClear();
});

describe('ThreadView —— 落点层', () => {
  it('拖进来的是文件：出落点层，松开交给 ingestFiles；拖的是文字：不出', () => {
    const m = mount(ThreadView, { threadId: 't1' });
    root(m.tree).props.onDragEnter(dragEvent(['Files']));
    expect(overlay(m.tree)).toHaveLength(1);
    const files = [{ name: 'a.pdf' }];
    root(m.tree).props.onDrop(dragEvent(['Files'], files));
    expect(ingestFiles).toHaveBeenCalledWith('t1', files);
    expect(overlay(m.tree)).toHaveLength(0);

    root(m.tree).props.onDragEnter(dragEvent(['text/plain']));
    expect(overlay(m.tree)).toHaveLength(0);
  });

  it('提问卡片在场时不接（先证明不在场时接）', () => {
    let m = mount(ThreadView, { threadId: 't1' });
    root(m.tree).props.onDragEnter(dragEvent(['Files']));
    expect(overlay(m.tree)).toHaveLength(1);
    useAskStore.setState({ pendingByThread: { t1: { toolCallId: 'x', questions: [] } } });
    m = mount(ThreadView, { threadId: 't1' });
    root(m.tree).props.onDragEnter(dragEvent(['Files']));
    expect(overlay(m.tree)).toHaveLength(0);
  });
});
