import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Schema, type Node as PmNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import { mount, findAllWhere } from '../../../../test-support/miniReact';

/**
 * F5：批注框是挂在 document.body 上的 fixed portal，md 标签被 display:none 藏起来时它不跟着藏。
 * 修法是只在标签激活时渲染（`box && isActive`），box 状态、待定下划线与写了一半的字都留着。
 * 这里守的是 MarkdownFileTab 的接线；像素上「框真的没浮在对话上」由 e2e/27-composer.spec.ts 的
 * md 评论用例守。照 narrowMode.test.tsx 的做法：miniReact 换 hooks、store 换成直读 getState 的替身、
 * 子组件不展开；Crepe 在 node 里拉不起来，换成空组件，它的 ref 由用例挂一个手搭的 view。
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
const { CommentBox } = await import('./CommentBox');
const { CrepeEditor } = await import('./CrepeEditor');
const { commentMarksPlugin, commentMarkRanges, PENDING_COMMENT_ID } = await import('./commentMarks');
const { useThreadsStore } = await import('../../../stores/threadsStore');
const { useComposerDraftStore } = await import('../composerDraftStore');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    text: { group: 'inline' },
  },
});

/** 手搭的 view：真 EditorState（带批注下划线插件），dispatch 就地 apply。 */
function fakeView() {
  const doc: PmNode = schema.node('doc', null, [
    schema.node('heading', { level: 2 }, [schema.text('3.2 偏好对齐')]),
    schema.node('paragraph', null, [schema.text('将 β 固定为 0.1，并复现。')]),
  ]);
  let state = EditorState.create({ doc, plugins: [commentMarksPlugin()] });
  const from = 1 + '3.2 偏好对齐'.length + 2; // 段落里第一个字
  /** 选中段落开头的「将 β」（关框会把选区收拢，再开框前要重新选）。 */
  const select = () => { state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + '将 β'.length))); };
  select();
  return {
    select,
    get state() { return state; },
    dispatch: (tr: Transaction) => { state = state.apply(tr); },
    coordsAtPos: () => ({ left: 10, top: 20, bottom: 30, right: 10 }),
    focus: vi.fn(),
    dom: { contains: () => true },
  };
}

const TAB = { id: '/p/ch3.md', path: '/p/ch3.md', kind: 'md' as const, title: 'ch3.md', status: 'ready' as const, diskContent: '# x\n', dirty: false, reloadNonce: 0 };
const THREAD = { id: 't1', projectPath: '/p', title: '综述', createdAt: 'x', lastActiveAt: 'x' };

beforeEach(() => {
  (globalThis as any).window = { kydog: { invoke: vi.fn(), platform: 'darwin' }, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  useThreadsStore.setState({ threadsByProject: { '/p': [THREAD] } as never, currentThreadId: 't1' });
  useComposerDraftStore.setState({ byThread: {} });
});

describe('MarkdownFileTab —— 批注框只在本标签激活时渲染（F5）', () => {
  it('切走：框不渲染，但 box 与待定下划线都留着；切回来：原样出现，写了一半的字接着在', () => {
    const m = mount(MarkdownFileTab, { tab: TAB, isActive: true });
    const view = fakeView();
    const crepe = findAllWhere(m.tree as never, (el) => el.type === CrepeEditor)[0];
    (crepe.props.ref as { current: unknown }).current = { getView: () => view, getMarkdown: () => '' };
    const boxes = () => findAllWhere(m.tree as never, (el) => el.type === CommentBox);

    crepe.props.onCommentClick();
    // 正向：激活时框在，引文是选中的那段、写给的是当前对话、初值为空。
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0].props).toMatchObject({ quote: '将 β', targetTitle: '综述', initialNote: '' });
    boxes()[0].props.onNoteChange('取值依据');

    m.rerender({ tab: TAB, isActive: false });
    expect(boxes()).toHaveLength(0);
    // 框没了但批注还没取消：待定下划线仍在文档里。
    expect(commentMarkRanges(view.state).map((r) => r.id)).toEqual([PENDING_COMMENT_ID]);

    m.rerender({ tab: TAB, isActive: true });
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0].props).toMatchObject({ quote: '将 β', initialNote: '取值依据' });

    // 取消后再开：上一段写了一半的字不会带进新的框。
    boxes()[0].props.onCancel();
    expect(boxes()).toHaveLength(0);
    view.select();
    crepe.props.onCommentClick();
    expect(boxes()[0].props.initialNote).toBe('');
  });
});
