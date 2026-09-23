import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';
import type { Thread } from '../../../shared/types';

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
const { UnsavedChangesModal } = await import('./markdown/UnsavedChangesModal');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useUiStore } = await import('../../stores/uiStore');
const { _clearSaversForTesting, registerSaver } = await import('./markdown/saveRegistry');

const THREAD: Thread = {
  id: 'thread-1', projectPath: '/p', title: '对话',
  createdAt: '2026-09-23T00:00:00Z', lastActiveAt: '2026-09-23T00:00:00Z',
};

type CloseRequestState = ReturnType<typeof useUiStore.getState> & {
  closeActiveTabRequests: number;
  requestCloseActiveTab: () => void;
};

let invoke: ReturnType<typeof vi.fn>;

function seedThread(): void {
  useThreadsStore.setState({
    threadsByProject: { '/p': [THREAD] }, currentThreadId: THREAD.id, focusedProjectPath: '/p',
  });
}

function seedFile(path = '/p/a.md', dirty = false): void {
  useUiStore.getState().openFile(path);
  useUiStore.getState().setFileTabDirty(path, dirty);
}

function requestClose(): void {
  (useUiStore.getState() as CloseRequestState).requestCloseActiveTab();
}

function modalOf(tree: unknown) {
  const hits = findAllWhere(tree as never, (el) => el.type === UnsavedChangesModal);
  expect(hits).toHaveLength(1);
  return hits[0];
}

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  useThreadsStore.setState(useThreadsStore.getInitialState(), true);
  _clearSaversForTesting();
  invoke = vi.fn(async () => undefined);
  (globalThis as unknown as { window: unknown }).window = { kydog: { invoke } };
});

afterEach(() => {
  _clearSaversForTesting();
  delete (globalThis as unknown as Record<string, unknown>).window;
});

describe('MainPane 关闭活动 tab', () => {
  it('活动文件关闭后仍有 thread：只关文件，不关窗口', () => {
    seedThread();
    seedFile();
    requestClose();

    mount(MainPane, {});

    expect(useUiStore.getState().openFileTabs).toHaveLength(0);
    expect(useThreadsStore.getState().currentThreadId).toBe(THREAD.id);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('活动设置关闭后仍有 thread：回到 thread，不关窗口', () => {
    seedThread();
    useUiStore.getState().openSettings('about');
    requestClose();

    mount(MainPane, {});

    expect(useUiStore.getState().settingsTabOpen).toBe(false);
    expect(useUiStore.getState().activeCenterTab).toBe('thread');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('最后一个 thread 被快捷键关闭：清掉选择后关闭窗口', () => {
    seedThread();
    requestClose();

    mount(MainPane, {});

    expect(useThreadsStore.getState().currentThreadId).toBeNull();
    expect(invoke).toHaveBeenCalledWith('window.close');
  });

  it('没有任何 tab 时收到关闭请求：直接关闭窗口', () => {
    requestClose();
    mount(MainPane, {});
    expect(invoke).toHaveBeenCalledWith('window.close');
  });

  it('最后一个脏文件选择取消：提示存在，文件与窗口都保持打开', () => {
    seedFile('/p/dirty.md', true);
    requestClose();
    const mounted = mount(MainPane, {});
    const modal = modalOf(mounted.tree);

    modal.props.onCancel();

    expect(useUiStore.getState().openFileTabs.map((t) => t.id)).toEqual(['/p/dirty.md']);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('最后一个脏文件选择丢弃：文件关闭后才关闭窗口', () => {
    seedFile('/p/dirty.md', true);
    requestClose();
    const mounted = mount(MainPane, {});

    modalOf(mounted.tree).props.onDiscard();

    expect(useUiStore.getState().openFileTabs).toHaveLength(0);
    expect(invoke).toHaveBeenCalledWith('window.close');
  });

  it('脏文件提示期间又打开设置：丢弃只关原文件，不关仍有 tab 的窗口', () => {
    seedFile('/p/dirty.md', true);
    requestClose();
    const mounted = mount(MainPane, {});
    const modal = modalOf(mounted.tree);
    useUiStore.getState().openSettings('about');

    modal.props.onDiscard();

    expect(useUiStore.getState().openFileTabs).toHaveLength(0);
    expect(useUiStore.getState().settingsTabOpen).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('最后一个脏文件保存成功：等待保存成功后关 tab 与窗口', async () => {
    seedFile('/p/dirty.md', true);
    const save = vi.fn(async () => true);
    registerSaver('/p/dirty.md', save);
    requestClose();
    const mounted = mount(MainPane, {});

    modalOf(mounted.tree).props.onSave();
    expect(useUiStore.getState().openFileTabs).toHaveLength(1);
    await mounted.settle();

    expect(save).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().openFileTabs).toHaveLength(0);
    expect(invoke).toHaveBeenCalledWith('window.close');
  });

  it('点击最后一个 tab 的关闭按钮与快捷键走同一路径', () => {
    seedThread();
    const mounted = mount(MainPane, {});
    const strip = findAllWhere(mounted.tree as never, (el) => el.type === TabStrip)[0];

    strip.props.onClose(THREAD.id);

    expect(useThreadsStore.getState().currentThreadId).toBeNull();
    expect(invoke).toHaveBeenCalledWith('window.close');
  });
});
