import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Clock, Container, Ctx } from '@milkdown/kit/ctx';
import {
  CommandsReady,
  SchemaReady,
  commandsCtx,
  CommandManager,
  schemaCtx,
  editorViewCtx,
  inputRulesCtx,
  prosePluginsCtx,
} from '@milkdown/kit/core';
import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import { isMarkSelectedCommand, inlineCodeInputRule } from '@milkdown/kit/preset/commonmark';
import { inputRules } from '@milkdown/kit/prose/inputrules';
import type { EditorView } from '@milkdown/kit/prose/view';
import { Crepe } from '@milkdown/crepe';
import {
  highlightSchema,
  toggleHighlightCommand,
  highlightInputRule,
  highlightSourceInputRules,
} from './highlight';
import { featureConfigsFor } from './crepeSetup';

beforeEach(() => {
  const target = new EventTarget();
  for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent'] as const)
    vi.stubGlobal(key, target[key].bind(target));
});
afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const ctx = new Ctx(new Container(), new Clock());
  await highlightSchema.ctx(ctx)();
  const spec = ctx.get(highlightSchema.key)(ctx);
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      code_block: { content: 'text*', group: 'block', code: true, marks: '' },
      text: { group: 'inline' },
      math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
      image: { group: 'inline', inline: true, atom: true, attrs: { src: {}, alt: {}, title: {} } },
      hardbreak: { group: 'inline', inline: true, attrs: { isInline: { default: false } } },
      unknown_atom: { group: 'inline', inline: true, atom: true, attrs: { payload: {} } },
    },
    marks: {
      highlight: spec,
      strong: {},
      code: { code: true },
      inlineCode: { code: true },
      link: { attrs: { href: { default: 'https://example.org' } } },
    },
  });
  ctx
    .inject(schemaCtx, schema)
    .inject(inputRulesCtx, [])
    .inject(prosePluginsCtx, [])
    .inject(commandsCtx, new CommandManager());
  ctx.record(CommandsReady).record(SchemaReady);
  const waits = Promise.all([ctx.wait(CommandsReady), ctx.wait(SchemaReady)]);
  ctx.done(CommandsReady);
  ctx.done(SchemaReady);
  await waits;
  await toggleHighlightCommand(ctx)();
  await isMarkSelectedCommand(ctx)();
  await highlightInputRule(ctx)();
  await highlightSourceInputRules(ctx)();
  return { ctx, schema, spec };
}
it('actual schema and toggle retain strong, inline code and link marks', async () => {
  const { ctx, schema, spec } = await setup();
  expect(spec.toDOM!(schema.marks.highlight.create(), true)).toEqual([
    'mark',
    { class: 'kydog-highlight' },
    0,
  ]);
  const doc = schema.node('doc', null, [
    schema.node(
      'paragraph',
      null,
      ['strong', 'code', 'link'].map((m) => schema.text(m, [schema.marks[m].create()])),
    ),
  ]);
  let state = EditorState.create({ doc });
  state = state.apply(state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)));
  const cmd = ctx.get(commandsCtx).get(toggleHighlightCommand.key)();
  const run = () =>
    cmd(state, (tr) => {
      state = state.apply(tr);
    });
  expect(run()).toBe(true);
  expect(state.doc.firstChild!.content.content.map((n) => n.marks.map((m) => m.type.name))).toEqual([
    ['highlight', 'strong'],
    ['highlight', 'code'],
    ['highlight', 'link'],
  ]);
  run();
  expect(state.doc.firstChild!.content.content.map((n) => n.marks.map((m) => m.type.name))).toEqual([
    ['strong'],
    ['code'],
    ['link'],
  ]);
});
it('input rule handles paragraph source but refuses code block and delimiters inside code marks', async () => {
  const { schema } = await setup();
  const plugin = inputRules({ rules: [highlightInputRule.inputRule] });
  for (const kind of ['paragraph', 'code_block', 'code']) {
    const text = '==typed=';
    const doc = schema.node('doc', null, [
      schema.node(
        kind === 'code_block' ? 'code_block' : 'paragraph',
        null,
        schema.text(text, kind === 'code' ? [schema.marks.code.create()] : []),
      ),
    ]);
    const state = EditorState.create({
      doc,
      plugins: [plugin],
      selection: TextSelection.create(doc, 1 + text.length),
    });
    let result = state;
    const view = {
      state,
      composing: false,
      dispatch(tr: Transaction) {
        result = state.apply(tr);
      },
    } as EditorView;
    const handled = plugin.props.handleTextInput!.call(
      plugin,
      view,
      1 + text.length,
      1 + text.length,
      '=',
      () => state.tr,
    );
    if (kind === 'paragraph') {
      expect(handled).toBe(true);
      expect(result.doc.firstChild!.firstChild!.marks.map((m) => m.type.name)).toEqual(['highlight']);
    } else {
      expect(handled).toBe(false);
      expect(result.doc).toBe(doc);
    }
  }
});
it('production toolbar builder adds a working highlight button and active state', async () => {
  const { ctx, schema } = await setup();
  const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('select'))]);
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 7) });
  ctx.inject(editorViewCtx, {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
  } as never);
  ctx.get(commandsCtx).setCtx(ctx);
  type Item = { key: string; icon: string; active: (c: Ctx) => boolean; onRun?: (c: Ctx) => void };
  const groups = new Map<string, { items: Item[] }>();
  const group = (key: string) => {
    const g = groups.get(key)!;
    const api = {
      group: g,
      addItem(k: string, item: Omit<Item, 'key'>) {
        g.items.push({ key: k, ...item });
        return api;
      },
    };
    return api;
  };
  groups.set('formatting', { items: [] });
  groups.set('function', { items: [] });
  const builder = {
    getGroup: group,
    addGroup(key: string) {
      groups.set(key, { items: [] });
      return group(key);
    },
  };
  featureConfigsFor({
    mode: 'edit',
    root: {} as HTMLElement,
    markdown: '',
    mdPath: '/p/a.md',
    platform: 'darwin',
    onCommentClick: () => {},
  })[Crepe.Feature.Toolbar]!.buildToolbar!(builder as never);
  const button = groups.get('formatting')!.items.find((i) => i.key === 'highlight')!;
  expect(button.icon).toContain('高亮');
  button.onRun!(ctx);
  expect(button.active(ctx)).toBe(true);
  button.onRun!(ctx);
  expect(button.active(ctx)).toBe(false);
});

