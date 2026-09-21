import { describe, it, expect, vi } from 'vitest';
import { mount, findAllWhere } from '../../../test-support/miniReact';

/**
 * Task 11：输入框里的批注区（`ComposerCommentList`）。照 `Composer.attachments.test.tsx`
 * 的模式：`vi.mock('react')` 换 miniReact 的 hooks；用到的 zustand store 换成「直读
 * getState」的替身；子组件（`CommentCard`）不展开，按 `el.type === CommentCard` 在树里找。
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

vi.mock('./composerDraftStore', async (orig) => directRead(await orig<typeof import('./composerDraftStore')>(), 'useComposerDraftStore'));
vi.mock('../../stores/confirmStore', () => ({ confirm: vi.fn() }));

const { ComposerCommentList } = await import('./ComposerCommentList');
const { CommentCard } = await import('./CommentCard');
const { confirm } = await import('../../stores/confirmStore');
const { useComposerDraftStore, EMPTY_DRAFT } = await import('./composerDraftStore');

const PROJ = '/proj';
const C = (id: string, quote: string) => ({ id, absPath: `${PROJ}/notes/ch3.md`, section: '3.2', quote, note: '', sourceTabId: 'x' });

describe('ComposerCommentList', () => {
  it('标题带条数；卡片的出处按对话的项目显示相对路径；× 删那一条', () => {
    useComposerDraftStore.setState({ byThread: { t1: { ...EMPTY_DRAFT, comments: [C('a', 'q1'), C('b', 'q2')] } } });
    const m = mount(ComposerCommentList, { threadId: 't1', projectPath: PROJ });
    expect(JSON.stringify(findAllWhere(m.tree as never, (el) => el.props['data-testid'] === 'composer-comments-count'))).toContain('待发送的批注 · 2');
    const cards = findAllWhere(m.tree as never, (el) => el.type === CommentCard);
    expect(cards.map((c) => c.props.file)).toEqual(['notes/ch3.md', 'notes/ch3.md']);
    (cards[0].props.onRemove as () => void)();
    expect(useComposerDraftStore.getState().byThread['t1']!.comments.map((c) => c.id)).toEqual(['b']);
  });

  it('全部清除：先问；点了「清除」才清，取消就留着', async () => {
    useComposerDraftStore.setState({ byThread: { t1: { ...EMPTY_DRAFT, comments: [C('a', 'q1'), C('b', 'q2')] } } });
    const m = mount(ComposerCommentList, { threadId: 't1', projectPath: PROJ });
    const clear = findAllWhere(m.tree as never, (el) => el.props['data-testid'] === 'composer-comments-clear')[0];
    vi.mocked(confirm).mockResolvedValueOnce(false);
    await (clear.props.onClick as () => Promise<void>)();
    expect(confirm).toHaveBeenCalledWith({ title: '清除 2 条待发送的批注？', message: '写好的批注会丢掉，原文件不受影响。', confirmLabel: '清除' });
    expect(useComposerDraftStore.getState().byThread['t1']!.comments).toHaveLength(2);
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await (clear.props.onClick as () => Promise<void>)();
    expect(useComposerDraftStore.getState().byThread['t1']!.comments).toEqual([]);
  });

  it('没有批注时整块不渲染（先证明有批注时渲染）', () => {
    useComposerDraftStore.setState({ byThread: { t1: { ...EMPTY_DRAFT, comments: [C('a', 'q')] } } });
    expect(mount(ComposerCommentList, { threadId: 't1', projectPath: PROJ }).tree).not.toBeNull();
    useComposerDraftStore.setState({ byThread: { t1: { ...EMPTY_DRAFT } } });
    expect(mount(ComposerCommentList, { threadId: 't1', projectPath: PROJ }).tree).toBeNull();
  });
});
