import { describe, it, expect, beforeEach } from 'vitest';
import { useUiStore } from './uiStore';

function reset() {
  useUiStore.setState({ openFileTabs: [], activeFileTabId: null, activeCenterTab: 'thread' });
}

describe('uiStore 文件 tab', () => {
  beforeEach(reset);

  it('openFile 打开新文件 → push tab + 激活', () => {
    useUiStore.getState().openFile('/p/notes.md');
    const s = useUiStore.getState();
    expect(s.openFileTabs).toHaveLength(1);
    expect(s.openFileTabs[0]).toMatchObject({
      id: '/p/notes.md', path: '/p/notes.md', title: 'notes.md',
      status: 'loading', diskContent: null, dirty: false,
    });
    expect(s.activeFileTabId).toBe('/p/notes.md');
    expect(s.activeCenterTab).toBe('file');
  });

  it('openFile 已打开的文件 → 只聚焦不重复 push', () => {
    const st = useUiStore.getState();
    st.openFile('/p/notes.md');
    useUiStore.setState({ activeCenterTab: 'thread' });
    useUiStore.getState().openFile('/p/notes.md');
    const s = useUiStore.getState();
    expect(s.openFileTabs).toHaveLength(1);
    expect(s.activeFileTabId).toBe('/p/notes.md');
    expect(s.activeCenterTab).toBe('file');
  });

  it('setFileTabStatus 写回 ready + diskContent', () => {
    useUiStore.getState().openFile('/p/notes.md');
    useUiStore.getState().setFileTabStatus('/p/notes.md', { status: 'ready', diskContent: '# hi' });
    const tab = useUiStore.getState().openFileTabs[0];
    expect(tab.status).toBe('ready');
    expect(tab.diskContent).toBe('# hi');
  });

  it('setFileTabDirty 切换脏标记', () => {
    useUiStore.getState().openFile('/p/notes.md');
    useUiStore.getState().setFileTabDirty('/p/notes.md', true);
    expect(useUiStore.getState().openFileTabs[0].dirty).toBe(true);
  });

  it('setFileTabDiskContent 更新基准并清脏', () => {
    useUiStore.getState().openFile('/p/notes.md');
    useUiStore.getState().setFileTabDirty('/p/notes.md', true);
    useUiStore.getState().setFileTabDiskContent('/p/notes.md', '# saved');
    const tab = useUiStore.getState().openFileTabs[0];
    expect(tab.diskContent).toBe('# saved');
    expect(tab.dirty).toBe(false);
  });

  it('closeFileTab 关闭激活 tab → 切到剩余末尾 tab', () => {
    const st = useUiStore.getState();
    st.openFile('/p/a.md');
    st.openFile('/p/b.md');
    useUiStore.getState().closeFileTab('/p/b.md');
    const s = useUiStore.getState();
    expect(s.openFileTabs.map((t) => t.id)).toEqual(['/p/a.md']);
    expect(s.activeFileTabId).toBe('/p/a.md');
    expect(s.activeCenterTab).toBe('file');
  });

  it('closeFileTab 关闭最后一个文件 tab → activeCenterTab 回 thread', () => {
    useUiStore.getState().openFile('/p/a.md');
    useUiStore.getState().closeFileTab('/p/a.md');
    const s = useUiStore.getState();
    expect(s.openFileTabs).toHaveLength(0);
    expect(s.activeFileTabId).toBeNull();
    expect(s.activeCenterTab).toBe('thread');
  });
});