it('uses loading grammar for typed input and allows outer highlight containing an existing code span', async () => {
  const { schema } = await setup();
  const apply = (nodes: Parameters<typeof schema.node>[2]) => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, nodes)]);
    const plugin = inputRules({ rules: [highlightInputRule.inputRule] });
    const end = doc.content.size - 1;
    const state = EditorState.create({ doc, plugins: [plugin], selection: TextSelection.create(doc, end) });
    let result = state;
    const view = {
      state,
      composing: false,
      dispatch(tr: Transaction) {
        result = state.apply(tr);
      },
    } as EditorView;
    const handled = plugin.props.handleTextInput!.call(plugin, view, end, end, '=', () => state.tr);
    return { handled, doc: result.doc };
  };
  expect(apply(schema.text('==valid=')).handled).toBe(true);
  for (const text of [
    '===invalid==',
    '== leading=',
    '==trailing =',
    '\\=\\=escaped=',
    '$a==b==$ =',
    '==unclosed',
    '====',
  ]) {
    expect(apply(schema.text(text)).handled, text).toBe(false);
  }
  const result = apply([
    schema.text('==outer '),
    schema.text('==inside==', [schema.marks.code.create()]),
    schema.text(' end='),
  ]);
  expect(result.handled).toBe(true);
  expect(result.doc.textContent).toBe('outer ==inside== end');
  expect(result.doc.firstChild!.child(1).marks.map((m) => m.type.name)).toEqual(['highlight', 'code']);
});

it('uses actual input-rule match positions for committed composition and two-character insertion', async () => {
  const { schema } = await setup();
  for (const [existing, input] of [
    ['==typed=', '='],
    ['==typed==', ''],
    ['==typed', '=='],
  ]) {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text(existing))]);
    const plugin = inputRules({ rules: [highlightInputRule.inputRule] });
    const end = doc.content.size - 1;
    const state = EditorState.create({ doc, plugins: [plugin], selection: TextSelection.create(doc, end) });
    let result = state;
    const view = {
      state,
      composing: false,
      dispatch(tr: Transaction) {
        result = state.apply(tr);
      },
    } as EditorView;
    expect(
      plugin.props.handleTextInput!.call(plugin, view, end, end, input, () => state.tr),
      `${existing} + ${input}`,
    ).toBe(true);
    expect(result.doc.textContent).toBe('typed');
    expect(result.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['highlight']);
  }
});

