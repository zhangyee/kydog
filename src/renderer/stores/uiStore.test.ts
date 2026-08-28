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

  it('openFile .md → kind=md', () => {
    useUiStore.getState().openFile('/p/notes.md');
    expect(useUiStore.getState().openFileTabs[0].kind).toBe('md');
  });

  it('openFile .pdf → kind=pdf', () => {
    useUiStore.getState().openFile('/p/paper.pdf');
    expect(useUiStore.getState().openFileTabs[0].kind).toBe('pdf');
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

  it('关闭非激活的后台 tab → 激活 tab 与 activeCenterTab 不变', () => {
    const st = useUiStore.getState();
    st.openFile('/p/a.md');
    st.openFile('/p/b.md');
    useUiStore.getState().closeFileTab('/p/a.md');
    const s = useUiStore.getState();
    expect(s.openFileTabs.map((t) => t.id)).toEqual(['/p/b.md']);
    expect(s.activeFileTabId).toBe('/p/b.md');
    expect(s.activeCenterTab).toBe('file');
  });

  it('在 settings 视图下关闭后台文件 tab → 不跳走 settings', () => {
    useUiStore.getState().openFile('/p/a.md');
    useUiStore.setState({ activeCenterTab: 'settings' });
    useUiStore.getState().closeFileTab('/p/a.md');
    const s = useUiStore.getState();
    expect(s.openFileTabs).toHaveLength(0);
    expect(s.activeFileTabId).toBeNull();
    expect(s.activeCenterTab).toBe('settings');
  });

  it('setFileTabStatus 写回 error 状态与 errorMessage', () => {
    useUiStore.getState().openFile('/p/a.md');
    useUiStore.getState().setFileTabStatus('/p/a.md', { status: 'error', errorMessage: '读失败' });
    const tab = useUiStore.getState().openFileTabs[0];
    expect(tab.status).toBe('error');
    expect(tab.errorMessage).toBe('读失败');
  });

  it('invalidateDir 删除单个缓存条目，其他不动', () => {
    useUiStore.setState({
      dirCache: {
        '/p': [{ name: 'a', path: '/p/a', kind: 'file' }],
        '/p/sub': [{ name: 'b', path: '/p/sub/b', kind: 'file' }],
      },
    });
    useUiStore.getState().invalidateDir('/p/sub');
    expect(useUiStore.getState().dirCache).toEqual({
      '/p': [{ name: 'a', path: '/p/a', kind: 'file' }],
    });
  });

  it('invalidateDir 对不存在的 path 是 noop', () => {
    useUiStore.setState({ dirCache: { '/p': [] } });
    useUiStore.getState().invalidateDir('/missing');
    expect(useUiStore.getState().dirCache).toEqual({ '/p': [] });
  });
});

describe('uiStore project 收折', () => {
  beforeEach(() => { useUiStore.setState({ collapsedProjects: new Set<string>() }); });

  it('默认全展开：没进过集合的 project 就是展开的', () => {
    expect(useUiStore.getState().collapsedProjects.has('/p/a')).toBe(false);
  });

  it('toggleProject 收起 → 再 toggle 展开', () => {
    useUiStore.getState().toggleProject('/p/a');
    expect(useUiStore.getState().collapsedProjects.has('/p/a')).toBe(true);
    useUiStore.getState().toggleProject('/p/a');
    expect(useUiStore.getState().collapsedProjects.has('/p/a')).toBe(false);
  });

  it('expandProject 只删不加：对本来就展开的 project 是 noop', () => {
    const before = useUiStore.getState().collapsedProjects;
    useUiStore.getState().expandProject('/p/a');
    // 引用不变 —— bootstrap 的落盘订阅就是靠引用比对判断该不该写盘
    expect(useUiStore.getState().collapsedProjects).toBe(before);
  });

  it('expandProject 把收起过的 project 放出来', () => {
    useUiStore.getState().toggleProject('/p/a');
    useUiStore.getState().expandProject('/p/a');
    expect(useUiStore.getState().collapsedProjects.has('/p/a')).toBe(false);
  });

  it('collapseAllProjects 用传入的全集覆盖，不保留旧条目', () => {
    useUiStore.getState().toggleProject('/p/gone');
    useUiStore.getState().collapseAllProjects(['/p/a', '/p/b']);
    expect([...useUiStore.getState().collapsedProjects].sort()).toEqual(['/p/a', '/p/b']);
  });

  it('每次改动都换新 Set 引用', () => {
    const before = useUiStore.getState().collapsedProjects;
    useUiStore.getState().toggleProject('/p/a');
    expect(useUiStore.getState().collapsedProjects).not.toBe(before);
  });
});
