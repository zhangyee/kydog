import { describe, it, expect, vi } from 'vitest';
import { mount, findAllWhere } from '../../../test-support/miniReact';

/**
 * Task 11：对话标签上的待发批注计数（`TabItem.badge`）。照 `Composer.attachments.test.tsx`
 * 的模式：`vi.mock('react')` 换 miniReact 的 hooks；`MainPane` 用到的每个 zustand store
 * 都换成「直读 getState」的替身；`TabStrip` 与文件 tab 子组件不展开，按 `el.type === TabStrip`
 * 在树里找、断言它收到的 props。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

function directRead<M extends Record<string, unknown>>(mod: M, key: keyof M & string): M {
  const real = mod[key] as unknown as { getState: () => unknown };
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as M[typeof key];
  Object.assign(hook as object, real);
  return { ...mod, [key]: hook };
}

vi.mock('../../stores/threadsStore', async (orig) => directRead(await orig<typeof import('../../stores/threadsStore')>(), 'useThreadsStore'));
vi.mock('../../stores/uiStore', async (orig) => directRead(await orig<typeof import('../../stores/uiStore')>(), 'useUiStore'));
vi.mock('../workspace/unreadStore', async (orig) => directRead(await orig<typeof import('../workspace/unreadStore')>(), 'useUnreadStore'));
vi.mock('./composerDraftStore', async (orig) => directRead(await orig<typeof import('./composerDraftStore')>(), 'useComposerDraftStore'));

const { MainPane } = await import('./MainPane');
const { TabStrip } = await import('./TabStrip');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useUiStore } = await import('../../stores/uiStore');
const { useComposerDraftStore, EMPTY_DRAFT } = await import('./composerDraftStore');

describe('MainPane —— 对话标签上的待发批注计数', () => {
  it('有 2 条待发批注：对话那一格 badge=2；没有时不带 badge', () => {
    useThreadsStore.setState({ currentThreadId: 't1', threadsByProject: { '/p': [{ id: 't1', projectPath: '/p', title: 'x', createdAt: 'x', lastActiveAt: 'x' }] } as never });
    useUiStore.setState({ openFileTabs: [], activeFileTabId: null, activeCenterTab: 'thread', settingsTabOpen: false } as never);
    const c = { absPath: '/p/a.md', quote: 'q', note: '', sourceTabId: 'x' };
    useComposerDraftStore.setState({ byThread: { t1: { ...EMPTY_DRAFT, comments: [{ ...c, id: '1' }, { ...c, id: '2' }] } } });
    let strip = findAllWhere(mount(MainPane, {}).tree as never, (el) => el.type === TabStrip)[0];
    expect(strip.props.tabs[0]).toMatchObject({ id: 't1', kind: 'thread', badge: 2 });
    useComposerDraftStore.setState({ byThread: {} });
    strip = findAllWhere(mount(MainPane, {}).tree as never, (el) => el.type === TabStrip)[0];
    expect(strip.props.tabs[0].badge).toBeUndefined();
  });
});
