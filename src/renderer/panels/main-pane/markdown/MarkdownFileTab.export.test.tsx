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

/** 可控 resolve 的 promise：守「导出中」那段状态要能卡在半路断言（见下面「导出中」那条用例）。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('MarkdownFileTab —— 导出 PDF 的接线', () => {
  it('选路径 → 用编辑器当前内容与 store 里的选项导出 → 成功提示（用的是 RPC 返回的 pdfPath，不是存储框给的 outPath）；「打开」先关掉同路径的旧标签再开，点完提示条消失', async () => {
    // 存储框给的路径（outPath）与 markdown.exportPdf 实际返回的路径（pdfPath）故意写成不同的
    // 字符串：提示条 / 「打开」用的该是 RPC 返回值，不能图省事直接复用 outPath——如果两者撞在
    // 一起，接错了（比如直接拿 outPath 当 pdfPath）也会照样测绿。
    const invoke = vi.fn(async (m: string) => (m === 'dialog.pickSavePath' ? '/out/ch3.pdf' : { pdfPath: '/out/ch3-final.pdf' }));
    (window as any).kydog.invoke = invoke;
    const m = mount(MarkdownFileTab, { tab: TAB, isActive: true });
    attachEditor(m.tree);
    capsule(m.tree).props.onToggleExport();
    expect(capsule(m.tree).props.exportOpen).toBe(true);
    const card = capsule(m.tree).props.renderExportCard({ current: null });
    card.props.onExport();
    await m.settle(); await m.settle();

    expect(invoke.mock.calls[0]).toEqual(['dialog.pickSavePath', { defaultPath: '/p/ch3.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] }]);
    // 选项取 store 里的（夹具是非默认值），内容取编辑器的（不是 diskContent）；outPath 是存储框给的那个
    expect(invoke.mock.calls[1]).toEqual(['markdown.exportPdf', {
      mdPath: '/p/ch3.md', markdown: '# 未保存的改动', outPath: '/out/ch3.pdf',
      options: { paper: 'letter', margin: 'narrow', pageNumbers: false },
    }]);
    expect(capsule(m.tree).props.exporting).toBe(false);
    // 正向：提示条带的是 exportPdf 返回的 pdfPath（跟 outPath 不同那个），不是存储框给的 outPath——
    // 这句本身也是下面「点『打开』后提示条消失」那句 toBeNull 的正向证明（先确认它不是 null）。
    expect(toast(m.tree).props.toast).toMatchObject({ kind: 'done', pdfPath: '/out/ch3-final.pdf', fileName: 'ch3-final.pdf' });

    // 同路径的 PDF 标签已开着（带一个标记）：下面断言的是 store 里换成了新的标签对象——
    // reloadNonce 归零、status 变回 'loading'（PdfFileTab 的「加载 PDF 字节」effect 靠 tab.status
    // 这个依赖重读），不是「组件重新挂载」——MainPane 按 tab.id 挂 key，PdfFileTab 组件实例
    // 本身不会换（见 MarkdownFileTab.tsx 的 openExported 注释）。
    useUiStore.setState({ openFileTabs: [{ id: '/out/ch3-final.pdf', path: '/out/ch3-final.pdf', kind: 'pdf', title: 'ch3-final.pdf', status: 'ready', diskContent: null, dirty: false, reloadNonce: 7 }] });
    toast(m.tree).props.onOpen('/out/ch3-final.pdf');
    const tabs = useUiStore.getState().openFileTabs.filter((t) => t.id === '/out/ch3-final.pdf');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].reloadNonce).toBe(0);
    expect(tabs[0].status).toBe('loading');
    expect(useUiStore.getState().activeFileTabId).toBe('/out/ch3-final.pdf');
    // 点「打开」后提示条消失（spec §2.4「点任一动作后消失」）。
    expect(toast(m.tree).props.toast).toBeNull();
  });

  it('导出中：转圈只罩「选好路径之后」那一段——存储框没返回时不算导出中，exportPdf 兑现前是，兑现后收回', async () => {
    // 存储框与 exportPdf 各用一个测试控制 resolve 时机的 promise，这样才能在「选路径已经
    // 完成、导出还没兑现」这个中间状态上落一个断言；固定成 async 函数直接 return 的话，
    // exporting 什么时候变 true 根本没有任何一条用例证明过——删掉 setExporting(true)
    // 或者把它挪到 pickSavePath 之前，三条旧用例照样全绿。
    const pick = deferred<string | null>();
    const exportPdf = deferred<{ pdfPath: string }>();
    const invoke = vi.fn((method: string): Promise<unknown> => {
      if (method === 'dialog.pickSavePath') return pick.promise;
      if (method === 'markdown.exportPdf') return exportPdf.promise;
      return Promise.resolve(undefined);
    });
    (window as any).kydog.invoke = invoke;
    const m = mount(MarkdownFileTab, { tab: TAB, isActive: true });
    attachEditor(m.tree);
    capsule(m.tree).props.renderExportCard({ current: null }).props.onExport();

    // 存储框还没返回：转圈没罩上——选路径阶段用户还能反悔，不该显得「已经在导出」。
    expect(capsule(m.tree).props.exporting).toBe(false);

    pick.resolve('/out/ch3.pdf');
    await m.settle();
    // 正向：选好路径、exportPdf 还没兑现——转圈已经罩上。
    expect(capsule(m.tree).props.exporting).toBe(true);

    exportPdf.resolve({ pdfPath: '/out/ch3.pdf' });
    await m.settle(); await m.settle();
    // 反向：exportPdf 兑现之后转圈收回——上面那句已经先证明它确实会变 true，这里不是巧合的默认值。
    expect(capsule(m.tree).props.exporting).toBe(false);
    expect(toast(m.tree).props.toast).toMatchObject({ kind: 'done' });
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
    // 正向：点「在访达中显示」之前提示条确实在——下面点完之后的 toBeNull 才有意义。
    expect(toast(m.tree).props.toast).not.toBeNull();
    toast(m.tree).props.onReveal('/out/ch3.pdf');
    expect(invoke).toHaveBeenLastCalledWith('file.revealInFolder', { path: '/out/ch3.pdf' });
    expect(toast(m.tree).props.toast).toBeNull();
  });

  it('标签切走（isActive 变 false）时收起设置卡：不然卡片挂在 window 捕获阶段的 Esc / 点外面监听会一直吞掉别处的 Esc', () => {
    const m = mount(MarkdownFileTab, { tab: TAB, isActive: true });
    capsule(m.tree).props.onToggleExport();
    expect(capsule(m.tree).props.exportOpen).toBe(true);   // 正向：先证明确实能打开
    m.rerender({ tab: TAB, isActive: false });
    expect(capsule(m.tree).props.exportOpen).toBe(false);
  });
});
