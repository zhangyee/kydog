import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere } from '../../../../test-support/miniReact';

/**
 * Task 6：MarkdownFileTab 接 MdCapsule 的分享键 / MdExportCard / MdExportToast（spec
 * 2026-09-22-md-export-pdf-design §2.3）。照 MarkdownFileTab.commentBox.test.tsx 的装配：
 * miniReact 换 hooks、store 换成直读 getState 的替身、CrepeEditor 换空组件、Crepe 在 node 里
 * 拉不起来所以 ref 由用例挂一个手搭的替身。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

function directRead<M extends Record<string, unknown>>(mod: M, key: keyof M & string): M {
  const real = mod[key] as unknown as { getState: () => unknown };
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as M[typeof key];
  Object.assign(hook as object, real);
  return { ...mod, [key]: hook };
}

vi.mock('../../../stores/uiStore', async (orig) => directRead(await orig<typeof import('../../../stores/uiStore')>(), 'useUiStore'));
vi.mock('../../../stores/threadsStore', async (orig) => directRead(await orig<typeof import('../../../stores/threadsStore')>(), 'useThreadsStore'));
vi.mock('../composerDraftStore', async (orig) => directRead(await orig<typeof import('../composerDraftStore')>(), 'useComposerDraftStore'));
vi.mock('./CrepeEditor', () => ({ CrepeEditor: function CrepeEditor() { return null; } }));

const { MarkdownFileTab } = await import('./MarkdownFileTab');
const { CrepeEditor } = await import('./CrepeEditor');
const { MdCapsule } = await import('./MdCapsule');
const { MdExportToast } = await import('./MdExportToast');
const { useThreadsStore } = await import('../../../stores/threadsStore');
const { useUiStore } = await import('../../../stores/uiStore');

const TAB = { id: '/p/ch3.md', path: '/p/ch3.md', kind: 'md' as const, title: 'ch3.md', status: 'ready' as const, diskContent: '# x\n', dirty: false, reloadNonce: 0 };

beforeEach(() => {
  (globalThis as any).window = { kydog: { invoke: vi.fn(), platform: 'darwin' }, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  useThreadsStore.setState({ threadsByProject: {} as never, currentThreadId: null });
  useUiStore.setState({ mdExport: { paper: 'letter', margin: 'narrow', pageNumbers: false }, openFileTabs: [], activeFileTabId: null });
});

/** 把编辑器 ref 挂上一个只会吐「未保存内容」的替身（CrepeEditor 被替身了，ref 没人挂）。 */
function attachEditor(tree: unknown) {
  const el = findAllWhere(tree as never, (e) => e.type === CrepeEditor)[0];
  (el.props.ref as { current: unknown }).current = { getMarkdown: () => '# 未保存的改动', getView: () => null };
}
const capsule = (tree: unknown) => findAllWhere(tree as never, (e) => e.type === MdCapsule)[0];
const toast = (tree: unknown) => findAllWhere(tree as never, (e) => e.type === MdExportToast)[0];

describe('MarkdownFileTab —— 导出 PDF 的接线', () => {
  it('选路径 → 用编辑器当前内容与 store 里的选项导出 → 成功提示；「打开」先关掉同路径的旧标签再开', async () => {
    const invoke = vi.fn(async (m: string) => (m === 'dialog.pickSavePath' ? '/out/ch3.pdf' : { pdfPath: '/out/ch3.pdf' }));
    (window as any).kydog.invoke = invoke;
    const m = mount(MarkdownFileTab, { tab: TAB, isActive: true });
    attachEditor(m.tree);
    capsule(m.tree).props.onToggleExport();
    expect(capsule(m.tree).props.exportOpen).toBe(true);
    const card = capsule(m.tree).props.renderExportCard({ current: null });
    card.props.onExport();
    await m.settle(); await m.settle();

    expect(invoke.mock.calls[0]).toEqual(['dialog.pickSavePath', { defaultPath: '/p/ch3.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] }]);
    // 选项取 store 里的（夹具是非默认值），内容取编辑器的（不是 diskContent）
    expect(invoke.mock.calls[1]).toEqual(['markdown.exportPdf', {
      mdPath: '/p/ch3.md', markdown: '# 未保存的改动', outPath: '/out/ch3.pdf',
      options: { paper: 'letter', margin: 'narrow', pageNumbers: false },
    }]);
    expect(capsule(m.tree).props.exporting).toBe(false);
    expect(toast(m.tree).props.toast).toMatchObject({ kind: 'done', pdfPath: '/out/ch3.pdf', fileName: 'ch3.pdf' });

    // 同路径的 PDF 标签已开着（带一个标记，重开后标记应消失，证明是新实例）
    useUiStore.setState({ openFileTabs: [{ id: '/out/ch3.pdf', path: '/out/ch3.pdf', kind: 'pdf', title: 'ch3.pdf', status: 'ready', diskContent: null, dirty: false, reloadNonce: 7 }] });
    toast(m.tree).props.onOpen('/out/ch3.pdf');
    const tabs = useUiStore.getState().openFileTabs.filter((t) => t.id === '/out/ch3.pdf');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].reloadNonce).toBe(0);
    expect(tabs[0].status).toBe('loading');
    expect(useUiStore.getState().activeFileTabId).toBe('/out/ch3.pdf');
  });

  it('存储框取消：不导出、不出提示；导出失败：出失败提示，转圈收回', async () => {
    // 显式标注参数类型（而非 `async () => null`）：不这样 vi.fn 推出的 mock.calls 是 `[][]`
    // （零元函数），下面 `cancel.mock.calls[0][0]` 会被 tsc 判成「空元组没有第 0 项」。
    const cancel = vi.fn(async (_method: string) => null);
    (window as any).kydog.invoke = cancel;
    const m = mount(MarkdownFileTab, { tab: TAB, isActive: true });
    attachEditor(m.tree);
    capsule(m.tree).props.renderExportCard({ current: null }).props.onExport();
    await m.settle();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toBe('dialog.pickSavePath');   // 正向：确实问过存储框
    expect(toast(m.tree).props.toast).toBeNull();

    const fail = vi.fn(async (method: string) => {
      if (method === 'dialog.pickSavePath') return '/out/ch3.pdf';
      throw new Error('导出超时（60 秒）');
    });
    (window as any).kydog.invoke = fail;
    capsule(m.tree).props.renderExportCard({ current: null }).props.onExport();
    await m.settle(); await m.settle();
    expect(toast(m.tree).props.toast).toMatchObject({ kind: 'failed', message: '导出超时（60 秒）' });
    expect(capsule(m.tree).props.exporting).toBe(false);
  });

  it('「在访达中显示」调 file.revealInFolder 并收起提示', async () => {
    const invoke = vi.fn(async (method: string) => (method === 'dialog.pickSavePath' ? '/out/ch3.pdf' : method === 'markdown.exportPdf' ? { pdfPath: '/out/ch3.pdf' } : undefined));
    (window as any).kydog.invoke = invoke;
    const m = mount(MarkdownFileTab, { tab: TAB, isActive: true });
    attachEditor(m.tree);
    capsule(m.tree).props.renderExportCard({ current: null }).props.onExport();
    await m.settle(); await m.settle();
    toast(m.tree).props.onReveal('/out/ch3.pdf');
    expect(invoke).toHaveBeenLastCalledWith('file.revealInFolder', { path: '/out/ch3.pdf' });
    expect(toast(m.tree).props.toast).toBeNull();
  });
});
