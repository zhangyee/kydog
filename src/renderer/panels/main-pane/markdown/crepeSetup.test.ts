import { describe, it, expect } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { languages } from '@codemirror/language-data';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { featuresFor, featureConfigsFor } from './crepeSetup';
import { addCommentMark, commentMarksPlugin } from './commentMarks';

const F = Crepe.Feature;

describe('featuresFor', () => {
  it('编辑模式与改造前逐项一致：十个特性全开', () => {
    expect(featuresFor('edit')).toEqual({
      [F.CodeMirror]: true, [F.ListItem]: true, [F.LinkTooltip]: true, [F.ImageBlock]: true,
      [F.BlockEdit]: true, [F.Toolbar]: true, [F.Cursor]: true, [F.Placeholder]: true,
      [F.Table]: true, [F.Latex]: true,
    });
  });

  it('打印模式关掉编辑用的五样，排版用的五样照开（spec §3.6）', () => {
    const p = featuresFor('print');
    // 正向：排版相关的仍开着 —— 下面那几个 false 不是因为整张表都是 false
    for (const on of [F.CodeMirror, F.ListItem, F.ImageBlock, F.Table, F.Latex]) expect(p[on], on).toBe(true);
    for (const off of [F.Toolbar, F.BlockEdit, F.Cursor, F.Placeholder, F.LinkTooltip]) expect(p[off], off).toBe(false);
  });
});

describe('featureConfigsFor', () => {
  const root = {} as HTMLElement;
  it('两种模式的 CodeMirror 语言表都是 @codemirror/language-data 的同一个数组（打印页预加载要命中同一批对象）', () => {
    const edit = featureConfigsFor({ mode: 'edit', root, markdown: '', mdPath: '/p/a.md', platform: 'darwin', onCommentClick: () => {} });
    const print = featureConfigsFor({ mode: 'print', root, markdown: '', mdPath: '/p/a.md' });
    expect(edit[F.CodeMirror]?.languages).toBe(languages);
    expect(print[F.CodeMirror]?.languages).toBe(languages);
  });

  it('只有编辑模式定制工具栏（评论键）', () => {
    const edit = featureConfigsFor({ mode: 'edit', root, markdown: '', mdPath: '/p/a.md', platform: 'darwin', onCommentClick: () => {} });
    const print = featureConfigsFor({ mode: 'print', root, markdown: '', mdPath: '/p/a.md' });
    expect(typeof edit[F.Toolbar]?.buildToolbar).toBe('function');
    expect(print[F.Toolbar]).toBeUndefined();
  });

  it('评论键 active：选区与已有评论有交集时强调；移到未评论文字时不强调', () => {
    const edit = featureConfigsFor({ mode: 'edit', root, markdown: '', mdPath: '/p/a.md', platform: 'darwin', onCommentClick: () => {} });
    const build = edit[F.Toolbar]?.buildToolbar;
    expect(build).toBeTypeOf('function');

    type ToolbarItem = { active: (ctx: { get: (key: unknown) => { state: EditorState } }) => boolean };
    let comment: ToolbarItem | undefined;
    const builder = {
      getGroup: () => ({ group: { items: [] } }),
      addGroup: () => ({
        addItem: (_key: string, item: ToolbarItem) => { comment = item; },
      }),
    };
    build?.(builder as never);
    expect(comment).toBeDefined();

    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' }, paragraph: { group: 'block', content: 'inline*' },
        text: { group: 'inline' },
      },
    });
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('甲乙丙丁戊己')])]);
    let state = EditorState.create({ doc, plugins: [commentMarksPlugin()] });
    state = state.apply(addCommentMark(state.tr, 'c1', 2, 5)); // 乙丙丁
    const active = () => comment!.active({ get: () => ({ state }) });

    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3))); // 甲乙：部分交叠
    expect(active()).toBe(true);

    // 同条反向对照：选区确实换到未评论的「戊己」，同一回调必须恢复非 active。
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5, 7)));
    expect(active()).toBe(false);
  });
});

describe('featureConfigsFor 的图片地址', () => {
  it('两种模式都按 md 所在目录解析相对路径；网络地址原样', async () => {
    const root = {} as HTMLElement;
    for (const opts of [
      { mode: 'edit' as const, root, markdown: '', mdPath: '/p/sub/doc.md', platform: 'darwin', onCommentClick: () => {} },
      { mode: 'print' as const, root, markdown: '', mdPath: '/p/sub/doc.md' },
    ]) {
      const proxy = featureConfigsFor(opts)[F.ImageBlock]?.proxyDomURL;
      expect(await proxy?.('figs/a.png'), opts.mode).toBe('file:///p/sub/figs/a.png');
      expect(await proxy?.('https://x.org/a.png'), opts.mode).toBe('https://x.org/a.png');
    }
  });
});