it('completed outer code and math recover literal equals from transient highlight marks', async () => {
  const { schema } = await setup();
  for (const source of ['$a==b==$', '`==code==`']) {
    const plugins = [
      highlightSourceInputRules.plugin(),
      inputRules({ rules: [highlightInputRule.inputRule] }),
    ];
    let state = EditorState.create({ schema, plugins });
    const view = {
      get state() {
        return state;
      },
      composing: false,
      dispatch(tr: Transaction) {
        state = state.apply(tr);
      },
    } as EditorView;
    let sawHighlight = false;
    for (const char of source) {
      const end = state.doc.content.size - 1;
      const handled = plugins.some((plugin) =>
        plugin.props.handleTextInput?.call(plugin, view, end, end, char, () => state.tr),
      );
      if (!handled) view.dispatch(state.tr.insertText(char, end));
      sawHighlight ||= state.doc.rangeHasMark(0, state.doc.content.size, schema.marks.highlight);
    }
    expect(sawHighlight).toBe(true);
    expect(state.doc.rangeHasMark(0, state.doc.content.size, schema.marks.highlight)).toBe(false);
    if (source.startsWith('$')) {
      expect(state.doc.firstChild!.firstChild!.type.name).toBe('math_inline');
      expect(state.doc.firstChild!.firstChild!.attrs.value).toBe('a==b==');
    } else {
      expect(state.doc.textContent).toBe('==code==');
      expect(state.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['inlineCode']);
    }
  }
});

it('completed code preserves supported inline atom source and maps subsequent text by document boundaries', async () => {
  const { schema } = await setup();
  for (const [middle, expected] of [
    [schema.text('plain'), 'before plain ==y=='],
    [schema.nodes.math_inline.create({ value: 'x' }), 'before $x$ ==y=='],
    [
      schema.nodes.image.create({ src: 'fig.png', alt: 'plot', title: 'caption' }),
      'before ![plot](fig.png "caption") ==y==',
    ],
    [schema.nodes.hardbreak.create(), 'before \\\n ==y=='],
    [schema.nodes.hardbreak.create({ isInline: true }), 'before \n ==y=='],
  ] as const) {
    const plugin = highlightSourceInputRules.plugin();
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('`before '),
        middle,
        schema.text(' '),
        schema.text('y', [schema.marks.highlight.create()]),
      ]),
    ]);
    let state = EditorState.create({
      doc,
      plugins: [plugin],
      selection: TextSelection.create(doc, doc.content.size - 1),
    });
    const view = {
      get state() {
        return state;
      },
      composing: false,
      dispatch(tr: Transaction) {
        state = state.apply(tr);
      },
    } as EditorView;
    const end = state.selection.from;
    expect(plugin.props.handleTextInput!.call(plugin, view, end, end, '`', () => state.tr)).toBe(true);
    expect(state.doc.textContent, middle.type.name).toBe(expected);
    expect(state.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['inlineCode']);
  }
});

it('unsupported atoms remain intact and do not fall through to the destructive upstream code rule', async () => {
  const { ctx, schema } = await setup();
  await inlineCodeInputRule(ctx)();
  const upstream = inputRules({ rules: [inlineCodeInputRule.inputRule] });
  const source = highlightSourceInputRules.plugin();
  for (const atom of [
    schema.nodes.unknown_atom.create({ payload: 'must survive' }),
    schema.nodes.math_inline.create({ value: '`' }),
  ]) {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('`before '),
        atom,
        schema.text(' '),
        schema.text('y', [schema.marks.highlight.create()]),
      ]),
    ]);
    const run = (plugins: (typeof upstream)[]) => {
      let state = EditorState.create({
        doc,
        plugins,
        selection: TextSelection.create(doc, doc.content.size - 1),
      });
      const view = {
        get state() {
          return state;
        },
        composing: false,
        dispatch(tr: Transaction) {
          state = state.apply(tr);
        },
      } as EditorView;
      const end = state.selection.from;
      const handled = plugins.some((plugin) =>
        plugin.props.handleTextInput?.call(plugin, view, end, end, '`', () => state.tr),
      );
      return { handled, doc: state.doc };
    };
    // Positive control: the actual upstream rule accepts this mixed document and consumes its atom.
    const unsafe = run([upstream]);
    expect(unsafe.handled).toBe(true);
    expect(unsafe.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['inlineCode']);
    const safe = run([source, upstream]);
    expect(safe.handled).toBe(true);
    expect(safe.doc.firstChild!.child(1).eq(atom)).toBe(true);
    expect(safe.doc.textContent).toBe('`before  y`');
    expect(safe.doc.firstChild!.child(3).marks.map((mark) => mark.type.name)).toEqual(['highlight']);
  }
});
