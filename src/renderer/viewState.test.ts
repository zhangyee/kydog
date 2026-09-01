import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { currentViewState, restoreViewState, installViewStateSync } from './viewState';
import { useUiStore } from './stores/uiStore';
import { useThreadsStore } from './stores/threadsStore';
import type { CenterViewState } from '../shared/types';

const MD = 'D:/p/a.md';
const PDF = 'D:/p/b.pdf';
const TID = 'thr-1';

function resetStores() {
  useUiStore.setState({ openFileTabs: [], activeFileTabId: null, activeCenterTab: 'thread' });
  useThreadsStore.setState({ currentThreadId: null, threadsByProject: {}, historyByThread: {} });
}

describe('currentViewState', () => {
  beforeEach(resetStores);

  it('只摘路径与选择，不抄 tab 的易变字段', () => {
    useUiStore.getState().openFile(MD);
    useUiStore.getState().openFile(PDF);
    useThreadsStore.getState().selectThread(TID);

    expect(currentViewState()).toEqual({
      threadId: TID,
      filePaths: [MD, PDF],
      activeFilePath: PDF,
      activeTab: 'file',
    });
  });

  it('停在设置页时按 thread 记 —— 设置页的开合由 bootstrap 自己判断', () => {
    useUiStore.setState({ activeCenterTab: 'settings' });
    expect(currentViewState().activeTab).toBe('thread');
  });
});

describe('restoreViewState', () => {
  beforeEach(resetStores);

  const snapshot = (over: Partial<CenterViewState> = {}): CenterViewState => ({
    threadId: TID, filePaths: [MD, PDF], activeFilePath: PDF, activeTab: 'file', ...over,
  });

  it('按原顺序重开文件 tab，并聚焦回原来那个', () => {
    restoreViewState(snapshot(), new Set([TID]));

    const ui = useUiStore.getState();
    expect(ui.openFileTabs.map((t) => t.id)).toEqual([MD, PDF]);
    expect(ui.openFileTabs.map((t) => t.kind)).toEqual(['md', 'pdf']);
    expect(ui.activeFileTabId).toBe(PDF);
    expect(ui.activeCenterTab).toBe('file');
    expect(useThreadsStore.getState().currentThreadId).toBe(TID);
  });

  it('刷新前停在会话上时，回来还在会话上', () => {
    restoreViewState(snapshot({ activeTab: 'thread' }), new Set([TID]));
    expect(useUiStore.getState().activeCenterTab).toBe('thread');
    expect(useUiStore.getState().openFileTabs).toHaveLength(2); // tab 还在，只是没在前面
    expect(useThreadsStore.getState().currentThreadId).toBe(TID);
  });

  it('记着的 thread 已经被删了就不选它 —— 否则会顶着一个不存在的选中态', () => {
    restoreViewState(snapshot({ activeTab: 'thread' }), new Set(['别的线程']));
    expect(useThreadsStore.getState().currentThreadId).toBeNull();
  });

  it('activeFilePath 不在 tab 列表里时不聚焦，落回会话', () => {
    restoreViewState(snapshot({ activeFilePath: 'D:/p/没了.md' }), new Set([TID]));
    expect(useUiStore.getState().activeFileTabId).toBeNull();
    expect(useUiStore.getState().activeCenterTab).toBe('thread');
  });

  it('首启强制设置页时不抢 activeCenterTab —— openFile 的副作用也得摁住', () => {
    useUiStore.setState({ activeCenterTab: 'settings', settingsTabOpen: true });
    restoreViewState(snapshot(), new Set([TID]), true);

    expect(useUiStore.getState().activeCenterTab).toBe('settings');
    expect(useUiStore.getState().openFileTabs).toHaveLength(2); // tab 照样开回来
  });

  it('冷启动（快照为 null）什么都不做', () => {
    restoreViewState(null, new Set([TID]));
    expect(useUiStore.getState().openFileTabs).toEqual([]);
    expect(useThreadsStore.getState().currentThreadId).toBeNull();
  });
});

describe('installViewStateSync', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let stop: () => void;

  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { window: unknown }).window = { kydog: { invoke } };
    resetStores();
    stop = installViewStateSync();
  });
  afterEach(() => {
    stop();
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('中央区一变就上报', () => {
    useUiStore.getState().openFile(MD);
    expect(invoke).toHaveBeenCalledWith('ui.saveViewState', {
      state: { threadId: null, filePaths: [MD], activeFilePath: MD, activeTab: 'file' },
    });
  });

  it('tab 的 status / dirty 抖动不上报 —— 那些字段根本不进快照', () => {
    useUiStore.getState().openFile(MD);
    invoke.mockClear();

    useUiStore.getState().setFileTabStatus(MD, { status: 'ready', diskContent: '# hi' });
    useUiStore.getState().setFileTabDirty(MD, true);
    useUiStore.getState().markFileChanged(MD);

    expect(invoke).not.toHaveBeenCalled();
  });
});
