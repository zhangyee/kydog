import { describe, it, expect, beforeEach } from 'vitest';
import { useUiStore } from './uiStore';
import { MIN_BROWSER_WIDTH, DEFAULT_BROWSER_WIDTH } from '../../shared/types';

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

describe('uiStore markFileChanged', () => {
  beforeEach(() => { useUiStore.setState({ openFileTabs: [], activeFileTabId: null, activeCenterTab: 'thread' }); });

  it('md tab 也跟着磁盘走 —— 外部改动给它加计数', () => {
    useUiStore.getState().openFile('/p/report.md');
    useUiStore.getState().markFileChanged('/p/report.md');
    expect(useUiStore.getState().openFileTabs[0].reloadNonce).toBe(1);
  });

  it('html tab 的计数不受影响', () => {
    useUiStore.getState().openFile('/p/report.html');
    useUiStore.getState().markFileChanged('/p/report.html');
    expect(useUiStore.getState().openFileTabs[0].reloadNonce).toBe(1);
  });

  it('pdf tab 不消费这个信号', () => {
    useUiStore.getState().openFile('/p/paper.pdf');
    useUiStore.getState().markFileChanged('/p/paper.pdf');
    expect(useUiStore.getState().openFileTabs[0].reloadNonce).toBe(0);
  });

  it('只给同路径的 tab 加计数，其他 tab 不动', () => {
    useUiStore.getState().openFile('/p/a.md');
    useUiStore.getState().openFile('/p/b.md');
    useUiStore.getState().markFileChanged('/p/a.md');
    const tabs = useUiStore.getState().openFileTabs;
    expect(tabs.find((t) => t.id === '/p/a.md')!.reloadNonce).toBe(1);
    expect(tabs.find((t) => t.id === '/p/b.md')!.reloadNonce).toBe(0);
  });

  it('没有对应 tab 时是 noop，不换 openFileTabs 引用', () => {
    useUiStore.getState().openFile('/p/a.md');
    const before = useUiStore.getState().openFileTabs;
    useUiStore.getState().markFileChanged('/p/missing.md');
    expect(useUiStore.getState().openFileTabs).toBe(before);
  });

  it('连续多次改动逐次累加 —— 每一次都要让 tab 再去看一眼磁盘', () => {
    useUiStore.getState().openFile('/p/a.md');
    useUiStore.getState().markFileChanged('/p/a.md');
    useUiStore.getState().markFileChanged('/p/a.md');
    expect(useUiStore.getState().openFileTabs[0].reloadNonce).toBe(2);
  });
});

/**
 * 浏览器侧栏与 Inspector 共用右栏那块地，但**各记各的状态与宽度**。
 * 混起来的具体后果：用户平时把 Inspector 收着，开一次浏览器再关掉，
 * Inspector 就自己展开了 —— 一次没人要求过的状态改动。
 */
describe('uiStore 浏览器侧栏', () => {
  beforeEach(() => {
    useUiStore.setState({
      browserOpen: false, browserWidth: DEFAULT_BROWSER_WIDTH, inspectorCollapsed: false, inspectorWidth: 280,
    });
  });

  it('toggleBrowser 开合', () => {
    useUiStore.getState().toggleBrowser();
    expect(useUiStore.getState().browserOpen).toBe(true);
    useUiStore.getState().toggleBrowser();
    expect(useUiStore.getState().browserOpen).toBe(false);
  });

  it('closeBrowser 只关不开', () => {
    useUiStore.setState({ browserOpen: true });
    useUiStore.getState().closeBrowser();
    expect(useUiStore.getState().browserOpen).toBe(false);
    useUiStore.getState().closeBrowser();
    expect(useUiStore.getState().browserOpen).toBe(false);
  });

  it('开合浏览器不碰 Inspector 的收起状态', () => {
    useUiStore.setState({ inspectorCollapsed: true });
    useUiStore.getState().toggleBrowser();
    useUiStore.getState().toggleBrowser();
    expect(useUiStore.getState().inspectorCollapsed).toBe(true);
  });

  it('两栏各记各的宽度，互不写对方', () => {
    useUiStore.getState().setBrowserWidth(700);
    expect(useUiStore.getState().browserWidth).toBe(700);
    expect(useUiStore.getState().inspectorWidth).toBe(280);
    useUiStore.getState().setInspectorWidth(300);
    expect(useUiStore.getState().browserWidth).toBe(700);
  });

  /**
   * **拖拽时当场钳**，与另外两栏那句 `Math.max(0, w)` 不同：这个宽度会立刻经
   * `browser.syncView` 变成原生 WebContentsView 的 bounds，非法值当场就生效；
   * 落盘那一侧的 `sanitizeBrowserWidth` 是 fire-and-forget 的，赶不上。
   */
  it('宽度当场钳到下限（不等落盘往返把它拉回来）', () => {
    useUiStore.getState().setBrowserWidth(10);
    expect(useUiStore.getState().browserWidth).toBe(MIN_BROWSER_WIDTH);
    useUiStore.getState().setBrowserWidth(-9999);
    expect(useUiStore.getState().browserWidth).toBe(MIN_BROWSER_WIDTH);
  });

  it('另外两栏没有这道下限 —— 别顺手把它们也改了', () => {
    useUiStore.getState().setInspectorWidth(10);
    expect(useUiStore.getState().inspectorWidth).toBe(10);
  });
});
